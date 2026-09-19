-- Prevent double-booking at the storage-engine level.
-- Neither the app, nor psql, nor a cron job, nor a colleague's script can bypass this.

-- btree_gist teaches GiST indexes how to compare scalars (uuid) for equality,
-- so `resource_id WITH =` and `slot WITH &&` can live in one index.
-- Per-database, so it belongs here rather than being typed by hand once.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Derived column: the booking window as one half-open range value.
-- tstzrange (NOT tsrange) because start_at/end_at are timestamptz.
-- GENERATED ALWAYS means Postgres maintains it on every write; it cannot drift.
ALTER TABLE bookings
  ADD COLUMN slot TSTZRANGE
  GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED;

-- Two rows conflict when they are for the SAME resource AND their slots OVERLAP.
-- Partial (WHERE): cancelled and expired bookings release their claim on the room.
-- This status list MUST stay in sync with db/queries/find_conflicts.sql.
ALTER TABLE bookings
  ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (resource_id WITH =, slot WITH &&)
  WHERE (status IN ('pending', 'confirmed'));
