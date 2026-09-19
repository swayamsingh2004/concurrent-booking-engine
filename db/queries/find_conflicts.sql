-- Does a proposed booking conflict with an existing one?
-- Returns one row per conflicting booking; zero rows means the slot is free.
--
-- Placeholders (hardcoded for now, parameterised once TypeScript arrives):
--   :resource_id  the room being booked
--   :new_start    proposed start
--   :new_end      proposed end

SELECT id, start_at, end_at, status
FROM bookings
WHERE resource_id = :resource_id            -- 1. same room
  AND status IN ('pending', 'confirmed')    -- 2. only live bookings block
  AND start_at < :new_end                   -- 3. overlap test, half 1
  AND end_at   > :new_start;                --    overlap test, half 2
