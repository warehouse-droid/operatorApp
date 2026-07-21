ALTER TABLE scm_smart_settings
  ADD COLUMN IF NOT EXISTS zero_demand_coverage_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS zero_demand_pickup_order_count integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS zero_demand_delivery_order_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS coverage_order_percentile numeric NOT NULL DEFAULT 0.50,
  ADD COLUMN IF NOT EXISTS coverage_history_weeks integer NOT NULL DEFAULT 104,
  ADD COLUMN IF NOT EXISTS coverage_prior_strength_orders integer NOT NULL DEFAULT 8;

ALTER TABLE scm_smart_settings
  DROP CONSTRAINT IF EXISTS scm_smart_settings_zero_demand_order_counts,
  ADD CONSTRAINT scm_smart_settings_zero_demand_order_counts CHECK (
    zero_demand_pickup_order_count BETWEEN 1 AND 50
    AND zero_demand_delivery_order_count BETWEEN 1 AND 50
  ),
  DROP CONSTRAINT IF EXISTS scm_smart_settings_coverage_percentile,
  ADD CONSTRAINT scm_smart_settings_coverage_percentile CHECK (
    coverage_order_percentile BETWEEN 0.25 AND 0.75
  ),
  DROP CONSTRAINT IF EXISTS scm_smart_settings_coverage_history,
  ADD CONSTRAINT scm_smart_settings_coverage_history CHECK (
    coverage_history_weeks BETWEEN 26 AND 260
    AND coverage_prior_strength_orders BETWEEN 1 AND 100
  );

ALTER TABLE scm_smart_forecasts
  ADD COLUMN IF NOT EXISTS representative_order_pallets numeric,
  ADD COLUMN IF NOT EXISTS coverage_order_count integer,
  ADD COLUMN IF NOT EXISTS coverage_floor_pallets numeric,
  ADD COLUMN IF NOT EXISTS coverage_source text,
  ADD COLUMN IF NOT EXISTS coverage_local_samples integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coverage_donor_samples integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS zero_demand_coverage_applied boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS coverage_capacity_shortfall boolean NOT NULL DEFAULT false;

ALTER TABLE scm_smart_forecast_runs
  ALTER COLUMN model_version SET DEFAULT 'formula-zero-demand-coverage-v4';

COMMENT ON COLUMN scm_smart_settings.zero_demand_coverage_enabled IS
  'When enabled, a configurable order-count ROP floor applies only to formula forecasts with zero recent demand.';
COMMENT ON COLUMN scm_smart_settings.zero_demand_pickup_order_count IS
  'Target number of representative pickup orders protected at yards 3445, 2967, and 150.';
COMMENT ON COLUMN scm_smart_settings.zero_demand_delivery_order_count IS
  'Target number of representative delivery orders protected at yard 12441.';
COMMENT ON COLUMN scm_smart_settings.coverage_order_percentile IS
  'Document-level order-size percentile used for zero-demand coverage; 0.50 is the median.';
COMMENT ON COLUMN scm_smart_settings.coverage_history_weeks IS
  'Completed weeks used for local and 3445 donor order-size evidence.';
COMMENT ON COLUMN scm_smart_settings.coverage_prior_strength_orders IS
  'Order sample strength used to blend sparse local/item evidence with series and channel priors.';
