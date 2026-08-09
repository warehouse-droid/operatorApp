-- Driver testing may soften only ordinary yard-replenishment dependencies.
-- Dispatch planning and direct-linked/same-truck Transfer Orders remain hard.

INSERT INTO mbt_feature_flags (flag_key, enabled, description)
VALUES (
  'driver_yard_dependency_soft_mode',
  false,
  'Allow Driver PWA execution to warn instead of block on ordinary yard-replenishment dependencies; Dispatch and direct-linked dependencies remain hard'
)
ON CONFLICT (flag_key) DO NOTHING;
