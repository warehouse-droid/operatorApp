INSERT INTO mbt_feature_flags (flag_key, enabled, description)
VALUES (
  'operator_customer_pickup_photo_required',
  true,
  'Require at least one Operator photo before completing Customer Pickup loading.'
)
ON CONFLICT (flag_key) DO NOTHING;
