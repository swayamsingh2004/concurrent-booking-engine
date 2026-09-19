import pg from "pg";

const { Pool } = pg;

// A connection pool, not a single connection. Every concurrent request borrows a client
// and returns it. `max` is the ceiling on simultaneous Postgres connections.
//
// This number matters for the load test: firing 500 concurrent requests at a 20-connection
// pool means 480 of them are queued in Node before Postgres ever sees them. That queueing
// is part of what you will measure — it is not a bug, but you must know it is there when
// you read the latency numbers.
export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://booking:booking@localhost:5432/booking",
  max: Number(process.env.PG_POOL_MAX ?? 20),
});

// Postgres error codes worth naming instead of scattering magic strings.
// Full list: https://www.postgresql.org/docs/current/errcodes-appendix.html
export const PG_EXCLUSION_VIOLATION = "23P01"; // no_double_booking fired
export const PG_UNIQUE_VIOLATION = "23505"; // duplicate key
export const PG_CHECK_VIOLATION = "23514"; // valid_status, ends_after_starts
export const PG_FOREIGN_KEY_VIOLATION = "23503"; // resource_id points at nothing
export const PG_NOT_NULL_VIOLATION = "23502"; // required column was null
export const PG_INVALID_TEXT_REPRESENTATION = "22P02"; // e.g. "abc" sent as a uuid
export const PG_DATA_EXCEPTION = "22000"; // e.g. tstzrange(late, early)
export const PG_DEADLOCK_DETECTED = "40P01"; // transient -- RETRY, do not surface as 500
export const PG_RAISE_EXCEPTION = "P0001"; // any plpgsql RAISE EXCEPTION -- our state machine trigger
