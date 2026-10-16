-- Diagnostic delivery retries must not duplicate an operational audit record.
CREATE UNIQUE INDEX IF NOT EXISTS driver_upload_failure_audit_identity
  ON delivery_audit_log (
    (details->>'driverLogin'),
    (details->>'deviceId'),
    (details->>'failureId')
  )
  WHERE action = 'driver.photo_upload.failed';
