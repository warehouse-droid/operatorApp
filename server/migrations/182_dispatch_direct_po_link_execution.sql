BEGIN;

-- A PO that is entirely carried by Link PO has no standalone PO drop stop.
-- Its execution evidence therefore comes from the linked SO target. Keep this
-- projection strict: a partial link must never complete or hide the residual
-- PO route.

CREATE INDEX IF NOT EXISTS idx_dispatch_so_po_allocations_active_po_execution
  ON dispatch_so_po_allocations (po_order_id, lower(po_order_ref))
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_dispatch_so_po_allocations_active_sales_execution
  ON dispatch_so_po_allocations (lower(sales_order_ref), po_order_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_dispatch_so_po_allocations_active_target_execution
  ON dispatch_so_po_allocations (lower(dispatch_target_ref), po_order_id)
  WHERE status = 'active';

CREATE OR REPLACE FUNCTION dispatch_po_link_fully_covers(raw_po_order_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
           SELECT 1
             FROM dispatch_so_po_allocations allocation
            WHERE allocation.po_order_id = raw_po_order_id
              AND allocation.status = 'active'
         )
     AND NOT EXISTS (
       SELECT 1
         FROM purchase_order_lines line
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(allocation.allocated_pallet_qty), 0) AS pallets,
                  COALESCE(SUM(allocation.allocated_layer_qty), 0) AS layers,
                  COALESCE(SUM(allocation.allocated_section_qty), 0) AS sections,
                  COALESCE(SUM(allocation.allocated_piece_qty), 0) AS pieces,
                  COALESCE(SUM(allocation.allocated_sales_qty), 0) AS sales_qty
             FROM dispatch_so_po_allocations allocation
            WHERE allocation.po_line_id = line.id
              AND allocation.status = 'active'
         ) allocated ON true
        WHERE line.purchase_order_id = raw_po_order_id
          AND line.netsuite_active = true
          AND COALESCE(line.item_type, '') IN ('InvtPart', 'NonInvtPart')
          AND (
            GREATEST(
              COALESCE(line.pallet_qty, 0) - COALESCE(line.received_pallet_qty, 0),
              0
            ) > allocated.pallets + 0.000001
            OR GREATEST(
              COALESCE(line.layer_qty, 0) - COALESCE(line.received_layer_qty, 0),
              0
            ) > allocated.layers + 0.000001
            OR GREATEST(
              COALESCE(line.section_qty, 0) - COALESCE(line.received_section_qty, 0),
              0
            ) > allocated.sections + 0.000001
            OR GREATEST(
              COALESCE(line.piece_qty, 0) - COALESCE(line.received_piece_qty, 0),
              0
            ) > allocated.pieces + 0.000001
            OR GREATEST(
              COALESCE(line.quantity, 0) - GREATEST(
                COALESCE(line.netsuite_received_baseline_qty, 0),
                COALESCE(line.netsuite_received_qty, 0),
                COALESCE(line.received_sales_qty, 0)
              ),
              0
            ) > allocated.sales_qty + 0.000001
          )
     )
$$;

COMMENT ON FUNCTION dispatch_po_link_fully_covers(bigint) IS
  'True only when active Link PO allocations cover every outstanding operational quantity on the selected PO.';

CREATE OR REPLACE FUNCTION dispatch_project_direct_po_link_completion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_po record;
BEGIN
  IF lower(btrim(COALESCE(NEW.status, ''))) <> 'complete'
     OR lower(btrim(COALESCE(NEW.stop_type, ''))) <> 'dropoff'
     OR NEW.completed_at IS NULL
     OR jsonb_typeof(COALESCE(NEW.order_refs, '[]'::jsonb)) <> 'array' THEN
    RETURN NEW;
  END IF;

  FOR linked_po IN
    SELECT DISTINCT allocation.po_order_id,
           btrim(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid)) AS po_order_ref
      FROM dispatch_so_po_allocations allocation
      JOIN purchase_orders po
        ON po.netsuite_id = allocation.po_order_id
     WHERE allocation.status = 'active'
       AND dispatch_po_link_fully_covers(allocation.po_order_id)
       AND NULLIF(btrim(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid)), '') IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(COALESCE(NEW.order_refs, '[]'::jsonb)) reference(value)
          WHERE lower(btrim(reference.value)) IN (
            lower(btrim(allocation.sales_order_ref)),
            lower(btrim(allocation.dispatch_target_ref))
          )
       )
       AND NOT EXISTS (
         SELECT 1
           FROM dispatch_so_po_allocations required
          WHERE required.po_order_id = allocation.po_order_id
            AND required.status = 'active'
            AND NOT (
              EXISTS (
                SELECT 1
                  FROM jsonb_array_elements_text(COALESCE(NEW.order_refs, '[]'::jsonb)) reference(value)
                 WHERE lower(btrim(reference.value)) IN (
                   lower(btrim(required.sales_order_ref)),
                   lower(btrim(required.dispatch_target_ref))
                 )
              )
              OR EXISTS (
                SELECT 1
                  FROM dispatch_order_completion_status completion
                 WHERE completion.order_kind = 'SO'
                   AND completion.dispatch_completion_status = 'completed'
                   AND lower(btrim(completion.order_ref)) IN (
                     lower(btrim(required.sales_order_ref)),
                     lower(btrim(required.dispatch_target_ref))
                   )
              )
            )
       )
       AND NOT EXISTS (
         SELECT 1
           FROM dispatch_order_completion_status completion
          WHERE completion.order_kind = 'PO'
            AND completion.dispatch_completion_status = 'completed'
            AND lower(btrim(completion.order_ref)) = lower(btrim(allocation.po_order_ref))
       )
  LOOP
    PERFORM dispatch_record_order_completion(
      'PO',
      linked_po.po_order_ref,
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
        'directPoLink', true,
        'poOrderId', linked_po.po_order_id,
        'driverJobRecordId', NEW.id,
        'sourceOrderRefs', COALESCE(NEW.order_refs, '[]'::jsonb),
        'stopId', COALESCE(NEW.stop_id, ''),
        'truckPlate', COALESCE(NEW.truck_plate, ''),
        'loadName', COALESCE(NEW.load_name, '')
      )
    );
  END LOOP;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_driver_job_z_direct_po_link_completion
  ON driver_job_records;
CREATE TRIGGER trg_driver_job_z_direct_po_link_completion
  AFTER INSERT OR UPDATE ON driver_job_records
  FOR EACH ROW EXECUTE FUNCTION dispatch_project_direct_po_link_completion();

-- Replay-safe recovery for fully linked POs whose target Driver drops were
-- completed before this projection existed.
WITH qualifying_po AS (
  SELECT DISTINCT allocation.po_order_id,
         btrim(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid)) AS po_order_ref
    FROM dispatch_so_po_allocations allocation
    JOIN purchase_orders po
      ON po.netsuite_id = allocation.po_order_id
   WHERE allocation.status = 'active'
     AND dispatch_po_link_fully_covers(allocation.po_order_id)
     AND NULLIF(btrim(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid)), '') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM dispatch_so_po_allocations required
        WHERE required.po_order_id = allocation.po_order_id
          AND required.status = 'active'
          AND NOT EXISTS (
            SELECT 1
              FROM dispatch_order_completion_status completion
             WHERE completion.order_kind = 'SO'
               AND completion.dispatch_completion_status = 'completed'
               AND completion.completion_evidence_type = 'driver_job'
               AND lower(btrim(completion.order_ref)) IN (
                 lower(btrim(required.sales_order_ref)),
                 lower(btrim(required.dispatch_target_ref))
               )
          )
     )
     AND NOT EXISTS (
       SELECT 1
         FROM dispatch_order_completion_status completion
        WHERE completion.order_kind = 'PO'
          AND completion.dispatch_completion_status = 'completed'
          AND lower(btrim(completion.order_ref)) = lower(btrim(allocation.po_order_ref))
     )
), recovered AS (
  SELECT qualifying.*,
         evidence.completion_event_id,
         evidence.dispatch_completed_at,
         evidence.completion_evidence_id,
         evidence.plan_id,
         evidence.plan_date,
         evidence.load_id,
         evidence.actor_id,
         evidence.metadata AS source_metadata
    FROM qualifying_po qualifying
    JOIN LATERAL (
      SELECT completion.*
        FROM dispatch_order_completion_status completion
       WHERE completion.order_kind = 'SO'
         AND completion.dispatch_completion_status = 'completed'
         AND completion.completion_evidence_type = 'driver_job'
         AND EXISTS (
           SELECT 1
             FROM dispatch_so_po_allocations allocation
            WHERE allocation.po_order_id = qualifying.po_order_id
              AND allocation.status = 'active'
              AND lower(btrim(completion.order_ref)) IN (
                lower(btrim(allocation.sales_order_ref)),
                lower(btrim(allocation.dispatch_target_ref))
              )
         )
       ORDER BY completion.dispatch_completed_at DESC, completion.completion_event_id DESC
       LIMIT 1
    ) evidence ON true
)
INSERT INTO dispatch_order_completion_events (
  order_kind, order_ref, dispatch_completed_at,
  completion_evidence_type, completion_evidence_id,
  plan_id, plan_date, load_id,
  actor_type, actor_id, reason, metadata
)
SELECT 'PO', recovered.po_order_ref, recovered.dispatch_completed_at,
       'driver_job', recovered.completion_evidence_id,
       recovered.plan_id, recovered.plan_date, recovered.load_id,
       'driver', COALESCE(recovered.actor_id, ''), '',
       jsonb_build_object(
         'directPoLink', true,
         'backfilled', true,
         'poOrderId', recovered.po_order_id,
         'sourceCompletionEventId', recovered.completion_event_id,
         'sourceMetadata', COALESCE(recovered.source_metadata, '{}'::jsonb)
       )
  FROM recovered
ON CONFLICT DO NOTHING;

COMMIT;
