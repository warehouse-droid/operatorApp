BEGIN;

-- Device occurrence time is evidence and may legitimately be slightly ahead
-- of the database clock.  The application boundary already rejects more than
-- five minutes of forward skew; retain the real receipt timestamp instead of
-- rewriting either clock to satisfy an overly strict ordering constraint.
ALTER TABLE mbt_driver_bin_event_applications
  DROP CONSTRAINT IF EXISTS mbt_driver_bin_application_times;

ALTER TABLE mbt_driver_bin_event_applications
  ADD CONSTRAINT mbt_driver_bin_application_times
  CHECK (
    device_occurred_at <= server_received_at + interval '5 minutes'
    AND server_applied_at >= server_received_at
  );

COMMENT ON CONSTRAINT mbt_driver_bin_application_times
  ON mbt_driver_bin_event_applications IS
  'Preserves device, receipt, and application clocks independently while bounding forward device skew to five minutes.';

COMMIT;
