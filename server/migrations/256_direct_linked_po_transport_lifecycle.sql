-- The migration runner owns the transaction. Status describes product delivery;
-- receipt admission continues to require the original whole-line delivery proof.
CREATE OR REPLACE FUNCTION dispatch_po_line_is_status_charge(
  raw_item_id bigint, raw_sku text, raw_description text, raw_item_type text,
  raw_unit text, raw_pallets numeric, raw_layers numeric, raw_sections numeric, raw_pieces numeric
) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(raw_item_id = 1784 OR upper(btrim(raw_sku)) = 'PALLET', false)
    OR COALESCE(raw_item_id = 2055 AND raw_item_type = 'NonInvtPart'
      AND upper(btrim(raw_unit)) = 'EACH'
      AND lower(btrim(raw_description)) ~ '^split[[:space:]]+pallet[[:space:]]+fee$'
      AND GREATEST(COALESCE(raw_pallets,0), COALESCE(raw_layers,0),
        COALESCE(raw_sections,0), COALESCE(raw_pieces,0)) = 0, false)
$$;

CREATE OR REPLACE FUNCTION dispatch_po_link_transport_fully_covers(raw_po_order_id bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM dispatch_so_po_allocations allocation
    JOIN purchase_order_lines line ON line.id = allocation.po_line_id
    WHERE allocation.po_order_id = raw_po_order_id AND allocation.status = 'active'
      AND line.netsuite_active = true
      AND COALESCE(line.item_type,'') IN ('InvtPart','NonInvtPart')
      AND GREATEST(allocation.allocated_sales_qty,allocation.allocated_pallet_qty,
        allocation.allocated_layer_qty,allocation.allocated_section_qty,allocation.allocated_piece_qty) > 0
      AND NOT dispatch_po_line_is_status_charge(line.item_id,line.sku,line.item_description,
        line.item_type,line.unit,line.pallet_qty,line.layer_qty,line.section_qty,line.piece_qty)
  ) AND NOT EXISTS (
    SELECT 1 FROM purchase_order_lines line
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(allocation.allocated_pallet_qty),0) AS pallets,
        COALESCE(SUM(allocation.allocated_layer_qty),0) AS layers,
        COALESCE(SUM(allocation.allocated_section_qty),0) AS sections,
        COALESCE(SUM(allocation.allocated_piece_qty),0) AS pieces,
        COALESCE(SUM(allocation.allocated_sales_qty),0) AS sales_qty
      FROM dispatch_so_po_allocations allocation
      WHERE allocation.po_order_id = raw_po_order_id AND allocation.po_line_id = line.id
        AND allocation.status = 'active'
    ) allocated ON true
    WHERE line.purchase_order_id = raw_po_order_id AND line.netsuite_active = true
      AND COALESCE(line.item_type,'') IN ('InvtPart','NonInvtPart')
      AND NOT dispatch_po_line_is_status_charge(line.item_id,line.sku,line.item_description,
        line.item_type,line.unit,line.pallet_qty,line.layer_qty,line.section_qty,line.piece_qty)
      AND (
        ((line.item_id IS DISTINCT FROM 2055 OR COALESCE(line.quantity,0) <= 0) AND (
          GREATEST(COALESCE(line.pallet_qty,0)-COALESCE(line.received_pallet_qty,0),0)>allocated.pallets+0.000001
          OR GREATEST(COALESCE(line.layer_qty,0)-COALESCE(line.received_layer_qty,0),0)>allocated.layers+0.000001
          OR GREATEST(COALESCE(line.section_qty,0)-COALESCE(line.received_section_qty,0),0)>allocated.sections+0.000001
          OR GREATEST(COALESCE(line.piece_qty,0)-COALESCE(line.received_piece_qty,0),0)>allocated.pieces+0.000001
        )) OR GREATEST(COALESCE(line.quantity,0)-GREATEST(
          COALESCE(line.netsuite_received_baseline_qty,0),COALESCE(line.netsuite_received_qty,0),
          COALESCE(line.received_sales_qty,0)),0)>allocated.sales_qty+0.000001
      )
  )
$$;

-- Retain the strict pre-change contract for receipt queue admission. Reapplying
-- this migration must not copy the relaxed status contract into this function.
DO $$
DECLARE definition text;
BEGIN
  IF to_regprocedure('dispatch_linked_transport_receipt_ready(text,text)') IS NULL THEN
    SELECT pg_get_functiondef('dispatch_linked_transport_delivery_ready(text,text)'::regprocedure) INTO definition;
    IF position('dispatch_po_link_fully_covers(source_id)' IN definition) = 0 THEN
      RAISE EXCEPTION 'Strict linked transport delivery contract changed';
    END IF;
    EXECUTE replace(definition,'dispatch_linked_transport_delivery_ready(',
      'dispatch_linked_transport_receipt_ready(');
  END IF;
  SELECT pg_get_functiondef('dispatch_linked_transport_receipt_ready(text,text)'::regprocedure) INTO definition;
  EXECUTE replace(replace(definition,'dispatch_linked_transport_receipt_ready(',
    'dispatch_linked_transport_delivery_ready('),'dispatch_po_link_fully_covers(source_id)',
    '(dispatch_po_link_fully_covers(source_id) OR dispatch_po_link_transport_fully_covers(source_id))');

  SELECT pg_get_functiondef('dispatch_project_direct_po_link_completion()'::regprocedure) INTO definition;
  IF position('directTransportCoverageVerified' IN definition) = 0 THEN
    IF position('''directShipCoverageVerified'',true' IN definition) = 0 THEN
      RAISE EXCEPTION 'Direct PO completion metadata contract changed';
    END IF;
    EXECUTE replace(definition,'''directShipCoverageVerified'',true',
      '''directShipCoverageVerified'',dispatch_linked_transport_receipt_ready(''PO'',linked_po.ref),''directTransportCoverageVerified'',true');
  END IF;
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
      AND EXISTS (
        SELECT 1 FROM dispatch_so_po_allocations allocation
        WHERE allocation.po_order_id=raw_po_id AND allocation.status='active'
          AND job.order_refs ?| ARRAY[allocation.sales_order_ref,allocation.dispatch_target_ref]
          AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(job.order_refs) reference(value)
            WHERE reference.value IN(allocation.sales_order_ref,allocation.dispatch_target_ref)
              AND dispatch_completion_driver_order_kind(reference.value,job.job_details)='SO')
      )
    ORDER BY job.completed_at DESC,job.id DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN dispatch_record_order_completion('PO',po_ref,evidence.completed_at,'driver_job',evidence.job_id,
    evidence.plan_id,evidence.plan_date,evidence.load_id,'driver',COALESCE(evidence.driver_login,''),
    'Recovered product delivery; PALLET and Split Pallet Fee excluded from transport status.',
    jsonb_build_object('directPoLink',true,'poOrderId',po.netsuite_id,'driverJobRecordId',evidence.id,
      'directShipCoverageVerified',false,'directTransportCoverageVerified',true,
      'backfilled',true,'coverageRepair','po-status-ancillary-lines'));
END
$$;

-- Limit historical repair to the two orders verified with the user. Other
-- completed, partial and pickup-only records retain their existing history.
DO $$
DECLARE candidate record;
BEGIN
  FOR candidate IN SELECT netsuite_id FROM purchase_orders
    WHERE (netsuite_id=-179615128203145 AND btrim(COALESCE(NULLIF(dispatch_ref,''),tranid))='LOINC-033146')
       OR (netsuite_id=-43808732443904 AND btrim(COALESCE(NULLIF(dispatch_ref,''),tranid))='LOINC-035332')
  LOOP
    PERFORM dispatch_recover_direct_po_transport_completion(candidate.netsuite_id);
  END LOOP;
END
$$;
