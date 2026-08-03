CREATE TABLE IF NOT EXISTS scm_smart_inventory_sync_runs (
  id bigserial PRIMARY KEY,
  status text NOT NULL DEFAULT 'running',
  trigger_source text NOT NULL DEFAULT 'manual',
  full_catalog boolean NOT NULL DEFAULT false,
  requested_item_count integer NOT NULL DEFAULT 0,
  item_count integer NOT NULL DEFAULT 0,
  balance_count integer NOT NULL DEFAULT 0,
  observed_at timestamptz,
  error text,
  created_by text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT scm_smart_inventory_sync_runs_status CHECK (
    status IN ('running', 'completed', 'failed')
  )
);

CREATE TABLE IF NOT EXISTS scm_smart_inventory_snapshots (
  run_id bigint NOT NULL REFERENCES scm_smart_inventory_sync_runs(id) ON DELETE CASCADE,
  item_id bigint NOT NULL,
  location_id bigint NOT NULL,
  yard_code text NOT NULL,
  quantity_on_hand numeric NOT NULL DEFAULT 0,
  quantity_available numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, item_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_scm_smart_inventory_snapshots_history
  ON scm_smart_inventory_snapshots (item_id, location_id, run_id DESC);

CREATE INDEX IF NOT EXISTS idx_scm_smart_inventory_sync_runs_completed
  ON scm_smart_inventory_sync_runs (observed_at DESC, id DESC)
  WHERE status = 'completed';

ALTER TABLE scm_smart_forecasts
  ADD COLUMN IF NOT EXISTS stockout_demand_method text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS stockout_demand_confidence text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS stockout_snapshot_weeks integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stockout_proxy_weeks integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stockout_evidence_start_week date,
  ADD COLUMN IF NOT EXISTS stockout_evidence_end_week date,
  ADD COLUMN IF NOT EXISTS demand_data_cutoff date;

ALTER TABLE scm_smart_forecasts
  DROP CONSTRAINT IF EXISTS scm_smart_forecasts_stockout_demand_method,
  ADD CONSTRAINT scm_smart_forecasts_stockout_demand_method CHECK (
    stockout_demand_method IN ('snapshot', 'mixed', 'positive_sales_proxy', 'none')
  ),
  DROP CONSTRAINT IF EXISTS scm_smart_forecasts_stockout_demand_confidence,
  ADD CONSTRAINT scm_smart_forecasts_stockout_demand_confidence CHECK (
    stockout_demand_confidence IN ('high', 'low', 'none')
  );

ALTER TABLE scm_smart_forecast_runs
  ALTER COLUMN model_version SET DEFAULT 'formula-stockout-in-stock-average-v5';

COMMENT ON TABLE scm_smart_inventory_sync_runs IS
  'One explicit complete Smart SCM inventory refresh attempt. Only completed runs are forecast evidence.';
COMMENT ON TABLE scm_smart_inventory_snapshots IS
  'Immutable item-yard balances captured by a complete Smart SCM inventory refresh; generic partial inventory upserts never write here.';
COMMENT ON COLUMN scm_smart_inventory_sync_runs.observed_at IS
  'Time the complete NetSuite inventory result was observed, used to derive America/Toronto observation days.';
COMMENT ON COLUMN scm_smart_settings.stockout_benchmark_weeks IS
  'Latest eligible in-stock sales weeks averaged when current availability is under one pallet.';
COMMENT ON COLUMN scm_smart_forecasts.formula_weekly_demand IS
  'Authoritative formula demand: completed-week average normally, in-stock/proxy eligible-week average when currently under one pallet.';
COMMENT ON COLUMN scm_smart_forecasts.stockout_demand_method IS
  'Stockout evidence source: snapshot, mixed, positive_sales_proxy, or none.';
COMMENT ON COLUMN scm_smart_forecasts.stockout_demand_confidence IS
  'Low when stockout evidence uses any proxy or fewer than three snapshot-backed weeks; otherwise high.';
COMMENT ON COLUMN scm_smart_forecasts.demand_data_cutoff IS
  'Last transaction date in the active Smart SCM sales source used to establish the latest completed forecast week.';
