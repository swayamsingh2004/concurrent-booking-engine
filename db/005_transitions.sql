-- Booking lifecycle state machine, enforced by the database itself.
--
-- A trigger runs on EVERY update to bookings, from any source: this API, psql, a cron
-- job, a future service, a colleague at 2am. There is no code path that skips it.
--
-- Legal transitions:
--     pending   -> confirmed | cancelled | expired
--     confirmed -> cancelled
--     cancelled -> (nothing, terminal)
--     expired   -> (nothing, terminal)
--
-- confirmed -> expired is deliberately ILLEGAL: the TTL job only reclaims unconfirmed
-- holds, so a bug in that job can never silently destroy a booking someone paid for.

CREATE OR REPLACE FUNCTION enforce_status_transition() RETURNS trigger AS $$
BEGIN
  -- Only inspect transitions when status actually changes. Without this guard, an update
  -- that only bumps `version` would be checked against status -> same status and rejected.
  -- IS DISTINCT FROM is the null-safe form of <>.
  IF NEW.status IS DISTINCT FROM OLD.status THEN

    -- Expressed as "list the legal moves; if this is not one of them, reject".
    -- Inverted deliberately: it says RAISE once instead of once per branch, and it
    -- FAILS CLOSED -- add a new status later and forget this trigger, and transitions
    -- involving it are refused rather than silently allowed.
    IF NOT (
         (OLD.status = 'pending'   AND NEW.status IN ('confirmed', 'cancelled', 'expired'))
      OR (OLD.status = 'confirmed' AND NEW.status = 'cancelled')
    ) THEN
      -- Aborts the statement and rolls back the transaction.
      -- Reaches node-postgres as err.code = 'P0001' (plpgsql raise_exception).
      -- If more triggers are added later, give each its own SQLSTATE via
      --   RAISE EXCEPTION '...' USING ERRCODE = '...'
      -- so the API can tell them apart.
      RAISE EXCEPTION 'illegal transition: % -> %', OLD.status, NEW.status;
    END IF;

  END IF;

  -- MANDATORY. In a BEFORE trigger, whatever you return becomes the row.
  -- RETURN NEW  -> the update proceeds.
  -- RETURN NULL -> Postgres SILENTLY cancels the write. No error, no row changed.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_status_transition
  BEFORE UPDATE ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION enforce_status_transition();
