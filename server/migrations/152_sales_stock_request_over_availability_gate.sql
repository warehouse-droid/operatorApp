-- Sales may ask SCM to review demand above the selected yard's current
-- availability. The gate is deliberately off by default and never weakens
-- SCM conversion or Transfer Order inventory enforcement.

INSERT INTO mbt_feature_flags (flag_key, enabled, description)
VALUES (
  'sales_stock_request_over_availability',
  false,
  'Allow Sales to submit stock requests above the selected source yard availability; SCM conversion and Transfer Order controls remain availability-enforced'
)
ON CONFLICT (flag_key) DO NOTHING;
