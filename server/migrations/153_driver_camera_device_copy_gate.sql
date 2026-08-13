-- Driver camera originals may be copied to a user-approved device folder (or
-- requested as a browser download when directory access is unavailable). The
-- behavior is deliberately opt-in and never changes the operational evidence
-- upload, compression, completion, or offline-retention pipeline.

INSERT INTO mbt_feature_flags (flag_key, enabled, description)
VALUES (
  'driver_camera_device_copy',
  false,
  'Allow Driver PWA camera captures to request an additional original-file copy on the Driver device; operational evidence upload remains unchanged'
)
ON CONFLICT (flag_key) DO NOTHING;
