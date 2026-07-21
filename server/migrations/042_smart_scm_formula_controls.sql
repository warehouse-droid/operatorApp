ALTER TABLE scm_smart_settings
  ADD COLUMN IF NOT EXISTS formula_average_weeks integer NOT NULL DEFAULT 6,
  ADD COLUMN IF NOT EXISTS stockout_benchmark_weeks integer NOT NULL DEFAULT 6,
  ADD COLUMN IF NOT EXISTS delivery_safety_factor numeric NOT NULL DEFAULT 1.645,
  ADD COLUMN IF NOT EXISTS pickup_safety_factor numeric NOT NULL DEFAULT 1.3;

ALTER TABLE scm_smart_forecasts
  ADD COLUMN IF NOT EXISTS formula_weekly_demand numeric,
  ADD COLUMN IF NOT EXISTS formula_weekly_sd numeric,
  ADD COLUMN IF NOT EXISTS formula_stockout boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS formula_window_weeks integer,
  ADD COLUMN IF NOT EXISTS current_available_pallets numeric;

ALTER TABLE scm_smart_forecast_runs
  ALTER COLUMN model_version SET DEFAULT 'formula-stockout-statistical-v3';

WITH candidates AS (
  SELECT p.item_id,
         vy.id AS vendor_yard_id,
         row_number() OVER (
           PARTITION BY p.item_id
           ORDER BY CASE
             WHEN lower(vy.yard) = lower(p.vendor_yard) THEN 0
             WHEN strpos(lower(vy.yard), lower(p.vendor_yard)) > 0 THEN 1
             ELSE 2
           END,
           vy.id
         ) AS match_rank
    FROM scm_smart_item_policies p
    JOIN dispatch_vendor_yards vy
      ON vy.active = true
     AND lower(regexp_replace(COALESCE(vy.vendor, ''), '[^a-z0-9]+', '', 'g')) =
         lower(regexp_replace(COALESCE(p.vendor, ''), '[^a-z0-9]+', '', 'g'))
     AND (
       lower(vy.yard) = lower(p.vendor_yard)
       OR strpos(lower(vy.yard), lower(p.vendor_yard)) > 0
       OR strpos(lower(COALESCE(vy.address, '')), lower(p.vendor_yard)) > 0
     )
   WHERE p.vendor_yard_id IS NULL
     AND NULLIF(btrim(p.vendor_yard), '') IS NOT NULL
     AND lower(btrim(p.vendor_yard)) <> '#n/a'
), matches AS (
  SELECT item_id, vendor_yard_id
    FROM candidates
   WHERE match_rank = 1
)
UPDATE scm_smart_item_policies p
   SET vendor_yard_id = matches.vendor_yard_id,
       updated_at = now()
  FROM matches
 WHERE p.item_id = matches.item_id
   AND p.vendor_yard_id IS NULL;

UPDATE scm_smart_proposals
   SET status = 'superseded',
       superseded_at = COALESCE(superseded_at, now()),
       updated_at = now()
 WHERE proposal_type = 'TO'
   AND phase = 'hub_store'
   AND provisional = true
   AND netsuite_transfer_order_id IS NULL
   AND netsuite_transfer_order_ref IS NULL
   AND status IN ('draft', 'held', 'reviewed', 'attention');

COMMENT ON COLUMN scm_smart_settings.formula_average_weeks IS
  'Completed sales weeks used by the normal formula average and standard deviation.';
COMMENT ON COLUMN scm_smart_settings.stockout_benchmark_weeks IS
  'Completed sales weeks used for the maximum-demand benchmark when current availability is under one pallet.';
COMMENT ON COLUMN scm_smart_settings.delivery_safety_factor IS
  'Adjustable safety-stock factor for the 12441 delivery yard.';
COMMENT ON COLUMN scm_smart_settings.pickup_safety_factor IS
  'Adjustable safety-stock factor for pickup yards 3445, 2967, and 150.';
COMMENT ON COLUMN scm_smart_forecasts.formula_weekly_demand IS
  'Authoritative formula demand: recent average normally, recent maximum when currently under one pallet.';
