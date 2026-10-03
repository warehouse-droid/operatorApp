-- Transport status follows the actual split children carried by a linked group.
-- The strict receipt contract retained by migration 256 remains unchanged.
CREATE OR REPLACE FUNCTION dispatch_po_allocation_delivery_refs(raw_allocation_id bigint)
RETURNS text[] LANGUAGE sql STABLE AS $$
  WITH allocation AS (
    SELECT allocation.*, source.line_id AS source_line_key, definition.group_ref,
      definition.full_order
    FROM dispatch_so_po_allocations allocation
    JOIN sales_order_lines source ON source.id=allocation.sales_line_id
    LEFT JOIN dispatch_global_order_groups definition
      ON allocation.dispatch_target_kind='group' AND definition.order_type='SO'
      AND lower(btrim(definition.group_ref))=lower(btrim(allocation.dispatch_target_ref))
    WHERE allocation.id=raw_allocation_id AND allocation.status='active'
  ), matched AS (
    SELECT btrim(child.detail->>'id') AS ref,
      COALESCE(CASE WHEN jsonb_typeof(item.detail->'splitQty')='number'
        THEN (item.detail->>'splitQty')::numeric
        WHEN jsonb_typeof(item.detail->'quantity')='number'
        THEN (item.detail->>'quantity')::numeric END,0) AS quantity,
      CASE WHEN jsonb_typeof(item.detail->'pallets')='number' THEN (item.detail->>'pallets')::numeric ELSE 0 END AS pallets,
      CASE WHEN jsonb_typeof(item.detail->'layers')='number' THEN (item.detail->>'layers')::numeric ELSE 0 END AS layers,
      CASE WHEN jsonb_typeof(item.detail->'sections')='number' THEN (item.detail->>'sections')::numeric ELSE 0 END AS sections,
      CASE WHEN jsonb_typeof(item.detail->'pieces')='number' THEN (item.detail->>'pieces')::numeric ELSE 0 END AS pieces
    FROM allocation
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(full_order->'childOrderDetails')='array'
      THEN full_order->'childOrderDetails' ELSE '[]'::jsonb END) child(detail)
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(child.detail->'items')='array'
      THEN child.detail->'items' ELSE '[]'::jsonb END) item(detail)
    WHERE upper(COALESCE(child.detail->>'type',''))='SO'
      AND full_order->'childOrders' ? (child.detail->>'id')
      AND lower(regexp_replace(btrim(child.detail->>'id'),'-S[0-9]+$','','i'))=lower(btrim(allocation.sales_order_ref))
      AND (item.detail->>'lineRowId'=allocation.sales_line_id::text
        OR item.detail->>'sourceLineId'=allocation.sales_line_id::text
        OR item.detail->>'lineId'=allocation.source_line_key::text)
      AND COALESCE(item.detail->>'itemId',allocation.item_id::text)=allocation.item_id::text
  )
  SELECT CASE WHEN allocation.group_ref IS NOT NULL THEN COALESCE((
    SELECT CASE WHEN SUM(quantity)+0.000001>=allocation.allocated_sales_qty
      AND SUM(pallets)+0.000001>=allocation.allocated_pallet_qty
      AND SUM(layers)+0.000001>=allocation.allocated_layer_qty
      AND SUM(sections)+0.000001>=allocation.allocated_section_qty
      AND SUM(pieces)+0.000001>=allocation.allocated_piece_qty
      THEN array_agg(DISTINCT ref ORDER BY ref) ELSE '{}'::text[] END FROM matched
  ),'{}'::text[]) ELSE ARRAY[btrim(CASE WHEN allocation.dispatch_target_kind='group'
    THEN allocation.sales_order_ref ELSE COALESCE(NULLIF(allocation.dispatch_target_ref,''),allocation.sales_order_ref) END)] END
  FROM allocation
$$;

CREATE OR REPLACE FUNCTION dispatch_po_driver_job_has_so(raw_ref text,raw_refs jsonb,raw_details jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_typeof(raw_refs)='array' AND raw_refs ? raw_ref
    AND dispatch_completion_driver_order_kind(raw_ref,raw_details)='SO',false)
$$;

CREATE OR REPLACE FUNCTION dispatch_po_allocation_driver_job_matches(raw_allocation_id bigint,raw_refs jsonb,raw_details jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(cardinality(dispatch_po_allocation_delivery_refs(allocation.id))>0 AND (
    EXISTS (SELECT 1 FROM unnest(dispatch_po_allocation_delivery_refs(allocation.id)) required(ref)
      WHERE dispatch_po_driver_job_has_so(required.ref,raw_refs,raw_details))
    OR (allocation.dispatch_target_kind='group'
      AND dispatch_po_driver_job_has_so(allocation.dispatch_target_ref,raw_refs,raw_details))
  ),false) FROM dispatch_so_po_allocations allocation
  WHERE allocation.id=raw_allocation_id AND allocation.status='active'
$$;

CREATE OR REPLACE FUNCTION dispatch_po_allocation_delivery_ready(raw_allocation_id bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(cardinality(dispatch_po_allocation_delivery_refs(allocation.id))>0 AND NOT EXISTS (
    SELECT 1 FROM unnest(dispatch_po_allocation_delivery_refs(allocation.id)) required(ref)
    WHERE NOT EXISTS (SELECT 1 FROM driver_job_records job
      WHERE job.status='complete' AND job.stop_type='dropoff' AND job.completed_at IS NOT NULL
        AND (dispatch_po_driver_job_has_so(required.ref,job.order_refs,job.job_details)
          OR (allocation.dispatch_target_kind='group'
            AND dispatch_po_driver_job_has_so(allocation.dispatch_target_ref,job.order_refs,job.job_details))))
  ),false) FROM dispatch_so_po_allocations allocation
  WHERE allocation.id=raw_allocation_id AND allocation.status='active'
$$;

CREATE OR REPLACE FUNCTION dispatch_linked_transport_delivery_ready(raw_kind text,raw_ref text)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE source_id bigint; aliases text[];
BEGIN
  IF raw_kind IS DISTINCT FROM 'PO' THEN
    RETURN dispatch_linked_transport_receipt_ready(raw_kind,raw_ref);
  END IF;
  SELECT netsuite_id,ARRAY[tranid,dispatch_ref] INTO source_id,aliases FROM purchase_orders
    WHERE lower(btrim(raw_ref)) IN (lower(btrim(tranid)),lower(btrim(dispatch_ref)));
  IF NOT EXISTS (SELECT 1 FROM dispatch_so_po_allocations WHERE po_order_id=source_id AND status='active') THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM dispatch_so_po_allocations allocation
    JOIN purchase_order_lines line ON line.id=allocation.po_line_id
    WHERE allocation.po_order_id=source_id AND allocation.status='active' AND line.netsuite_active
      AND GREATEST(allocation.allocated_sales_qty,allocation.allocated_pallet_qty,
        allocation.allocated_layer_qty,allocation.allocated_section_qty,allocation.allocated_piece_qty)>0
      AND NOT dispatch_po_line_is_status_charge(line.item_id,line.sku,line.item_description,
        line.item_type,line.unit,line.pallet_qty,line.layer_qty,line.section_qty,line.piece_qty)
      AND NOT dispatch_po_allocation_delivery_ready(allocation.id)) THEN RETURN false; END IF;
  IF dispatch_po_link_fully_covers(source_id) OR dispatch_po_link_transport_fully_covers(source_id) THEN RETURN true; END IF;
  RETURN EXISTS (SELECT 1 FROM driver_job_records job WHERE job.status='complete' AND job.stop_type='dropoff'
    AND job.completed_at IS NOT NULL AND job.order_refs ?| aliases
    AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(job.order_refs) reference(value)
      WHERE reference.value=ANY(aliases) AND dispatch_completion_driver_order_kind(reference.value,job.job_details)='PO'));
END
$$;

CREATE OR REPLACE FUNCTION dispatch_project_direct_po_link_completion()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE linked_po record; evidence driver_job_records%ROWTYPE;
BEGIN
  IF NEW.status<>'complete' OR NEW.stop_type<>'dropoff' OR NEW.completed_at IS NULL
    OR jsonb_typeof(COALESCE(NEW.order_refs,'[]'::jsonb))<>'array' THEN RETURN NEW; END IF;
  FOR linked_po IN
    SELECT DISTINCT po.netsuite_id AS id,btrim(COALESCE(NULLIF(po.dispatch_ref,''),po.tranid)) AS ref,po.tranid,po.dispatch_ref
    FROM dispatch_so_po_allocations allocation JOIN purchase_orders po ON po.netsuite_id=allocation.po_order_id
    WHERE allocation.status='active' AND (NEW.order_refs ?| ARRAY[po.tranid,po.dispatch_ref]
      OR dispatch_po_allocation_driver_job_matches(allocation.id,NEW.order_refs,NEW.job_details))
  LOOP
    IF NOT dispatch_linked_transport_delivery_ready('PO',linked_po.ref) THEN CONTINUE; END IF;
    SELECT job.* INTO evidence FROM driver_job_records job
      WHERE job.status='complete' AND job.stop_type='dropoff' AND job.completed_at IS NOT NULL
        AND (job.order_refs ?| ARRAY[linked_po.tranid,linked_po.dispatch_ref] OR EXISTS (
          SELECT 1 FROM dispatch_so_po_allocations allocation
          JOIN purchase_order_lines line ON line.id=allocation.po_line_id
          WHERE allocation.po_order_id=linked_po.id AND allocation.status='active' AND line.netsuite_active
            AND NOT dispatch_po_line_is_status_charge(line.item_id,line.sku,line.item_description,
              line.item_type,line.unit,line.pallet_qty,line.layer_qty,line.section_qty,line.piece_qty)
            AND dispatch_po_allocation_driver_job_matches(allocation.id,job.order_refs,job.job_details)))
      ORDER BY job.completed_at DESC,job.id DESC LIMIT 1;
    IF NOT FOUND THEN CONTINUE; END IF;
    PERFORM dispatch_record_order_completion('PO',linked_po.ref,evidence.completed_at,'driver_job',evidence.job_id,
      evidence.plan_id,evidence.plan_date,evidence.load_id,'driver',COALESCE(evidence.driver_login,''),'',
      jsonb_build_object('directPoLink',true,'poOrderId',linked_po.id,'driverJobRecordId',evidence.id,
        'directShipCoverageVerified',dispatch_linked_transport_receipt_ready('PO',linked_po.ref),'directTransportCoverageVerified',true));
  END LOOP;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION dispatch_recover_direct_po_transport_completion(raw_po_id bigint)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE po purchase_orders%ROWTYPE; evidence driver_job_records%ROWTYPE;
  po_ref text; retained_id bigint;
BEGIN
  SELECT * INTO po FROM purchase_orders WHERE netsuite_id=raw_po_id FOR UPDATE;
  IF NOT FOUND OR NOT COALESCE(po.netsuite_active,false) THEN RETURN NULL; END IF;
  po_ref:=btrim(COALESCE(NULLIF(po.dispatch_ref,''),po.tranid));
  SELECT completion_event_id INTO retained_id FROM dispatch_order_completion_status
    WHERE order_kind='PO' AND lower(btrim(order_ref))=lower(po_ref);
  IF retained_id IS NOT NULL THEN RETURN retained_id; END IF;
  IF NOT dispatch_po_link_transport_fully_covers(raw_po_id)
    OR NOT dispatch_linked_transport_delivery_ready('PO',po_ref)
    OR dispatch_linked_transport_receipt_ready('PO',po_ref) THEN RETURN NULL; END IF;
  SELECT job.* INTO evidence FROM driver_job_records job
    WHERE job.status='complete' AND job.stop_type='dropoff' AND job.completed_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM dispatch_so_po_allocations allocation
        JOIN purchase_order_lines line ON line.id=allocation.po_line_id
        WHERE allocation.po_order_id=raw_po_id AND allocation.status='active' AND line.netsuite_active
          AND NOT dispatch_po_line_is_status_charge(line.item_id,line.sku,line.item_description,
            line.item_type,line.unit,line.pallet_qty,line.layer_qty,line.section_qty,line.piece_qty)
          AND dispatch_po_allocation_driver_job_matches(allocation.id,job.order_refs,job.job_details))
    ORDER BY job.completed_at DESC,job.id DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN dispatch_record_order_completion('PO',po_ref,evidence.completed_at,'driver_job',evidence.job_id,
    evidence.plan_id,evidence.plan_date,evidence.load_id,'driver',COALESCE(evidence.driver_login,''),
    'Recovered linked product delivery from verified Driver proof.',
    jsonb_build_object('directPoLink',true,'poOrderId',po.netsuite_id,'driverJobRecordId',evidence.id,
      'directShipCoverageVerified',false,'directTransportCoverageVerified',true,
      'backfilled',true,'coverageRepair','po-status-split-group-reference'));
END
$$;

-- Recover only the user's verified completed order; keep existing history intact.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM purchase_orders WHERE netsuite_id=-237519275993888
    AND btrim(COALESCE(NULLIF(dispatch_ref,''),tranid))='SN1401884') THEN
    PERFORM dispatch_recover_direct_po_transport_completion(-237519275993888);
  END IF;
END
$$;
