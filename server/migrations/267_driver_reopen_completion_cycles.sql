-- An audited Driver PWA reopen supersedes its completion projection while
-- preserving every original completion event and photo. Each subsequent
-- completion has its own idempotent cycle, including grouped physical visits.
ALTER TABLE dispatch_order_completion_events
  ADD COLUMN IF NOT EXISTS reopen_correction_id bigint
  REFERENCES driver_job_corrections(id) ON DELETE RESTRICT;

DROP INDEX IF EXISTS idx_dispatch_order_completion_evidence_unique;
CREATE UNIQUE INDEX idx_dispatch_order_completion_evidence_unique
  ON dispatch_order_completion_events (
    order_kind, lower(btrim(order_ref)), completion_evidence_type,
    completion_evidence_id, COALESCE(reopen_correction_id, 0)
  );

CREATE INDEX IF NOT EXISTS idx_driver_job_corrections_reopen_job
  ON driver_job_corrections(job_id, id DESC) WHERE action = 'reopen';
CREATE INDEX IF NOT EXISTS idx_driver_job_corrections_reopen_visit
  ON driver_job_corrections USING gin ((result->'physicalVisitJobIds'))
  WHERE action = 'reopen';

CREATE OR REPLACE FUNCTION dispatch_record_order_completion(
  raw_order_kind text,
  raw_order_ref text,
  raw_completed_at timestamptz,
  raw_evidence_type text,
  raw_evidence_id text,
  raw_plan_id bigint DEFAULT NULL,
  raw_plan_date date DEFAULT NULL,
  raw_load_id text DEFAULT NULL,
  raw_actor_type text DEFAULT 'system',
  raw_actor_id text DEFAULT '',
  raw_reason text DEFAULT '',
  raw_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  normalized_kind text;
  retained_id bigint;
  reopen_id bigint;
  reopened_at timestamptz;
BEGIN
  normalized_kind := dispatch_completion_normalize_order_kind(raw_order_kind, raw_order_ref);
  IF normalized_kind IS NULL THEN
    RAISE EXCEPTION 'Unsupported Dispatch completion order kind: %', raw_order_kind
      USING ERRCODE = '22023';
  END IF;
  IF NULLIF(btrim(COALESCE(raw_order_ref, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Dispatch completion order reference is required.'
      USING ERRCODE = '22023';
  END IF;
  IF raw_completed_at IS NULL THEN
    RAISE EXCEPTION 'Dispatch completion timestamp is required.'
      USING ERRCODE = '22023';
  END IF;
  IF NULLIF(btrim(COALESCE(raw_evidence_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Dispatch completion evidence ID is required.'
      USING ERRCODE = '22023';
  END IF;

  IF btrim(raw_evidence_type) = 'driver_job' THEN
    SELECT correction.id, correction.created_at INTO reopen_id, reopened_at
      FROM driver_job_corrections correction
     WHERE correction.action = 'reopen'
       AND (correction.job_id = btrim(raw_evidence_id)
         OR correction.result->'physicalVisitJobIds' ? btrim(raw_evidence_id))
     ORDER BY correction.id DESC LIMIT 1;
    IF reopened_at IS NOT NULL AND raw_completed_at <= reopened_at THEN
      -- A delayed/offline replay belongs to the superseded visit. Return its
      -- retained evidence when present; never create another active completion.
      SELECT event.id INTO retained_id
        FROM dispatch_order_completion_events event
       WHERE event.order_kind = normalized_kind
         AND lower(btrim(event.order_ref)) = lower(btrim(raw_order_ref))
         AND event.completion_evidence_type = 'driver_job'
         AND event.completion_evidence_id = btrim(raw_evidence_id)
         AND event.dispatch_completed_at = raw_completed_at
       ORDER BY event.id DESC LIMIT 1;
      RETURN retained_id;
    END IF;
  END IF;

  INSERT INTO dispatch_order_completion_events (
    order_kind, order_ref, dispatch_completed_at,
    completion_evidence_type, completion_evidence_id,
    plan_id, plan_date, load_id,
    actor_type, actor_id, reason, metadata, reopen_correction_id
  ) VALUES (
    normalized_kind, btrim(raw_order_ref), raw_completed_at,
    btrim(raw_evidence_type), btrim(raw_evidence_id),
    raw_plan_id, raw_plan_date, NULLIF(btrim(COALESCE(raw_load_id, '')), ''),
    btrim(COALESCE(raw_actor_type, 'system')),
    btrim(COALESCE(raw_actor_id, '')),
    btrim(COALESCE(raw_reason, '')),
    COALESCE(raw_metadata, '{}'::jsonb), reopen_id
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO retained_id;

  IF retained_id IS NULL THEN
    SELECT event.id INTO retained_id
      FROM dispatch_order_completion_events event
     WHERE event.order_kind = normalized_kind
       AND lower(btrim(event.order_ref)) = lower(btrim(raw_order_ref))
       AND event.completion_evidence_type = btrim(raw_evidence_type)
       AND event.completion_evidence_id = btrim(raw_evidence_id)
       AND event.reopen_correction_id IS NOT DISTINCT FROM reopen_id
     LIMIT 1;
  END IF;
  RETURN retained_id;
END
$$;

CREATE OR REPLACE VIEW dispatch_effective_order_completion_events AS
SELECT event.* FROM dispatch_order_completion_events event
WHERE NOT EXISTS (
  SELECT 1 FROM dispatch_driver_co_identity_corrections correction
  WHERE event.completion_evidence_type = 'driver_job'
    AND event.completion_evidence_id = correction.job_id
    AND lower(btrim(event.order_ref)) = ANY(dispatch_co_identity_ref_set(correction.original_order_refs))
)
  AND NOT EXISTS (
    SELECT 1 FROM dispatch_direct_ship_completion_corrections correction
    WHERE correction.completion_event_id = event.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM driver_job_corrections correction
    WHERE event.completion_evidence_type = 'driver_job'
      AND correction.action = 'reopen'
      AND correction.id > COALESCE(event.reopen_correction_id, 0)
      AND (correction.job_id = event.completion_evidence_id
        OR correction.result->'physicalVisitJobIds' ? event.completion_evidence_id)
  );

-- The previous unique evidence key also discarded a recapture that happened
-- before this upgrade. Recover that current completed cycle from its retained
-- Driver record, preserving the linked-transport and operator-assist guards.
SELECT dispatch_record_order_completion(
  identity.kind, reference.ref, job.completed_at, 'driver_job', job.job_id,
  job.plan_id, job.plan_date, job.load_id,
  CASE WHEN assist.allowed THEN 'operator' ELSE 'driver' END,
  CASE WHEN assist.allowed THEN btrim(job.job_details->>'completionActorId') ELSE job.driver_login END,
  CASE WHEN assist.allowed THEN btrim(job.job_details->>'completionReason') ELSE '' END,
  jsonb_build_object(
    'driverJobRecordId', job.id, 'stopId', COALESCE(job.stop_id, ''),
    'stopType', job.stop_type, 'truckPlate', COALESCE(job.truck_plate, ''),
    'loadName', COALESCE(job.load_name, '')
  ) || CASE WHEN assist.allowed THEN jsonb_build_object(
    'assisted', true, 'completionSource', 'dispatch_historical_assist',
    'completionActorName', COALESCE(job.job_details->>'completionActorName', ''),
    'completionRequestId', COALESCE(job.job_details->>'completionRequestId', ''),
    'completionAssistEventId', COALESCE(job.job_details->>'completionAssistEventId', '')
  ) ELSE '{}'::jsonb END
)
FROM driver_job_records job
JOIN LATERAL (
  SELECT correction.created_at FROM driver_job_corrections correction
  WHERE correction.action = 'reopen'
    AND (correction.job_id = job.job_id OR correction.result->'physicalVisitJobIds' ? job.job_id)
  ORDER BY correction.id DESC LIMIT 1
) reopen ON job.completed_at > reopen.created_at
CROSS JOIN LATERAL (
  SELECT DISTINCT btrim(value) AS ref FROM jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(job.order_refs) = 'array' THEN job.order_refs ELSE '[]'::jsonb END
  )
  WHERE NULLIF(btrim(value), '') IS NOT NULL
) reference
CROSS JOIN LATERAL (
  SELECT dispatch_completion_driver_order_kind(reference.ref, job.job_details) AS kind
) identity
CROSS JOIN LATERAL (
  SELECT COALESCE(job.job_details->>'completionSource' = 'dispatch_historical_assist'
    AND job.job_details->>'completionActorType' = 'operator'
    AND NULLIF(btrim(job.job_details->>'completionActorId'), '') IS NOT NULL
    AND NULLIF(btrim(job.job_details->>'completionReason'), '') IS NOT NULL, false) AS allowed
) assist
WHERE job.status = 'complete' AND job.stop_type = 'dropoff'
  AND job.completed_at IS NOT NULL AND identity.kind IS NOT NULL
  AND dispatch_linked_transport_delivery_ready(identity.kind, reference.ref);

-- Existing audited reopens need the same exact-reference refresh as new ones.
SELECT pg_advisory_xact_lock(hashtext('dispatch-order-catalog-refresh'));
INSERT INTO dispatch_order_catalog_refresh_outbox (
  refresh_key, order_ref, order_type, source, status, available_at
)
SELECT DISTINCT ON (event.order_kind, lower(btrim(event.order_ref)))
  'order:' || event.order_kind || ':' || lower(btrim(event.order_ref)),
  event.order_ref, event.order_kind, 'driver-pwa-reopen-upgrade', 'pending', now()
FROM dispatch_order_completion_events event
WHERE event.completion_evidence_type = 'driver_job'
  AND EXISTS (
    SELECT 1 FROM driver_job_corrections correction
    WHERE correction.action = 'reopen'
      AND correction.id > COALESCE(event.reopen_correction_id, 0)
      AND (correction.job_id = event.completion_evidence_id
        OR correction.result->'physicalVisitJobIds' ? event.completion_evidence_id)
  )
ORDER BY event.order_kind, lower(btrim(event.order_ref)), event.id DESC
ON CONFLICT (refresh_key) DO UPDATE SET source = EXCLUDED.source,
  status = 'pending', available_at = now(), completed_at = NULL,
  last_error = '', updated_at = now();
