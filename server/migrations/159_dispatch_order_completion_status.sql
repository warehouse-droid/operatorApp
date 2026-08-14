BEGIN;

-- Dispatch completion is the single admission contract consumed by billing.
-- Source systems retain their own operational statuses; every accepted
-- completion appends immutable evidence here instead of overloading those
-- source fields.
CREATE TABLE IF NOT EXISTS dispatch_order_completion_events (
  id bigserial PRIMARY KEY,
  order_kind text NOT NULL,
  order_ref text NOT NULL,
  dispatch_completion_status text NOT NULL DEFAULT 'completed',
  dispatch_completed_at timestamptz NOT NULL,
  completion_evidence_type text NOT NULL,
  completion_evidence_id text NOT NULL,
  plan_id bigint,
  plan_date date,
  load_id text,
  actor_type text NOT NULL DEFAULT 'system',
  actor_id text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_order_completion_kind_valid
    CHECK (order_kind IN ('SO', 'TO', 'PO', 'VRMA', 'CUSTOM')),
  CONSTRAINT dispatch_order_completion_ref_not_blank
    CHECK (NULLIF(btrim(order_ref), '') IS NOT NULL),
  CONSTRAINT dispatch_order_completion_status_valid
    CHECK (dispatch_completion_status = 'completed'),
  CONSTRAINT dispatch_order_completion_evidence_type_valid
    CHECK (completion_evidence_type IN (
      'driver_job', 'direct_dependency', 'manual_dispatch',
      'reconciliation', 'netsuite_fulfillment', 'vrma_completion',
      'custom_order'
    )),
  CONSTRAINT dispatch_order_completion_evidence_id_not_blank
    CHECK (NULLIF(btrim(completion_evidence_id), '') IS NOT NULL),
  CONSTRAINT dispatch_order_completion_actor_type_valid
    CHECK (actor_type IN ('driver', 'operator', 'system')),
  CONSTRAINT dispatch_order_completion_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT dispatch_order_completion_manual_audit
    CHECK (
      completion_evidence_type <> 'manual_dispatch'
      OR (
        actor_type = 'operator'
        AND NULLIF(btrim(actor_id), '') IS NOT NULL
        AND NULLIF(btrim(reason), '') IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_order_completion_evidence_unique
  ON dispatch_order_completion_events (
    order_kind,
    lower(btrim(order_ref)),
    completion_evidence_type,
    completion_evidence_id
  );

CREATE INDEX IF NOT EXISTS idx_dispatch_order_completion_completed_at
  ON dispatch_order_completion_events (dispatch_completed_at DESC, order_kind, lower(btrim(order_ref)));

CREATE INDEX IF NOT EXISTS idx_dispatch_order_completion_plan_load
  ON dispatch_order_completion_events (plan_date, plan_id, load_id)
  WHERE plan_id IS NOT NULL OR NULLIF(btrim(load_id), '') IS NOT NULL;

DROP TRIGGER IF EXISTS trg_dispatch_order_completion_events_immutable
  ON dispatch_order_completion_events;
CREATE TRIGGER trg_dispatch_order_completion_events_immutable
  BEFORE UPDATE OR DELETE ON dispatch_order_completion_events
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

CREATE OR REPLACE FUNCTION dispatch_completion_normalize_order_kind(
  raw_kind text,
  raw_ref text
) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN upper(regexp_replace(btrim(COALESCE(raw_kind, '')), '[^A-Za-z]+', '_', 'g'))
      IN ('SO', 'SALES_ORDER', 'SALESORDER') THEN 'SO'
    WHEN upper(regexp_replace(btrim(COALESCE(raw_kind, '')), '[^A-Za-z]+', '_', 'g'))
      IN ('TO', 'TRANSFER_ORDER', 'TRANSFERORDER') THEN 'TO'
    WHEN upper(regexp_replace(btrim(COALESCE(raw_kind, '')), '[^A-Za-z]+', '_', 'g'))
      IN ('PO', 'PURCHASE_ORDER', 'PURCHASEORDER') THEN 'PO'
    WHEN upper(regexp_replace(btrim(COALESCE(raw_kind, '')), '[^A-Za-z]+', '_', 'g'))
      IN ('VRMA', 'VENDOR_RETURN_AUTHORIZATION', 'VENDOR_RETURN') THEN 'VRMA'
    WHEN upper(regexp_replace(btrim(COALESCE(raw_kind, '')), '[^A-Za-z]+', '_', 'g'))
      IN ('CUSTOM', 'CUSTOM_ORDER') THEN 'CUSTOM'
    WHEN upper(btrim(COALESCE(raw_ref, ''))) LIKE 'VRMA%' THEN 'VRMA'
    WHEN upper(btrim(COALESCE(raw_ref, ''))) LIKE 'SO%' THEN 'SO'
    WHEN upper(btrim(COALESCE(raw_ref, ''))) LIKE 'TO%' THEN 'TO'
    WHEN upper(btrim(COALESCE(raw_ref, ''))) LIKE 'PO%' THEN 'PO'
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION dispatch_completion_driver_order_kind(
  raw_ref text,
  details jsonb
) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
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
$$;

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

  INSERT INTO dispatch_order_completion_events (
    order_kind, order_ref, dispatch_completed_at,
    completion_evidence_type, completion_evidence_id,
    plan_id, plan_date, load_id,
    actor_type, actor_id, reason, metadata
  ) VALUES (
    normalized_kind, btrim(raw_order_ref), raw_completed_at,
    btrim(raw_evidence_type), btrim(raw_evidence_id),
    raw_plan_id, raw_plan_date, NULLIF(btrim(COALESCE(raw_load_id, '')), ''),
    btrim(COALESCE(raw_actor_type, 'system')),
    btrim(COALESCE(raw_actor_id, '')),
    btrim(COALESCE(raw_reason, '')),
    COALESCE(raw_metadata, '{}'::jsonb)
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO retained_id;

  IF retained_id IS NULL THEN
    SELECT event.id
      INTO retained_id
      FROM dispatch_order_completion_events event
     WHERE event.order_kind = normalized_kind
       AND lower(btrim(event.order_ref)) = lower(btrim(raw_order_ref))
       AND event.completion_evidence_type = btrim(raw_evidence_type)
       AND event.completion_evidence_id = btrim(raw_evidence_id)
     LIMIT 1;
  END IF;
  RETURN retained_id;
END
$$;

CREATE OR REPLACE FUNCTION dispatch_project_driver_job_completion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  retained_ref text;
  retained_kind text;
BEGIN
  IF lower(btrim(COALESCE(NEW.status, ''))) <> 'complete'
     OR lower(btrim(COALESCE(NEW.stop_type, ''))) <> 'dropoff'
     OR NEW.completed_at IS NULL
     OR jsonb_typeof(COALESCE(NEW.order_refs, '[]'::jsonb)) <> 'array' THEN
    RETURN NEW;
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
    PERFORM dispatch_record_order_completion(
      retained_kind,
      retained_ref,
      NEW.completed_at,
      'driver_job',
      NEW.job_id,
      NEW.plan_id,
      NEW.plan_date,
      NEW.load_id,
      'driver',
      NEW.driver_login,
      '',
      jsonb_build_object(
        'driverJobRecordId', NEW.id,
        'stopId', COALESCE(NEW.stop_id, ''),
        'stopType', NEW.stop_type,
        'truckPlate', COALESCE(NEW.truck_plate, ''),
        'loadName', COALESCE(NEW.load_name, '')
      )
    );
  END LOOP;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_driver_job_dispatch_completion ON driver_job_records;
CREATE TRIGGER trg_driver_job_dispatch_completion
  AFTER INSERT OR UPDATE ON driver_job_records
  FOR EACH ROW EXECUTE FUNCTION dispatch_project_driver_job_completion();

CREATE OR REPLACE FUNCTION dispatch_project_direct_dependency_completion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.dependency_mode = 'direct_to_customer'
     AND NEW.status = 'received_local'
     AND COALESCE(NEW.direct_received_at, NEW.local_completed_at) IS NOT NULL THEN
    PERFORM dispatch_record_order_completion(
      'TO',
      NEW.transfer_order_ref,
      COALESCE(NEW.direct_received_at, NEW.local_completed_at),
      'direct_dependency',
      COALESCE(NULLIF(btrim(NEW.direct_receipt_job_id), ''), 'dependency:' || NEW.id::text),
      NEW.planned_plan_id,
      NEW.planned_date,
      NEW.planned_load_id,
      'system',
      '',
      '',
      jsonb_build_object(
        'dependencyId', NEW.id,
        'salesOrderRef', NEW.sales_order_ref,
        'directReceiptJobId', COALESCE(NEW.direct_receipt_job_id, ''),
        'loadName', COALESCE(NEW.planned_load_name, '')
      )
    );
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_direct_dependency_dispatch_completion ON order_dependencies;
CREATE TRIGGER trg_direct_dependency_dispatch_completion
  AFTER INSERT OR UPDATE ON order_dependencies
  FOR EACH ROW EXECUTE FUNCTION dispatch_project_direct_dependency_completion();

CREATE OR REPLACE FUNCTION dispatch_project_reconciliation_completion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.application_status = 'Completed'
     AND COALESCE(NEW.completed_at, NEW.reconciled_at, NEW.updated_at) IS NOT NULL
     AND dispatch_completion_normalize_order_kind(NEW.order_kind, NEW.source_order_ref) IS NOT NULL THEN
    PERFORM dispatch_record_order_completion(
      NEW.order_kind,
      NEW.source_order_ref,
      COALESCE(NEW.completed_at, NEW.reconciled_at, NEW.updated_at),
      'reconciliation',
      'reconciliation:' || NEW.id::text,
      NULL,
      CASE
        WHEN COALESCE(NEW.order_snapshot, '{}'::jsonb)->>'dispatchPlanDate' ~ '^\\d{4}-\\d{2}-\\d{2}$'
          THEN (NEW.order_snapshot->>'dispatchPlanDate')::date
        ELSE NULL
      END,
      NULL,
      'system',
      '',
      '',
      jsonb_build_object('reconciliationOrderStateId', NEW.id)
    );
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_reconciliation_dispatch_completion
  ON scm_reconciliation_order_state;
CREATE TRIGGER trg_reconciliation_dispatch_completion
  AFTER INSERT OR UPDATE ON scm_reconciliation_order_state
  FOR EACH ROW EXECUTE FUNCTION dispatch_project_reconciliation_completion();

CREATE OR REPLACE FUNCTION dispatch_project_sales_fulfillment_completion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.fulfillment_status = 'fulfilled' OR NEW.fulfilled_at IS NOT NULL)
     AND COALESCE(NEW.fulfilled_at, NEW.status_updated_at, NEW.synced_at) IS NOT NULL THEN
    PERFORM dispatch_record_order_completion(
      'SO',
      NEW.tranid,
      COALESCE(NEW.fulfilled_at, NEW.status_updated_at, NEW.synced_at),
      'netsuite_fulfillment',
      'sales_order:' || NEW.netsuite_id::text,
      NULL,
      NEW.dispatch_plan_date,
      NULL,
      'system',
      '',
      '',
      jsonb_build_object('salesOrderNetsuiteId', NEW.netsuite_id)
    );
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_sales_fulfillment_dispatch_completion ON sales_orders;
CREATE TRIGGER trg_sales_fulfillment_dispatch_completion
  AFTER INSERT OR UPDATE ON sales_orders
  FOR EACH ROW EXECUTE FUNCTION dispatch_project_sales_fulfillment_completion();

CREATE OR REPLACE FUNCTION dispatch_project_vrma_completion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF lower(btrim(COALESCE(NEW.status, ''))) = 'completed'
     AND NEW.completed_at IS NOT NULL THEN
    PERFORM dispatch_record_order_completion(
      'VRMA',
      NEW.vrma_ref,
      NEW.completed_at,
      'vrma_completion',
      'vrma:' || NEW.id::text,
      NULL,
      NULL,
      NULL,
      CASE WHEN NULLIF(btrim(COALESCE(NEW.completed_by, '')), '') IS NULL THEN 'system' ELSE 'operator' END,
      COALESCE(NEW.completed_by, ''),
      COALESCE(NEW.completion_note, ''),
      jsonb_build_object('vrmaOrderId', NEW.id, 'completionSource', COALESCE(NEW.completion_source, ''))
    );
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_vrma_dispatch_completion ON scm_vrma_orders;
CREATE TRIGGER trg_vrma_dispatch_completion
  AFTER INSERT OR UPDATE ON scm_vrma_orders
  FOR EACH ROW EXECUTE FUNCTION dispatch_project_vrma_completion();

CREATE OR REPLACE FUNCTION dispatch_project_custom_order_completion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'completed' AND NEW.completed_at IS NOT NULL THEN
    PERFORM dispatch_record_order_completion(
      'CUSTOM',
      NEW.ref_number,
      NEW.completed_at,
      'custom_order',
      'custom_order:' || NEW.id::text,
      NULL,
      NULL,
      NULL,
      CASE WHEN NULLIF(btrim(COALESCE(NEW.updated_by, '')), '') IS NULL THEN 'system' ELSE 'operator' END,
      COALESCE(NEW.updated_by, ''),
      '',
      jsonb_build_object('customOrderId', NEW.id)
    );
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_custom_order_dispatch_completion ON dispatch_custom_orders;
CREATE TRIGGER trg_custom_order_dispatch_completion
  AFTER INSERT OR UPDATE ON dispatch_custom_orders
  FOR EACH ROW EXECUTE FUNCTION dispatch_project_custom_order_completion();

-- Existing evidence becomes canonical without mutating any operational source
-- row. Every statement is replay-safe through the evidence uniqueness index.
INSERT INTO dispatch_order_completion_events (
  order_kind, order_ref, dispatch_completed_at,
  completion_evidence_type, completion_evidence_id,
  plan_id, plan_date, load_id, actor_type, actor_id, metadata
)
SELECT dispatch_completion_driver_order_kind(reference.value, record.job_details),
       btrim(reference.value), record.completed_at,
       'driver_job', record.job_id,
       record.plan_id, record.plan_date, NULLIF(btrim(record.load_id), ''),
       'driver', record.driver_login,
       jsonb_build_object(
         'driverJobRecordId', record.id,
         'stopId', COALESCE(record.stop_id, ''),
         'stopType', record.stop_type,
         'truckPlate', COALESCE(record.truck_plate, ''),
         'loadName', COALESCE(record.load_name, '')
       )
  FROM driver_job_records record
 CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(record.order_refs, '[]'::jsonb)) reference(value)
 WHERE record.status = 'complete'
   AND lower(btrim(record.stop_type)) = 'dropoff'
   AND record.completed_at IS NOT NULL
   AND NULLIF(btrim(reference.value), '') IS NOT NULL
   AND dispatch_completion_driver_order_kind(reference.value, record.job_details) IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO dispatch_order_completion_events (
  order_kind, order_ref, dispatch_completed_at,
  completion_evidence_type, completion_evidence_id,
  plan_id, plan_date, load_id, actor_type, metadata
)
SELECT 'TO', dependency.transfer_order_ref,
       COALESCE(dependency.direct_received_at, dependency.local_completed_at),
       'direct_dependency',
       COALESCE(NULLIF(btrim(dependency.direct_receipt_job_id), ''), 'dependency:' || dependency.id::text),
       dependency.planned_plan_id, dependency.planned_date,
       NULLIF(btrim(dependency.planned_load_id), ''), 'system',
       jsonb_build_object(
         'dependencyId', dependency.id,
         'salesOrderRef', dependency.sales_order_ref,
         'directReceiptJobId', COALESCE(dependency.direct_receipt_job_id, ''),
         'loadName', COALESCE(dependency.planned_load_name, '')
       )
  FROM order_dependencies dependency
 WHERE dependency.dependency_mode = 'direct_to_customer'
   AND dependency.status = 'received_local'
   AND COALESCE(dependency.direct_received_at, dependency.local_completed_at) IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO dispatch_order_completion_events (
  order_kind, order_ref, dispatch_completed_at,
  completion_evidence_type, completion_evidence_id,
  plan_date, actor_type, metadata
)
SELECT state.order_kind, state.source_order_ref,
       COALESCE(state.completed_at, state.reconciled_at, state.updated_at),
       'reconciliation', 'reconciliation:' || state.id::text,
       CASE
         WHEN COALESCE(state.order_snapshot, '{}'::jsonb)->>'dispatchPlanDate' ~ '^\\d{4}-\\d{2}-\\d{2}$'
           THEN (state.order_snapshot->>'dispatchPlanDate')::date
         ELSE NULL
       END,
       'system', jsonb_build_object('reconciliationOrderStateId', state.id)
  FROM scm_reconciliation_order_state state
 WHERE state.application_status = 'Completed'
   AND COALESCE(state.completed_at, state.reconciled_at, state.updated_at) IS NOT NULL
   AND dispatch_completion_normalize_order_kind(state.order_kind, state.source_order_ref) IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO dispatch_order_completion_events (
  order_kind, order_ref, dispatch_completed_at,
  completion_evidence_type, completion_evidence_id,
  plan_id, plan_date, actor_type, metadata
)
SELECT 'SO', sales.tranid,
       COALESCE(sales.fulfilled_at, sales.status_updated_at, sales.synced_at),
       'netsuite_fulfillment', 'sales_order:' || sales.netsuite_id::text,
       NULL, sales.dispatch_plan_date, 'system',
       jsonb_build_object('salesOrderNetsuiteId', sales.netsuite_id)
  FROM sales_orders sales
 WHERE (sales.fulfillment_status = 'fulfilled' OR sales.fulfilled_at IS NOT NULL)
   AND COALESCE(sales.fulfilled_at, sales.status_updated_at, sales.synced_at) IS NOT NULL
   AND NULLIF(btrim(sales.tranid), '') IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO dispatch_order_completion_events (
  order_kind, order_ref, dispatch_completed_at,
  completion_evidence_type, completion_evidence_id,
  actor_type, actor_id, reason, metadata
)
SELECT 'VRMA', vrma.vrma_ref, vrma.completed_at,
       'vrma_completion', 'vrma:' || vrma.id::text,
       CASE WHEN NULLIF(btrim(COALESCE(vrma.completed_by, '')), '') IS NULL THEN 'system' ELSE 'operator' END,
       COALESCE(vrma.completed_by, ''), COALESCE(vrma.completion_note, ''),
       jsonb_build_object('vrmaOrderId', vrma.id, 'completionSource', COALESCE(vrma.completion_source, ''))
  FROM scm_vrma_orders vrma
 WHERE lower(btrim(COALESCE(vrma.status, ''))) = 'completed'
   AND vrma.completed_at IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO dispatch_order_completion_events (
  order_kind, order_ref, dispatch_completed_at,
  completion_evidence_type, completion_evidence_id,
  actor_type, actor_id, metadata
)
SELECT 'CUSTOM', custom_order.ref_number, custom_order.completed_at,
       'custom_order', 'custom_order:' || custom_order.id::text,
       CASE WHEN NULLIF(btrim(COALESCE(custom_order.updated_by, '')), '') IS NULL THEN 'system' ELSE 'operator' END,
       COALESCE(custom_order.updated_by, ''),
       jsonb_build_object('customOrderId', custom_order.id)
  FROM dispatch_custom_orders custom_order
 WHERE custom_order.status = 'completed'
   AND custom_order.completed_at IS NOT NULL
ON CONFLICT DO NOTHING;

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

COMMENT ON TABLE dispatch_order_completion_events IS
  'Append-only evidence behind the universal Dispatch completion status consumed by MBBS billing.';
COMMENT ON VIEW dispatch_order_completion_status IS
  'One deterministic dispatch_completion_status per SO, TO, PO, VRMA, or CUSTOM order reference.';

COMMIT;
