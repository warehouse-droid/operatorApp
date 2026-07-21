ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS vendor_id bigint,
  ADD COLUMN IF NOT EXISTS vendor text,
  ADD COLUMN IF NOT EXISTS netsuite_lead_time_days numeric,
  ADD COLUMN IF NOT EXISTS netsuite_safety_stock_level numeric,
  ADD COLUMN IF NOT EXISTS netsuite_seasonal_demand boolean;

ALTER TABLE scm_smart_item_policies
  ADD COLUMN IF NOT EXISTS planning_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS vendor_yard_id bigint,
  ADD COLUMN IF NOT EXISTS vendor_yard text,
  ADD COLUMN IF NOT EXISTS updated_by text;

UPDATE scm_smart_item_policies
   SET vendor_yard = COALESCE(NULLIF(vendor_yard, ''), NULLIF(plant, '')),
       source_input_file_id = NULL
 WHERE vendor_yard IS NULL
    OR source_input_file_id IS NOT NULL;

UPDATE scm_smart_item_yard_policies
   SET source_input_file_id = NULL
 WHERE source_input_file_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scm_smart_item_policies_enabled
  ON scm_smart_item_policies (planning_enabled, inactive, discontinued, item_id);

CREATE TABLE IF NOT EXISTS scm_smart_sync_state (
  id smallint PRIMARY KEY DEFAULT 1,
  inventory_status text NOT NULL DEFAULT 'never',
  inventory_started_at timestamptz,
  inventory_synced_at timestamptz,
  inventory_item_count integer NOT NULL DEFAULT 0,
  inventory_balance_count integer NOT NULL DEFAULT 0,
  inventory_error text,
  sales_status text NOT NULL DEFAULT 'never',
  sales_started_at timestamptz,
  sales_synced_at timestamptz,
  sales_coverage_start date,
  sales_synced_through date,
  sales_fact_count bigint NOT NULL DEFAULT 0,
  sales_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_smart_sync_state_singleton CHECK (id = 1),
  CONSTRAINT scm_smart_sync_inventory_status CHECK (inventory_status IN ('never', 'running', 'ready', 'failed')),
  CONSTRAINT scm_smart_sync_sales_status CHECK (sales_status IN ('never', 'running', 'ready', 'failed'))
);

INSERT INTO scm_smart_sync_state (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE scm_smart_forecast_runs
  ALTER COLUMN model_version SET DEFAULT 'seasonal-hybrid-statistical-v2';

COMMENT ON TABLE scm_smart_sync_state IS
  'NetSuite inventory and sales-history freshness gate used by Smart SCM planning.';

COMMENT ON COLUMN scm_smart_item_policies.vendor_yard IS
  'Operator-selected vendor pickup yard; canonical item/vendor/conversion fields remain NetSuite-owned.';
