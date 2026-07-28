ALTER TABLE scm_smart_item_yard_policies
  ADD COLUMN IF NOT EXISTS lower_stock_policy_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN scm_smart_item_yard_policies.lower_stock_policy_enabled IS
  'Enables the optional lower-stock policy for this item at this yard.';
