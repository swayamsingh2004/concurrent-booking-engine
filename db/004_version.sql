-- Optimistic locking support.
--
-- Every state-changing write bumps `version`. A writer reads the version, does its work,
-- then writes "...only if the version is still what I read". If someone else got there
-- first, the UPDATE matches zero rows and the writer knows it lost.
--
-- Contrast with pessimistic locking (SELECT ... FOR UPDATE): nobody waits here. The bet
-- is that conflicts are rare, so it's cheaper to occasionally redo work than to make
-- every writer queue.

ALTER TABLE bookings
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
