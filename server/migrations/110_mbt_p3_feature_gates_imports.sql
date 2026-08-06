-- Phase 3 capability gates. This packet intentionally adds only closed feature
-- flags; imports and operational behavior remain unavailable until later
-- packet-specific migrations and services are applied.

SET LOCAL lock_timeout = '3s';

INSERT INTO mbt_feature_flags (
  flag_key,
  enabled,
  description
)
VALUES
  (
    'mbt_asset_management',
    false,
    'MBT asset registration, movement, reservation, correction, and reconciliation commands'
  ),
  (
    'mbt_customer_sync',
    false,
    'MBT customer synchronization, import, conflict, and compatibility-projection commands'
  ),
  (
    'mbt_master_data',
    false,
    'MBT local item, material, dump site, service template, shared master, and rate configuration commands'
  )
ON CONFLICT (flag_key) DO NOTHING;
