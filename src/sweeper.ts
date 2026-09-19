import type { FastifyBaseLogger } from "fastify";
import { pool } from "./db.js";

/**
 * Background sweeps.
 *
 *   1. Expire pending bookings older than PENDING_TTL. Pending bookings block their slot
 *      (see the exclusion constraint's WHERE clause), so an abandoned checkout squats a
 *      room forever without this.
 *   2. Delete idempotency keys older than KEY_TTL. Retries happen within seconds; anything
 *      older is dead weight.
 *
 * Why a background job and not Redis TTL + keyspace notifications:
 * Redis publishes an expiry event exactly once and never replays it. If the listener is
 * restarting, deploying, or briefly disconnected, that event is lost and the booking never
 * expires -- precisely the bug this is meant to fix. You would need a reconciliation sweep
 * as a backstop, which is this job. Redis would add infrastructure without removing work.
 * (Redis expiry is also not precise: keys are sampled ~20 at a time, 10x/sec, so a key can
 * outlive its TTL under load.) Redis would win if there were millions of deadlines or a
 * need for sub-second precision. Neither is true here -- expiring 30s late is fine.
 */

// Any constant, as long as every instance uses the same one and nothing else in the app
// claims it. Advisory locks lock NOTHING by themselves -- Postgres just tracks who holds
// the number. The meaning is our convention, hence "advisory".
const SWEEP_LOCK_ID = 42;

const PENDING_TTL = process.env.PENDING_TTL ?? "10 minutes";
const KEY_TTL = process.env.IDEMPOTENCY_KEY_TTL ?? "24 hours";
const BATCH = Number(process.env.SWEEP_BATCH ?? 500);
const INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS ?? 30_000);

// Safety cap so one tick cannot loop forever against a huge backlog.
const MAX_BATCHES_PER_TICK = 20;

// FOR UPDATE SKIP LOCKED: a user may be confirming one of these rows right now and holding
// its lock. Without SKIP LOCKED the sweep would WAIT for them. With it, the sweep takes
// what is free; the skipped row is caught next tick, or the user confirms it -- which is
// the correct outcome either way.
//
// LIMIT keeps each transaction short. An unbounded UPDATE over hundreds of thousands of
// rows would hold locks on all of them at once and block every concurrent confirm.
const EXPIRE_BOOKINGS = `
  WITH doomed AS (
    SELECT id FROM bookings
     WHERE status = 'pending'
       AND created_at < now() - $1::interval
     ORDER BY created_at
     LIMIT $2
     FOR UPDATE SKIP LOCKED
  )
  UPDATE bookings b
     SET status = 'expired', version = b.version + 1
    FROM doomed d
   WHERE b.id = d.id`;

const DELETE_STALE_KEYS = `
  WITH doomed AS (
    SELECT key FROM idempotency_keys
     WHERE created_at < now() - $1::interval
     ORDER BY created_at
     LIMIT $2
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM idempotency_keys k
   USING doomed d
   WHERE k.key = d.key`;

/**
 * One batch, in its own transaction.
 *
 * Deliberately one transaction PER BATCH rather than one for the whole sweep:
 *   - locks are released between batches, so concurrent confirms are not starved
 *   - now() is re-evaluated each batch. It is frozen for a transaction's lifetime, so a
 *     single long transaction would miss bookings that expire while it runs.
 *   - the advisory lock is re-acquired each batch, so a dying instance frees it promptly
 *
 * Returns the rows affected, or null if another instance holds the sweep lock.
 */
async function runBatch(sql: string, ttl: string): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // `try`  -> non-blocking; returns false rather than queueing. A sweeper that waited
    //           would just pile ticks up behind each other.
    // `xact` -> released automatically when this transaction ends, so it cannot leak if
    //           the process dies mid-sweep.
    const { rows } = await client.query<{ got: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1) AS got",
      [SWEEP_LOCK_ID],
    );

    if (!rows[0]?.got) {
      await client.query("ROLLBACK");
      return null;
    }

    const res = await client.query(sql, [ttl, BATCH]);
    await client.query("COMMIT");
    return res.rowCount ?? 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    // Must run on every path. An unreleased connection is gone from the pool permanently.
    client.release();
  }
}

async function sweep(sql: string, ttl: string, label: string, log: FastifyBaseLogger) {
  let total = 0;

  for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
    const affected = await runBatch(sql, ttl);

    if (affected === null) {
      log.debug({ label }, "another instance holds the sweep lock, skipping this tick");
      return;
    }

    total += affected;
    // A short batch means we have drained the backlog.
    if (affected < BATCH) break;
  }

  if (total > 0) log.info({ label, count: total }, "swept");
}

// Guards against overlapping ticks within THIS process: if a sweep somehow outlasts the
// interval, the next timer fire is skipped rather than running concurrently with it.
let running = false;

async function tick(log: FastifyBaseLogger) {
  if (running) {
    log.warn("previous sweep still running, skipping this tick");
    return;
  }
  running = true;
  try {
    await sweep(EXPIRE_BOOKINGS, PENDING_TTL, "expired_bookings", log);
    await sweep(DELETE_STALE_KEYS, KEY_TTL, "deleted_idempotency_keys", log);
  } catch (err) {
    // Never let a failed sweep kill the timer. The next tick retries; the work is
    // idempotent, so a missed run simply means a slightly larger batch next time.
    log.error({ err }, "sweep failed");
  } finally {
    running = false;
  }
}

/** Starts the sweep timer. Returns a function that stops it. */
export function startSweeper(log: FastifyBaseLogger): () => void {
  // Set RUN_SWEEPER=false during load testing so sweep activity does not pollute the
  // latency numbers, or when running a dedicated worker process instead.
  if (process.env.RUN_SWEEPER === "false") {
    log.info("sweeper disabled (RUN_SWEEPER=false)");
    return () => {};
  }

  log.info(
    { intervalMs: INTERVAL_MS, pendingTtl: PENDING_TTL, keyTtl: KEY_TTL, batch: BATCH },
    "sweeper started",
  );

  const timer = setInterval(() => void tick(log), INTERVAL_MS);
  // Do not keep the process alive purely for this timer.
  timer.unref();

  return () => clearInterval(timer);
}

/** Exposed so tests and demos can force a sweep without waiting for the timer. */
export async function sweepNow(log: FastifyBaseLogger) {
  await tick(log);
}
