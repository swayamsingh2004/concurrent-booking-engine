-- Confirm a pending booking, optimistically.
--
-- Placeholders:
--   <BOOKING_ID>  the booking to confirm
--   <VERSION>     the version the caller read a moment ago
--
-- THE CALLER MUST INSPECT THE AFFECTED ROW COUNT. It is the entire signal:
--   1 row  -> we won; the booking is now confirmed
--   0 rows -> we did nothing. Either someone else changed it first, or it was
--             not confirmable. Do NOT proceed as if it succeeded.
--   (node-postgres: result.rowCount)
--
-- Two guards doing two DIFFERENT jobs -- neither replaces the other:
--   version = <VERSION>   nobody has modified this row since I read it   (concurrency)
--   status  = 'pending'   this booking is legally confirmable            (state machine)

UPDATE bookings
   SET status  = 'confirmed',
       version = version + 1
 WHERE id      = '<BOOKING_ID>'
   AND version = <VERSION>
   AND status  = 'pending';
