-- Recovery is a separate immutable event; a retried log delivery is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS driver_upload_recovery_audit_identity
  ON delivery_audit_log ((details->>'driverLogin'), (details->>'deviceId'), (details->>'failureId'))
  WHERE action = 'driver.photo_upload.recovered';
