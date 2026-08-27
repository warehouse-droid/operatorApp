BEGIN;

-- Transfer Orders can settle after the first webhook payload just like Sales
-- and Purchase Orders. Keep the same durable, fenced outbox contract.
ALTER TABLE netsuite_delayed_status_refresh_jobs
  DROP CONSTRAINT IF EXISTS netsuite_delayed_status_refresh_jobs_order_type_check,
  ADD CONSTRAINT netsuite_delayed_status_refresh_jobs_order_type_check
    CHECK (order_type IN ('sales_order', 'purchase_order', 'transfer_order'));

-- A retained Dispatch VRMA deliberately uses PO route semantics in the plan,
-- but completion identity is authoritative from its source table. The local
-- VRMA table therefore wins over stale PWA job_details and RP-* cannot rely on
-- a reference prefix heuristic.
CREATE OR REPLACE FUNCTION dispatch_completion_driver_order_kind(
  raw_ref text,
  details jsonb
) RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
        FROM scm_vrma_orders vrma
       WHERE lower(btrim(vrma.vrma_ref)) = lower(btrim(raw_ref))
    ) THEN 'VRMA'
    ELSE COALESCE(
      (
        SELECT dispatch_completion_normalize_order_kind(
                 retained.value->>'orderType',
                 raw_ref
               )
          FROM jsonb_array_elements(
                 CASE
                   WHEN jsonb_typeof(COALESCE(details, '{}'::jsonb)->'orders') = 'array'
                     THEN COALESCE(details, '{}'::jsonb)->'orders'
                   ELSE '[]'::jsonb
                 END
               ) retained(value)
         WHERE lower(btrim(retained.value->>'orderRef')) = lower(btrim(raw_ref))
           AND dispatch_completion_normalize_order_kind(
                 retained.value->>'orderType',
                 raw_ref
               ) IS NOT NULL
         LIMIT 1
      ),
      CASE
        WHEN jsonb_typeof(COALESCE(details, '{}'::jsonb)->'orderTypes') = 'array'
         AND jsonb_array_length(COALESCE(details, '{}'::jsonb)->'orderTypes') = 1
        THEN dispatch_completion_normalize_order_kind(
               COALESCE(details, '{}'::jsonb)->'orderTypes'->>0,
               raw_ref
             )
        ELSE NULL
      END,
      dispatch_completion_normalize_order_kind(NULL, raw_ref)
    )
  END
$$;

-- Preserve the historical-assist attribution introduced in migration 174
-- while routing every new completion through the authoritative resolver.
CREATE OR REPLACE FUNCTION dispatch_project_driver_job_completion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  retained_ref text;
  retained_kind text;
  retained_actor_type text := 'driver';
  retained_actor_id text := NEW.driver_login;
  retained_reason text := '';
  retained_metadata jsonb;
BEGIN
  IF lower(btrim(COALESCE(NEW.status, ''))) <> 'complete'
     OR lower(btrim(COALESCE(NEW.stop_type, ''))) <> 'dropoff'
     OR NEW.completed_at IS NULL
     OR jsonb_typeof(COALESCE(NEW.order_refs, '[]'::jsonb)) <> 'array' THEN
    RETURN NEW;
  END IF;

  IF NEW.job_details->>'completionSource' = 'dispatch_historical_assist'
     AND NEW.job_details->>'completionActorType' = 'operator'
     AND NULLIF(btrim(COALESCE(NEW.job_details->>'completionActorId', '')), '') IS NOT NULL
     AND NULLIF(btrim(COALESCE(NEW.job_details->>'completionReason', '')), '') IS NOT NULL THEN
    retained_actor_type := 'operator';
    retained_actor_id := btrim(NEW.job_details->>'completionActorId');
    retained_reason := btrim(NEW.job_details->>'completionReason');
  END IF;

  FOR retained_ref IN
    SELECT DISTINCT btrim(reference.value)
      FROM jsonb_array_elements_text(COALESCE(NEW.order_refs, '[]'::jsonb)) reference(value)
     WHERE NULLIF(btrim(reference.value), '') IS NOT NULL
  LOOP
    retained_kind := dispatch_completion_driver_order_kind(retained_ref, NEW.job_details);
    IF retained_kind IS NULL THEN
      CONTINUE;
    END IF;
    retained_metadata := jsonb_build_object(
      'driverJobRecordId', NEW.id,
      'stopId', COALESCE(NEW.stop_id, ''),
      'stopType', NEW.stop_type,
      'truckPlate', COALESCE(NEW.truck_plate, ''),
      'loadName', COALESCE(NEW.load_name, '')
    );
    IF retained_actor_type = 'operator' THEN
      retained_metadata := retained_metadata || jsonb_build_object(
        'assisted', true,
        'completionSource', 'dispatch_historical_assist',
        'completionActorName', COALESCE(NEW.job_details->>'completionActorName', ''),
        'completionRequestId', COALESCE(NEW.job_details->>'completionRequestId', ''),
        'completionAssistEventId', COALESCE(NEW.job_details->>'completionAssistEventId', '')
      );
    END IF;
    PERFORM dispatch_record_order_completion(
      retained_kind,
      retained_ref,
      NEW.completed_at,
      'driver_job',
      NEW.job_id,
      NEW.plan_id,
      NEW.plan_date,
      NEW.load_id,
      retained_actor_type,
      retained_actor_id,
      retained_reason,
      retained_metadata
    );
  END LOOP;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_driver_job_dispatch_completion ON driver_job_records;
CREATE TRIGGER trg_driver_job_dispatch_completion
  AFTER INSERT OR UPDATE ON driver_job_records
  FOR EACH ROW EXECUTE FUNCTION dispatch_project_driver_job_completion();

-- Append the missing canonical evidence. The legacy PO event is immutable and
-- remains in the ledger; replay safety comes from the existing evidence key.
INSERT INTO dispatch_order_completion_events (
  order_kind, order_ref, dispatch_completed_at,
  completion_evidence_type, completion_evidence_id,
  plan_id, plan_date, load_id,
  actor_type, actor_id, reason, metadata
)
SELECT 'VRMA', vrma.vrma_ref, record.completed_at,
       'driver_job', record.job_id,
       record.plan_id, record.plan_date, NULLIF(btrim(record.load_id), ''),
       CASE
         WHEN record.job_details->>'completionSource' = 'dispatch_historical_assist'
          AND record.job_details->>'completionActorType' = 'operator'
          AND NULLIF(btrim(COALESCE(record.job_details->>'completionActorId', '')), '') IS NOT NULL
          AND NULLIF(btrim(COALESCE(record.job_details->>'completionReason', '')), '') IS NOT NULL
         THEN 'operator'
         ELSE 'driver'
       END,
       CASE
         WHEN record.job_details->>'completionSource' = 'dispatch_historical_assist'
          AND record.job_details->>'completionActorType' = 'operator'
          AND NULLIF(btrim(COALESCE(record.job_details->>'completionActorId', '')), '') IS NOT NULL
         THEN btrim(record.job_details->>'completionActorId')
         ELSE record.driver_login
       END,
       CASE
         WHEN record.job_details->>'completionSource' = 'dispatch_historical_assist'
          AND record.job_details->>'completionActorType' = 'operator'
         THEN btrim(COALESCE(record.job_details->>'completionReason', ''))
         ELSE ''
       END,
       jsonb_build_object(
         'driverJobRecordId', record.id,
         'stopId', COALESCE(record.stop_id, ''),
         'stopType', record.stop_type,
         'truckPlate', COALESCE(record.truck_plate, ''),
         'loadName', COALESCE(record.load_name, ''),
         'authoritativeKindRepair', true
       )
  FROM driver_job_records record
 CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(record.order_refs, '[]'::jsonb)) reference(value)
  JOIN scm_vrma_orders vrma
    ON lower(btrim(vrma.vrma_ref)) = lower(btrim(reference.value))
 WHERE lower(btrim(record.status)) = 'complete'
   AND lower(btrim(record.stop_type)) = 'dropoff'
   AND record.completed_at IS NOT NULL
ON CONFLICT DO NOTHING;

-- The corrected event supersedes only its exact legacy twin. It does not hide
-- an unrelated PO that happens to have a similar reference.
CREATE OR REPLACE VIEW dispatch_order_completion_status AS
WITH ranked AS (
  SELECT event.*,
         row_number() OVER (
           PARTITION BY event.order_kind, lower(btrim(event.order_ref))
           ORDER BY
             CASE event.completion_evidence_type
               WHEN 'driver_job' THEN 10
               WHEN 'direct_dependency' THEN 20
               WHEN 'manual_dispatch' THEN 30
               WHEN 'reconciliation' THEN 40
               WHEN 'vrma_completion' THEN 40
               WHEN 'custom_order' THEN 40
               WHEN 'netsuite_fulfillment' THEN 50
               ELSE 100
             END,
             event.dispatch_completed_at DESC,
             event.id DESC
         ) AS completion_rank
    FROM dispatch_order_completion_events event
   WHERE NOT (
     event.order_kind = 'PO'
     AND EXISTS (
       SELECT 1
         FROM dispatch_order_completion_events corrected
        WHERE corrected.order_kind = 'VRMA'
          AND lower(btrim(corrected.order_ref)) = lower(btrim(event.order_ref))
          AND corrected.completion_evidence_type = event.completion_evidence_type
          AND corrected.completion_evidence_id = event.completion_evidence_id
     )
   )
)
SELECT id AS completion_event_id,
       order_kind,
       order_ref,
       dispatch_completion_status,
       dispatch_completed_at,
       completion_evidence_type,
       completion_evidence_id,
       plan_id,
       plan_date,
       load_id,
       actor_type,
       actor_id,
       reason,
       metadata,
       created_at
  FROM ranked
 WHERE completion_rank = 1;

CREATE INDEX IF NOT EXISTS idx_scm_reconciliation_runs_status_refresh_recent
  ON scm_reconciliation_runs (
    target_order_kind,
    created_at DESC
  )
  WHERE scope_kind = 'order_family';

COMMENT ON VIEW dispatch_order_completion_status IS
  'Canonical universal Dispatch completion projection; corrected VRMA evidence supersedes only an exact legacy PO driver-event twin.';

COMMIT;
