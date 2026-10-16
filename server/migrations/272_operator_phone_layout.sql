INSERT INTO mbt_feature_flags (flag_key, enabled, description)
VALUES (
  'operator_phone_layout',
  false,
  'Enable the Operator phone version while retaining the existing tablet interface.'
)
ON CONFLICT (flag_key) DO NOTHING;
