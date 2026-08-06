-- Driver local-first operation is an explicit Admin choice. New and upgraded
-- deployments default to the online-only workflow; existing browser evidence
-- is retained and may still use the recovery synchronization endpoint.

INSERT INTO mbt_feature_flags (flag_key, enabled, description)
VALUES (
  'driver_offline_mode',
  false,
  'Allow the Driver PWA to save routes, actions, and photo evidence for offline use'
)
ON CONFLICT (flag_key) DO NOTHING;
