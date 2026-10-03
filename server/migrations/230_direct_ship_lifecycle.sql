-- The migration runner owns the transaction. Keep immutable history intact.
CREATE OR REPLACE FUNCTION dispatch_direct_to_has_residual(raw_to_id bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH source AS (
    SELECT line.item_id, SUM(GREATEST(COALESCE(line.quantity,0),0)) AS quantity,
      bool_or(COALESCE(line.quantity,0)<=0 AND GREATEST(COALESCE(line.pallet_qty,0),
        COALESCE(line.layer_qty,0),COALESCE(line.section_qty,0),COALESCE(line.piece_qty,0))>0.000001) AS unknown_native_cargo
      FROM transfer_order_lines line
     WHERE line.transfer_order_id=raw_to_id AND COALESCE(line.netsuite_active,true)
       AND COALESCE(line.item_type,'InvtPart') IN ('InvtPart','NonInvtPart')
       AND line.line_stage=CASE WHEN EXISTS (
         SELECT 1 FROM transfer_order_lines outbound WHERE outbound.transfer_order_id=raw_to_id
           AND outbound.line_stage='outbound' AND COALESCE(outbound.netsuite_active,true)
       ) THEN 'outbound' ELSE 'receiving' END
     GROUP BY line.item_id
  ), allocated AS (
    SELECT line.item_id,SUM(GREATEST(COALESCE(line.allocated_quantity,0),0)) AS quantity
      FROM order_dependencies dependency JOIN order_dependency_lines line ON line.dependency_id=dependency.id
     WHERE dependency.transfer_order_id=raw_to_id AND dependency.dependency_mode='direct_to_customer'
       AND dependency.status<>'cancelled' GROUP BY line.item_id
  )
  SELECT EXISTS (SELECT 1 FROM source LEFT JOIN allocated USING(item_id)
    WHERE source.unknown_native_cargo OR source.quantity>COALESCE(allocated.quantity,0)+0.000001)
$$;

CREATE OR REPLACE FUNCTION dispatch_linked_transport_delivery_ready(raw_kind text,raw_ref text)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE source_id bigint; aliases text[];
BEGIN
  IF raw_kind='TO' THEN
    SELECT netsuite_id,ARRAY[tranid] INTO source_id,aliases FROM transfer_orders WHERE lower(btrim(tranid))=lower(btrim(raw_ref));
    IF NOT EXISTS (SELECT 1 FROM order_dependencies WHERE transfer_order_id=source_id
      AND dependency_mode='direct_to_customer' AND status<>'cancelled') THEN RETURN true; END IF;
    IF EXISTS (SELECT 1 FROM order_dependencies WHERE transfer_order_id=source_id
      AND dependency_mode='direct_to_customer' AND status NOT IN ('cancelled','received_local')) THEN RETURN false; END IF;
    IF NOT dispatch_direct_to_has_residual(source_id) THEN RETURN true; END IF;
  ELSIF raw_kind='PO' THEN
    SELECT netsuite_id,ARRAY[tranid,dispatch_ref] INTO source_id,aliases FROM purchase_orders
      WHERE lower(btrim(raw_ref)) IN (lower(btrim(tranid)),lower(btrim(dispatch_ref)));
    IF NOT EXISTS (SELECT 1 FROM dispatch_so_po_allocations WHERE po_order_id=source_id AND status='active') THEN RETURN true; END IF;
    IF EXISTS (
      SELECT 1 FROM dispatch_so_po_allocations allocation WHERE allocation.po_order_id=source_id AND allocation.status='active'
        AND NOT EXISTS (
          SELECT 1 FROM driver_job_records job WHERE job.status='complete' AND job.stop_type='dropoff' AND job.completed_at IS NOT NULL
            AND job.order_refs ?| ARRAY[allocation.sales_order_ref,allocation.dispatch_target_ref]
            AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(job.order_refs) ref(value)
              WHERE ref.value IN (allocation.sales_order_ref,allocation.dispatch_target_ref)
                AND dispatch_completion_driver_order_kind(ref.value,job.job_details)='SO')
        )
    ) THEN RETURN false; END IF;
    IF dispatch_po_link_fully_covers(source_id) THEN RETURN true; END IF;
  ELSE RETURN true;
  END IF;
  RETURN EXISTS (SELECT 1 FROM driver_job_records job WHERE job.status='complete' AND job.stop_type='dropoff'
    AND job.completed_at IS NOT NULL AND job.order_refs ?| aliases
    AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(job.order_refs) ref(value)
      WHERE ref.value=ANY(aliases) AND dispatch_completion_driver_order_kind(ref.value,job.job_details)=raw_kind));
END
$$;

-- A remaining-cargo delivery is one part of a linked shipment, not proof that
-- all of its linked SO cargo has arrived. Keep the existing Driver projection.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('dispatch_project_driver_job_completion()'::regprocedure) INTO definition;
  IF position('dispatch_linked_transport_delivery_ready' IN definition)=0 THEN
    IF position('IF retained_kind IS NULL THEN' IN definition)=0 THEN RAISE EXCEPTION 'Driver completion projection changed'; END IF;
    definition:=replace(definition,'IF retained_kind IS NULL THEN',
      'IF retained_kind IS NULL OR NOT dispatch_linked_transport_delivery_ready(retained_kind,retained_ref) THEN');
    EXECUTE definition;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION dispatch_project_direct_dependency_completion()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evidence driver_job_records%ROWTYPE;
BEGIN
  IF NEW.dependency_mode<>'direct_to_customer' OR NEW.status<>'received_local'
    OR COALESCE(NEW.direct_received_at,NEW.local_completed_at) IS NULL
    OR NOT dispatch_linked_transport_delivery_ready('TO',NEW.transfer_order_ref) THEN RETURN NEW; END IF;
  SELECT job.* INTO evidence FROM driver_job_records job
    WHERE job.status='complete' AND job.stop_type='dropoff' AND job.completed_at IS NOT NULL
      AND (job.job_id=NEW.direct_receipt_job_id OR job.order_refs ? NEW.transfer_order_ref)
    ORDER BY job.completed_at DESC,job.id DESC LIMIT 1;
  PERFORM dispatch_record_order_completion('TO',NEW.transfer_order_ref,
    COALESCE(evidence.completed_at,NEW.direct_received_at,NEW.local_completed_at),'direct_dependency',
    COALESCE(evidence.job_id,NULLIF(btrim(NEW.direct_receipt_job_id),''),'dependency:'||NEW.id::text),
    COALESCE(evidence.plan_id,NEW.planned_plan_id),COALESCE(evidence.plan_date,NEW.planned_date),
    COALESCE(evidence.load_id,NEW.planned_load_id),'system','','',jsonb_build_object(
      'dependencyId',NEW.id,'salesOrderRef',NEW.sales_order_ref,
      'directReceiptJobId',COALESCE(NEW.direct_receipt_job_id,''),'loadName',COALESCE(NEW.planned_load_name,''),
      'directShipCoverageVerified',true));
  RETURN NEW;
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
     WHERE allocation.status='active' AND NEW.order_refs ?| ARRAY[allocation.sales_order_ref,allocation.dispatch_target_ref,po.tranid,po.dispatch_ref]
  LOOP
    IF NOT dispatch_linked_transport_delivery_ready('PO',linked_po.ref) THEN CONTINUE; END IF;
    SELECT job.* INTO evidence FROM driver_job_records job
      WHERE job.status='complete' AND job.stop_type='dropoff' AND job.completed_at IS NOT NULL
        AND (job.order_refs ?| ARRAY[linked_po.tranid,linked_po.dispatch_ref] OR EXISTS (
          SELECT 1 FROM dispatch_so_po_allocations allocation WHERE allocation.po_order_id=linked_po.id AND allocation.status='active'
            AND job.order_refs ?| ARRAY[allocation.sales_order_ref,allocation.dispatch_target_ref]))
      ORDER BY job.completed_at DESC,job.id DESC LIMIT 1;
    PERFORM dispatch_record_order_completion('PO',linked_po.ref,evidence.completed_at,'driver_job',evidence.job_id,
      evidence.plan_id,evidence.plan_date,evidence.load_id,'driver',COALESCE(evidence.driver_login,''),'',
      jsonb_build_object('directPoLink',true,'poOrderId',linked_po.id,'driverJobRecordId',evidence.id,'directShipCoverageVerified',true));
  END LOOP;
  RETURN NEW;
END
$$;

-- Preserve the original event and record why it cannot establish whole-TO
-- completion. A separate legitimate completion event remains effective.
CREATE TABLE IF NOT EXISTS dispatch_direct_ship_completion_corrections (
  completion_event_id bigint PRIMARY KEY REFERENCES dispatch_order_completion_events(id),
  order_ref text NOT NULL, reason text NOT NULL, evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_direct_ship_completion_corrections_immutable ON dispatch_direct_ship_completion_corrections;
CREATE TRIGGER trg_direct_ship_completion_corrections_immutable BEFORE UPDATE OR DELETE ON dispatch_direct_ship_completion_corrections
  FOR EACH ROW EXECUTE FUNCTION mbt_reject_immutable_mutation();

INSERT INTO dispatch_direct_ship_completion_corrections(completion_event_id,order_ref,reason,evidence)
SELECT event.id,event.order_ref,'Direct SO receipt covered only part of the Transfer Order',
  jsonb_build_object('dependencyId',dependency.id,'transferOrderId',dependency.transfer_order_id,
    'originalCompletedAt',event.dispatch_completed_at,'migration','230_direct_ship_lifecycle.sql')
FROM dispatch_order_completion_events event JOIN order_dependencies dependency
  ON dependency.id::text=event.metadata->>'dependencyId'
WHERE event.order_kind='TO' AND event.completion_evidence_type='direct_dependency'
  AND dependency.dependency_mode='direct_to_customer' AND dependency.status='received_local'
  AND dispatch_direct_to_has_residual(dependency.transfer_order_id)
  AND NOT EXISTS (SELECT 1 FROM driver_job_records job WHERE job.status='complete' AND job.stop_type='dropoff'
    AND job.completed_at<=event.dispatch_completed_at AND job.order_refs ? event.order_ref)
  AND NOT (
    EXISTS (SELECT 1 FROM transfer_order_lines line WHERE line.transfer_order_id=dependency.transfer_order_id
      AND line.line_stage='receiving' AND COALESCE(line.netsuite_active,true))
    AND NOT EXISTS (
      SELECT 1 FROM transfer_order_lines line WHERE line.transfer_order_id=dependency.transfer_order_id
        AND line.line_stage='receiving' AND COALESCE(line.netsuite_active,true)
        AND COALESCE(line.quantity,0)>GREATEST(COALESCE(line.netsuite_received_qty,0),
          COALESCE(line.received_pallet_qty,0)*COALESCE(line.to_plt,0)+COALESCE(line.received_layer_qty,0)*COALESCE(line.to_lyr,0)
          +COALESCE(line.received_section_qty,0)*COALESCE(line.to_sec,0)+COALESCE(line.received_piece_qty,0)*COALESCE(NULLIF(line.to_pcs,0),1))+0.000001
    )
  )
ON CONFLICT DO NOTHING;

CREATE OR REPLACE VIEW dispatch_effective_order_completion_events AS
SELECT event.* FROM dispatch_order_completion_events event
WHERE NOT EXISTS (SELECT 1 FROM dispatch_driver_co_identity_corrections correction
  WHERE event.completion_evidence_type='driver_job' AND event.completion_evidence_id=correction.job_id
    AND lower(btrim(event.order_ref))=ANY(dispatch_co_identity_ref_set(correction.original_order_refs)))
  AND NOT EXISTS (SELECT 1 FROM dispatch_direct_ship_completion_corrections correction WHERE correction.completion_event_id=event.id);
