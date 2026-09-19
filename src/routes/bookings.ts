import type { FastifyInstance, FastifyReply } from "fastify";
import {
  pool,
  PG_EXCLUSION_VIOLATION,
  PG_CHECK_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PG_NOT_NULL_VIOLATION,
  PG_INVALID_TEXT_REPRESENTATION,
  PG_DATA_EXCEPTION,
  PG_RAISE_EXCEPTION,
  PG_UNIQUE_VIOLATION,
  PG_DEADLOCK_DETECTED,
} from "../db.js";
import { hashRequestBody } from "../idempotency.js";

// Shape of the JSON body. Fastify uses this to type req.body -- Express has no equivalent;
// there req.body is `any` unless you type it by hand.
type CreateBookingBody = {
  resource_id: string;
  user_id: string;
  start_at: string;
  end_at: string;
};

// The public shape of a booking. Defined once so every route returns the same fields and
// they cannot drift apart. Deliberately excludes `slot` -- that is internal machinery for
// the exclusion constraint, not something an API consumer should see or depend on.
const BOOKING_FIELDS = "id, resource_id, user_id, start_at, end_at, status, version, created_at";

// Defined once so the plain path and the idempotent path cannot drift apart.
const INSERT_BOOKING = `INSERT INTO bookings (resource_id, user_id, start_at, end_at)
                        VALUES ($1, $2, $3, $4)
                        RETURNING ${BOOKING_FIELDS}`;

// Postgres error code -> HTTP response.
//
// A constraint violation is the client's fault, not the server's: the request asked for
// something the rules forbid. Returning 500 for these would tell clients "retry, my server
// broke" when the truth is "this request will never succeed as written" -- and it would
// bury real outages in a pile of user typos during the load test.
const PG_ERROR_MAP: Record<string, { status: number; error: string }> = {
  [PG_EXCLUSION_VIOLATION]: { status: 409, error: "slot already booked" },
  [PG_CHECK_VIOLATION]: { status: 400, error: "invalid booking window" },
  [PG_DATA_EXCEPTION]: { status: 400, error: "invalid booking window" },
  [PG_FOREIGN_KEY_VIOLATION]: { status: 404, error: "resource not found" },
  [PG_NOT_NULL_VIOLATION]: { status: 400, error: "missing required field" },
  [PG_INVALID_TEXT_REPRESENTATION]: { status: 400, error: "malformed field value" },
  // The state-machine trigger fired. Under normal operation the WHERE clause below catches
  // an illegal transition first, so seeing this means something bypassed that guard --
  // worth a distinct status code so it shows up separately in logs and metrics.
  [PG_RAISE_EXCEPTION]: { status: 422, error: "illegal state transition" },
};

/**
 * Retry a database operation when Postgres reports a deadlock.
 *
 * Exclusion constraints deadlock under heavy contention on the SAME key, and it is not a
 * bug in the schema -- it is how they are implemented. Postgres inserts the index tuple
 * speculatively, then scans for conflicts, then waits on any uncommitted conflicting
 * transaction. Two inserts racing for one slot can each end up waiting on the other:
 *
 *   T1: writes its tuple, scans, sees T2's, waits for T2
 *   T2: writes its tuple, scans, sees T1's, waits for T1     -> cycle
 *
 * Measured on a 500-request burst at one slot: 213 of 500 deadlocked and surfaced as 500s.
 *
 * 40P01 is transient by definition -- Postgres documents that clients should retry. By the
 * time we retry, the winner has committed, so the retry gets a clean 23P01 and returns 409.
 * Jittered backoff so the retries do not re-collide in lockstep.
 */
async function withDeadlockRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== PG_DEADLOCK_DETECTED || i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 25 * (i + 1)));
    }
  }
}

// Shared error handling. Translates only codes we have explicitly reasoned about;
// anything else is rethrown so it surfaces as a real, logged 500.
function handlePgError(reply: FastifyReply, err: unknown): FastifyReply {
  const code = (err as { code?: string }).code;
  const mapped = code ? PG_ERROR_MAP[code] : undefined;
  if (mapped) return reply.code(mapped.status).send({ error: mapped.error });
  throw err;
}

/**
 * Move a booking to a new status, but only from a state the state machine allows.
 *
 * The `AND status = ANY($3)` guard is what makes this safe under concurrency: the check
 * and the write are ONE statement, so two simultaneous requests cannot both see 'pending'
 * and both act on it. Exactly one UPDATE matches a row; the other matches zero.
 *
 * The trigger in db/005_transitions.sql is the backstop. This guard is what turns an
 * illegal request into a clean 409 instead of a raised exception.
 */
async function applyTransition(
  reply: FastifyReply,
  id: string,
  to: "confirmed" | "cancelled",
  legalFrom: readonly string[],
): Promise<FastifyReply> {
  try {
    const { rows } = await pool.query(
      `UPDATE bookings
          SET status  = $2,
              version = version + 1
        WHERE id = $1
          AND status = ANY($3)
        RETURNING ${BOOKING_FIELDS}`,
      [id, to, legalFrom],
    );

    const updated = rows[0];
    if (updated) return reply.code(200).send(updated);

    // Zero rows. Two very different reasons, and the caller deserves to know which:
    // the booking does not exist (404), or it exists in a state this move is not legal
    // from (409). rowCount alone cannot distinguish them, so ask.
    //
    // This second query is NOT part of the correctness guarantee -- the UPDATE above
    // already decided the outcome. It only picks a better error message, so the tiny
    // race here (the row could change again in between) is harmless: worst case we
    // report a slightly stale status in an error the client was getting anyway.
    const { rows: existing } = await pool.query(`SELECT status FROM bookings WHERE id = $1`, [id]);

    const current = existing[0];
    if (!current) return reply.code(404).send({ error: "booking not found" });

    const verb = to === "confirmed" ? "confirm" : "cancel";
    return reply.code(409).send({
      error: `cannot ${verb} a booking that is ${current.status}`,
      status: current.status,
    });
  } catch (err) {
    return handlePgError(reply, err);
  }
}

export async function bookingRoutes(app: FastifyInstance) {
  // GET /bookings/:id
  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const { rows } = await pool.query(`SELECT ${BOOKING_FIELDS} FROM bookings WHERE id = $1`, [
      req.params.id,
    ]);

    const booking = rows[0];
    if (!booking) return reply.code(404).send({ error: "booking not found" });
    return booking;
  });

  // POST /bookings -- create a pending booking.
  //
  // No pre-flight SELECT for conflicts. The exclusion constraint is the guarantee, so the
  // correct code is SHORTER than the racy version: insert, and let the database refuse.
  //
  // Optionally idempotent. Send an `Idempotency-Key` header and a retry carrying the same
  // key returns the ORIGINAL response instead of doing the work again. Without the header
  // the endpoint behaves exactly as before -- idempotency is opt-in, as it is at Stripe,
  // so existing clients are unaffected.
  app.post<{ Body: CreateBookingBody; Headers: { "idempotency-key"?: string } }>(
    "/",
    async (req, reply) => {
      const { resource_id, user_id, start_at, end_at } = req.body;
      const bookingArgs = [resource_id, user_id, start_at, end_at];
      const key = req.headers["idempotency-key"];

      // Validate the key here rather than leaning on the CHECK constraint. Two different
      // CHECK constraints (key length, and ends_after_starts) both raise 23514, so
      // PG_ERROR_MAP cannot tell them apart -- a short key would be reported as
      // "invalid booking window". Error-code mapping stops working as soon as two
      // constraints share a code, so anything the handler can check itself, it should.
      if (key !== undefined && (key.length < 8 || key.length > 255)) {
        return reply.code(400).send({ error: "Idempotency-Key must be 8-255 characters" });
      }

      // --- no key: plain path, single statement, no transaction needed ------------------
      if (!key) {
        try {
          // Pre-flight conflict check. NOT the correctness guarantee -- it is racy by
          // construction (TOCTOU), and the exclusion constraint below is what actually
          // prevents double booking.
          //
          // It is here for THROUGHPUT. Measured on a 500-request burst at one slot:
          // without it, every request enters the contended INSERT path, 500 transactions
          // form a deep wait chain, cycles appear, and Postgres spends a full
          // deadlock_timeout (1s) on each before killing one. With it, once the winner has
          // committed every later request is rejected by a cheap GiST index probe and
          // never contends at all.
          //
          // Written as `slot && tstzrange(...)` rather than two timestamp comparisons so it
          // uses the no_double_booking GiST index directly.
          const { rows: conflict } = await pool.query(
            `SELECT 1 FROM bookings
              WHERE resource_id = $1
                AND status IN ('pending','confirmed')
                AND slot && tstzrange($2::timestamptz, $3::timestamptz, '[)')
              LIMIT 1`,
            [resource_id, start_at, end_at],
          );
          if (conflict.length > 0) {
            return reply.code(409).send({ error: "slot already booked" });
          }

          const { rows } = await withDeadlockRetry(() => pool.query(INSERT_BOOKING, bookingArgs));
          return reply.code(201).send(rows[0]);
        } catch (err) {
          return handlePgError(reply, err);
        }
      }

      // --- with a key: claim, work, and record the response in ONE transaction ----------
      //
      // pool.connect() rather than pool.query(): a transaction must run on ONE connection.
      // pool.query() may hand out a different connection per call, so BEGIN and COMMIT
      // would land on unrelated sessions and the transaction would silently do nothing.
      const hash = hashRequestBody(req.body);
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        try {
          // Claim the key FIRST, before any work. This is the whole trick: the check and
          // the claim are one atomic INSERT, so two requests cannot both decide they are
          // the first. Not check-then-act.
          await client.query(
            `INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2)`,
            [key, hash],
          );
        } catch (err) {
          if ((err as { code?: string }).code !== PG_UNIQUE_VIOLATION) throw err;

          // Someone already owns this key. Note what just happened: if the original was
          // still in flight, our INSERT BLOCKED on its uncommitted row rather than failing
          // immediately -- the same mechanism as the exclusion constraint. So by the time
          // we get here the original has finished and its response is committed.
          //
          // The failed INSERT aborted our transaction, so roll back before reading.
          await client.query("ROLLBACK");

          const { rows } = await client.query(
            `SELECT request_hash, status_code, response_body
               FROM idempotency_keys WHERE key = $1`,
            [key],
          );
          const prior = rows[0];

          if (!prior) {
            // The row vanished between our INSERT failing and this SELECT -- the original
            // transaction rolled back, or the 24h sweep removed it. Nothing stored to
            // return, so tell the client to try again rather than guessing.
            return reply.code(409).send({ error: "key contended, retry" });
          }
          if (prior.request_hash !== hash) {
            return reply
              .code(422)
              .send({ error: "idempotency key was used with a different request" });
          }
          if (prior.status_code === null) {
            // Should be unreachable given we block above, but a claimed-yet-unfinished key
            // is a real state and guessing at it would be worse than saying so.
            return reply.code(409).send({ error: "request in progress" });
          }

          // The genuine retry. Return the ORIGINAL status and body, byte for byte.
          return reply.code(prior.status_code).send(prior.response_body);
        }

        // We own the key. Do the work on the SAME connection, inside the same transaction.
        const { rows } = await client.query(INSERT_BOOKING, bookingArgs);
        const booking = rows[0];

        await client.query(
          `UPDATE idempotency_keys SET status_code = $2, response_body = $3 WHERE key = $1`,
          [key, 201, booking],
        );

        await client.query("COMMIT");
        return reply.code(201).send(booking);
      } catch (err) {
        // Any failure rolls back EVERYTHING, the key row included, so a retry starts clean
        // and is free to try again.
        //
        // We can afford not to record failures because the work here is purely a database
        // write with no external side effects: a retry that re-runs it is harmless, and a
        // deterministic failure (slot taken) simply fails again. If this endpoint charged
        // a card, that would no longer hold -- you would wrap the work in a SAVEPOINT so
        // the failure response could be recorded without losing the key.
        await client.query("ROLLBACK").catch(() => {});
        return handlePgError(reply, err);
      } finally {
        // MUST run, on every path. A connection that is never released is gone from the
        // pool forever; leak 20 and the service stops answering.
        client.release();
      }
    },
  );

  // POST /bookings/:id/confirm -- pending -> confirmed.
  //
  // Confirming an already-confirmed booking is a 409, not a silent 200. The caller asked
  // for a transition that did not happen, and pretending otherwise would hide a genuine
  // double-submit. Safe retries are the job of idempotency keys, not of quietly accepting
  // repeat requests here.
  app.post<{ Params: { id: string } }>("/:id/confirm", async (req, reply) =>
    applyTransition(reply, req.params.id, "confirmed", ["pending"]),
  );

  // POST /bookings/:id/cancel -- pending or confirmed -> cancelled.
  //
  // Legal from two states: you can abandon a hold, and you can cancel a real booking.
  app.post<{ Params: { id: string } }>("/:id/cancel", async (req, reply) =>
    applyTransition(reply, req.params.id, "cancelled", ["pending", "confirmed"]),
  );
}
