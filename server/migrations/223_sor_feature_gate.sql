INSERT INTO mbt_feature_flags (flag_key, enabled, description)
VALUES ('sor_rental_workflow', false,
  'SOR dispatch planning, automatic equipment returns and optional Driver customer signatures.')
ON CONFLICT (flag_key) DO NOTHING;
