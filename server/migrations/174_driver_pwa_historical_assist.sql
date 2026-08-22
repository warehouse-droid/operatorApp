-- Dispatcher-assisted completion of past Driver PWA physical visits.
-- Evidence remains a normal driver_job completion; this ledger adds immutable
-- operator attribution and request idempotency without changing Driver caches.

CREATE TABLE IF NOT EXISTS driver_job_assist_events (
  id bigserial PRIMARY KEY,
  assist_event_id uuid NOT NULL UNIQUE,
  request_id uuid NOT NULL UNIQUE,
  actor_operator_id text NOT NULL,
  actor_name text NOT NULL,
  driver_login text NOT NULL,
  plan_id bigint NOT NULL REFERENCES dispatch_plans(id) ON DELETE RESTRICT,
  plan_date date NOT NULL,
  plan_revision bigint NOT NULL,
  primary_job_id text NOT NULL,
  physical_visit_job_ids jsonb NOT NULL,
  stop_type text NOT NULL,
  arrived_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  photo_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text NOT NULL,
  outcome text NOT NULL DEFAULT 'completed',
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_job_assist_actor_not_blank
    CHECK (NULLIF(btrim(actor_operator_id), '') IS NOT NULL AND NULLIF(btrim(actor_name), '') IS NOT NULL),
  CONSTRAINT driver_job_assist_driver_not_blank
    CHECK (NULLIF(btrim(driver_login), '') IS NOT NULL),
  CONSTRAINT driver_job_assist_revision_nonnegative CHECK (plan_revision >= 0),
  CONSTRAINT driver_job_assist_primary_not_blank
    CHECK (NULLIF(btrim(primary_job_id), '') IS NOT NULL),
  CONSTRAINT driver_job_assist_physical_jobs_array
    CHECK (jsonb_typeof(physical_visit_job_ids) = 'array' AND jsonb_array_length(physical_visit_job_ids) > 0),
  CONSTRAINT driver_job_assist_stop_type CHECK (stop_type IN ('pickup', 'dropoff')),
  CONSTRAINT driver_job_assist_chronology CHECK (completed_at >= arrived_at + interval '10 seconds'),
  CONSTRAINT driver_job_assist_photos_array CHECK (jsonb_typeof(photo_references) = 'array'),
  CONSTRAINT driver_job_assist_reason_not_blank CHECK (NULLIF(btrim(reason), '') IS NOT NULL),
  CONSTRAINT driver_job_assist_outcome CHECK (outcome = 'completed'),
  CONSTRAINT driver_job_assist_result_object CHECK (jsonb_typeof(result) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_driver_job_assist_driver_day
  ON driver_job_assist_events (lower(driver_login), plan_date, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_job_assist_plan
  ON driver_job_assist_events (plan_id, plan_revision, created_at DESC);

DROP TRIGGER IF EXISTS trg_driver_job_assist_events_immutable ON driver_job_assist_events;
CREATE TRIGGER trg_driver_job_assist_events_immutable
  BEFORE UPDATE OR DELETE ON driver_job_assist_events
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

COMMENT ON TABLE driver_job_assist_events IS
  'Append-only ledger for a dispatcher completing one past Driver physical visit with normal Driver operational effects.';

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
