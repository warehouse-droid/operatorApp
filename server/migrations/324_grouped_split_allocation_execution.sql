-- Resolve a grouped split from the saved executed route, never from a guessed
-- parent reference or a mutable global split definition. No historical backfill.
CREATE OR REPLACE FUNCTION dispatch_split_allocation_job_matches(
  allocation dispatch_so_po_allocations, execution driver_job_records
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT allocation.dispatch_target_kind = 'group'
    AND allocation.allocated_sales_qty > 0
    AND allocation.created_at <= execution.completed_at
    AND EXISTS (
      SELECT 1
      FROM dispatch_plan_snapshots snapshot
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(snapshot.orders)='array' THEN snapshot.orders ELSE '[]'::jsonb END) grouped
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(grouped->'childOrderDetails')='array' THEN grouped->'childOrderDetails' ELSE '[]'::jsonb END) child
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(child->'items')='array' THEN child->'items' ELSE '[]'::jsonb END) item
      WHERE snapshot.plan_id = execution.plan_id
        AND grouped->>'id' = allocation.dispatch_target_ref
        AND jsonb_typeof(grouped->'childOrders') = 'array'
        AND grouped->'childOrders' ? (child->>'id')
        AND child->>'originalOrderId' = allocation.sales_order_ref
        AND child->>'netsuiteId' = allocation.sales_order_id::text
        AND child->>'id' <> allocation.sales_order_ref
        AND execution.order_refs ? (child->>'id')
        AND item->>'lineRowId' = allocation.sales_line_id::text
        AND item->>'itemId' = allocation.item_id::text
        AND CASE WHEN length(item->>'quantity') < 32 AND item->>'quantity' ~ '^[0-9]+([.][0-9]+)?$'
          THEN (item->>'quantity')::numeric ELSE 0 END >= (
            SELECT sum(active.allocated_sales_qty)
            FROM dispatch_so_po_allocations active
            WHERE active.status = 'active'
              AND active.dispatch_target_ref = allocation.dispatch_target_ref
              AND active.sales_line_id = allocation.sales_line_id
          )
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(execution.job_details->'orders')='array'
            THEN execution.job_details->'orders' ELSE '[]'::jsonb END) retained
          WHERE retained->>'orderRef' = child->>'id'
            AND retained->>'orderId' = allocation.sales_order_id::text
        )
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(snapshot.trucks)='array' THEN snapshot.trucks ELSE '[]'::jsonb END) truck
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(truck->'loads')='array' THEN truck->'loads' ELSE '[]'::jsonb END) load
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(load->'stops')='array' THEN load->'stops' ELSE '[]'::jsonb END) stop
          WHERE load->>'id' = execution.load_id
            AND stop->>'id' = execution.stop_id
            AND stop->>'orderId' = allocation.dispatch_target_ref
        )
    );
$$;

-- Shared by the normal trigger and bounded operational replay. Always reread
-- the real job under a lock; callers cannot supply invented completion evidence.
CREATE OR REPLACE FUNCTION dispatch_record_so_po_allocation_execution(raw_job_id bigint)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  execution driver_job_records%ROWTYPE;
BEGIN
  SELECT * INTO execution FROM driver_job_records WHERE id = raw_job_id FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  IF lower(btrim(COALESCE(execution.status, ''))) <> 'complete'
     OR execution.completed_at IS NULL
     OR jsonb_typeof(COALESCE(execution.order_refs, '[]'::jsonb)) <> 'array' THEN
    RETURN;
  END IF;

  IF lower(btrim(COALESCE(execution.stop_type, ''))) = 'pickup' THEN
    INSERT INTO dispatch_so_po_allocation_execution_events (
      allocation_id, phase, driver_job_record_id, driver_job_id,
      plan_id, plan_date, load_id, load_name, stop_id,
      sales_order_ref, dispatch_target_ref, po_order_ref,
      sales_line_id, po_line_id,
      allocated_sales_qty, allocated_pallet_qty, allocated_layer_qty,
      allocated_section_qty, allocated_piece_qty, allocation_snapshot
    )
    SELECT allocation.id, 'pickup', execution.id, execution.job_id,
           execution.plan_id, execution.plan_date, execution.load_id, COALESCE(execution.load_name, ''), COALESCE(execution.stop_id, ''),
           allocation.sales_order_ref, allocation.dispatch_target_ref, allocation.po_order_ref,
           allocation.sales_line_id, allocation.po_line_id,
           allocation.allocated_sales_qty, allocation.allocated_pallet_qty,
           allocation.allocated_layer_qty, allocation.allocated_section_qty,
           allocation.allocated_piece_qty,
           jsonb_build_object(
             'allocationId', allocation.id,
             'details', allocation.details,
             'salesOrderRef', allocation.sales_order_ref,
             'dispatchTargetRef', allocation.dispatch_target_ref,
             'poOrderRef', allocation.po_order_ref,
             'salesLineId', allocation.sales_line_id,
             'poLineId', allocation.po_line_id,
             'allocatedSalesQty', allocation.allocated_sales_qty,
             'allocatedPalletQty', allocation.allocated_pallet_qty,
             'allocatedLayerQty', allocation.allocated_layer_qty,
             'allocatedSectionQty', allocation.allocated_section_qty,
             'allocatedPieceQty', allocation.allocated_piece_qty
           )
      FROM dispatch_so_po_allocations allocation
     WHERE allocation.status = 'active'
       AND (
         EXISTS (
           SELECT 1
             FROM jsonb_array_elements_text(execution.order_refs) reference(value)
            WHERE lower(btrim(reference.value)) IN (
              lower(btrim(allocation.sales_order_ref)),
              lower(btrim(allocation.dispatch_target_ref)),
              lower(btrim(allocation.po_order_ref))
            )
         )
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(COALESCE(execution.job_details, '{}'::jsonb)->'orders') = 'array'
                 THEN COALESCE(execution.job_details, '{}'::jsonb)->'orders' ELSE '[]'::jsonb END
             ) retained(value)
            WHERE lower(btrim(COALESCE(retained.value->>'orderRef', ''))) IN (
              lower(btrim(allocation.sales_order_ref)),
              lower(btrim(allocation.dispatch_target_ref)),
              lower(btrim(allocation.po_order_ref))
            )
         )
         OR dispatch_split_allocation_job_matches(allocation, execution)
       )
       AND dispatch_normalized_execution_place(COALESCE(
             NULLIF(execution.job_details->>'pickupLocation', ''),
             NULLIF(execution.job_details->>'location', ''),
             execution.job_details->>'address'
           )) IN (
             dispatch_normalized_execution_place(allocation.details->>'poVendorYard'),
             dispatch_normalized_execution_place(allocation.details->>'poAddress')
           )
    ON CONFLICT (allocation_id, phase, driver_job_id) DO NOTHING;
  ELSIF lower(btrim(COALESCE(execution.stop_type, ''))) = 'dropoff' THEN
    INSERT INTO dispatch_so_po_allocation_execution_events (
      allocation_id, phase, driver_job_record_id, driver_job_id,
      plan_id, plan_date, load_id, load_name, stop_id,
      sales_order_ref, dispatch_target_ref, po_order_ref,
      sales_line_id, po_line_id,
      allocated_sales_qty, allocated_pallet_qty, allocated_layer_qty,
      allocated_section_qty, allocated_piece_qty, allocation_snapshot
    )
    SELECT allocation.id, 'delivered', execution.id, execution.job_id,
           execution.plan_id, execution.plan_date, execution.load_id, COALESCE(execution.load_name, ''), COALESCE(execution.stop_id, ''),
           allocation.sales_order_ref, allocation.dispatch_target_ref, allocation.po_order_ref,
           allocation.sales_line_id, allocation.po_line_id,
           allocation.allocated_sales_qty, allocation.allocated_pallet_qty,
           allocation.allocated_layer_qty, allocation.allocated_section_qty,
           allocation.allocated_piece_qty,
           pickup.allocation_snapshot || jsonb_build_object('pickupExecutionEventId', pickup.id)
      FROM dispatch_so_po_allocations allocation
      JOIN dispatch_so_po_allocation_execution_events pickup
        ON pickup.allocation_id = allocation.id
       AND pickup.phase = 'pickup'
       AND pickup.load_id = execution.load_id
       AND (pickup.plan_id IS NOT DISTINCT FROM execution.plan_id)
     WHERE allocation.status = 'active'
       AND (EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(execution.order_refs) reference(value)
          WHERE lower(btrim(reference.value)) IN (
            lower(btrim(allocation.sales_order_ref)),
            lower(btrim(allocation.dispatch_target_ref))
          )
       ) OR dispatch_split_allocation_job_matches(allocation, execution))
    ON CONFLICT (allocation_id, phase, driver_job_id) DO NOTHING;
  END IF;
  RETURN;
END
$$;

CREATE OR REPLACE FUNCTION dispatch_project_so_po_allocation_execution()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM dispatch_record_so_po_allocation_execution(NEW.id);
  RETURN NEW;
END
$$;
