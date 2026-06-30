WITH ranked_plans AS (
  SELECT
    id,
    plan_date,
    FIRST_VALUE(id) OVER (
      PARTITION BY plan_date
      ORDER BY updated_at DESC, id DESC
    ) AS keep_id
  FROM dispatch_plans
)
UPDATE dispatch_audit_log log
   SET plan_id = ranked.keep_id
  FROM ranked_plans ranked
 WHERE log.plan_id = ranked.id
   AND ranked.id <> ranked.keep_id;

WITH ranked_plans AS (
  SELECT
    id,
    FIRST_VALUE(id) OVER (
      PARTITION BY plan_date
      ORDER BY updated_at DESC, id DESC
    ) AS keep_id
  FROM dispatch_plans
)
DELETE FROM dispatch_plans plan
 USING ranked_plans ranked
 WHERE plan.id = ranked.id
   AND ranked.id <> ranked.keep_id;

DROP INDEX IF EXISTS idx_dispatch_plans_date_status_version;
DROP INDEX IF EXISTS idx_dispatch_plans_date;

ALTER TABLE dispatch_plans
  DROP COLUMN IF EXISTS version,
  DROP COLUMN IF EXISTS revised_from_plan_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_plans_plan_date
  ON dispatch_plans (plan_date);

CREATE INDEX IF NOT EXISTS idx_dispatch_plans_date_updated
  ON dispatch_plans (plan_date DESC, updated_at DESC);
