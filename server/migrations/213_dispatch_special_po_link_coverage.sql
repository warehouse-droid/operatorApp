-- Correct special-order native quantity coverage. The migration runner owns
-- the transaction; no receipts, links, Driver history or plan snapshots change.

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
            -- MBBS-Special links allocate native Sales Qty; PLT/LYR/SEC/PCS
            -- are display counts, not additional independent freight.
            ((line.item_id IS DISTINCT FROM 2055 OR COALESCE(line.quantity, 0) <= 0)
             AND (GREATEST(
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
            ) > allocated.pieces + 0.000001))
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
  'True when active Link PO allocations cover outstanding PO cargo; MBBS-Special uses native Sales Qty, with physical counts retained only when native quantity is unknown.';

-- Recover only special POs with every linked SO already completed by Driver.
-- The latest real drop is retained as evidence; unique evidence prevents replay.
WITH qualifying_po AS (
  SELECT DISTINCT allocation.po_order_id,
         btrim(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid)) AS po_order_ref
    FROM dispatch_so_po_allocations allocation
    JOIN purchase_orders po
      ON po.netsuite_id = allocation.po_order_id
   WHERE allocation.status = 'active'
     AND dispatch_po_link_fully_covers(allocation.po_order_id)
     AND EXISTS (
       SELECT 1 FROM purchase_order_lines special
        WHERE special.purchase_order_id = allocation.po_order_id
          AND special.netsuite_active = true
          AND special.item_id = 2055 AND special.quantity > 0
     )
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
         'coverageRepair', 'special-native-quantity',
         'poOrderId', recovered.po_order_id,
         'sourceCompletionEventId', recovered.completion_event_id,
         'sourceMetadata', COALESCE(recovered.source_metadata, '{}'::jsonb)
       )
  FROM recovered
ON CONFLICT DO NOTHING;

