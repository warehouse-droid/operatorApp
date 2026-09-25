-- TOB00025 has two internal IDs. NetSuite ID 777039 is absent; 799386 is Received.
-- Run only after fresh SELECT-only NetSuite verification of both IDs.
-- The caller supplies BEGIN and either ROLLBACK (rehearsal) or COMMIT (apply).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
SELECT pg_advisory_xact_lock(hashtext('dispatch_fleet_planning_mutation'));
DO $repair$
DECLARE
  obsolete transfer_orders%ROWTYPE;
  canonical transfer_orders%ROWTYPE;
  before_headers jsonb;
  before_lines jsonb;
  before_states jsonb;
  current_headers jsonb;
  current_lines jsonb;
  current_states jsonb;
BEGIN
  SELECT * INTO STRICT obsolete FROM transfer_orders WHERE netsuite_id=777039 FOR UPDATE;
  SELECT * INTO STRICT canonical FROM transfer_orders WHERE netsuite_id=799386 FOR UPDATE;
  PERFORM id FROM transfer_order_lines WHERE transfer_order_id IN (777039,799386) ORDER BY id FOR UPDATE;
  PERFORM id FROM scm_reconciliation_order_state WHERE order_kind='TO'
    AND source_order_netsuite_id IN (777039,799386) ORDER BY id FOR UPDATE;
  IF obsolete.tranid <> 'TOB00025' OR canonical.tranid <> 'TOB00025'
    OR obsolete.memo <> 'Inventory dependency for TSTDEP-SO-005 | MBBS dependency batch 9'
    OR obsolete.outbound_operator_status <> 'open' OR obsolete.fulfillment_status <> 'not_fulfilled'
    OR obsolete.receiving_status <> 'not_received' OR obsolete.dispatch_planned
    OR COALESCE(obsolete.local_yard_order_status,'Open') <> 'Open'
    OR obsolete.preparing_operator_id IS NOT NULL
    OR canonical.status <> 'G' OR canonical.fulfillment_status <> 'fulfilled'
    OR canonical.receiving_status <> 'received' OR NOT canonical.netsuite_active THEN
    RAISE EXCEPTION 'Order identity or lifecycle changed; stop cleanup';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM scm_reconciliation_order_state WHERE order_kind='TO'
      AND source_order_netsuite_id=777039 AND netsuite_terminal_state='missing'
      AND missing_success_count>=2 AND broad_reconciliation_skipped)
    OR NOT EXISTS (SELECT 1 FROM scm_reconciliation_order_state WHERE order_kind='TO'
      AND source_order_netsuite_id=799386 AND application_status='Completed' AND remaining_qty=0)
    THEN RAISE EXCEPTION 'Reconciliation proof changed; stop cleanup'; END IF;
  IF EXISTS (SELECT 1 FROM transfer_order_lines WHERE transfer_order_id=777039 AND (
      COALESCE(loaded_qty,0)<>0 OR COALESCE(packed_pallet_qty,0)<>0 OR COALESCE(packed_layer_qty,0)<>0
      OR COALESCE(packed_section_qty,0)<>0 OR COALESCE(packed_piece_qty,0)<>0 OR COALESCE(packed_sales_qty,0)<>0
      OR COALESCE(received_pallet_qty,0)<>0 OR COALESCE(received_layer_qty,0)<>0 OR COALESCE(received_section_qty,0)<>0
      OR COALESCE(received_piece_qty,0)<>0 OR COALESCE(received_sales_qty,0)<>0 OR COALESCE(netsuite_received_qty,0)<>0))
    OR EXISTS (SELECT 1 FROM order_dependencies WHERE transfer_order_id=777039)
    OR EXISTS (SELECT 1 FROM delivery_fulfillment_records WHERE order_id=777039)
    OR EXISTS (SELECT 1 FROM receiving_receipt_records WHERE order_id=777039)
    OR EXISTS (SELECT 1 FROM dispatch_scm_to_splits WHERE source_to_id=777039 OR split_to_id=777039)
    OR EXISTS (SELECT 1 FROM driver_job_records WHERE order_refs ? 'TOB00025')
    OR EXISTS (SELECT 1 FROM local_co_orders WHERE source_order_ref='TOB00025')
    OR EXISTS (SELECT 1 FROM dispatch_plan_snapshots s JOIN dispatch_plans p ON p.id=s.plan_id
      WHERE p.status<>'cancelled' AND jsonb_path_exists(s.trucks,
        '$[*].loads[*].stops[*] ? (@.orderId == "TOB00025")'))
    OR EXISTS (SELECT 1 FROM scm_transport_schedule WHERE order_kind='TO' AND source_id=777039
      AND status IN ('Planned','Partially Done','In Transit','Completed')) THEN
    RAISE EXCEPTION 'Operational activity exists; stop cleanup';
  END IF;
  SELECT jsonb_agg(to_jsonb(t) ORDER BY netsuite_id) INTO before_headers FROM transfer_orders t
    WHERE netsuite_id<>777039;
  SELECT jsonb_agg(to_jsonb(l) ORDER BY id) INTO before_lines FROM transfer_order_lines l
    WHERE transfer_order_id IN (777039,799386);
  SELECT jsonb_agg(to_jsonb(s) ORDER BY id) INTO before_states FROM scm_reconciliation_order_state s
    WHERE order_kind='TO' AND source_order_netsuite_id IN (777039,799386);
  IF obsolete.netsuite_active THEN
    UPDATE transfer_orders SET netsuite_active=false WHERE netsuite_id=777039;
    INSERT INTO dispatch_audit_log(action,entity_type,entity_id,order_id,operator_name,source,before_state,after_state,details)
      VALUES('obsolete_transfer_local_cache_retired','transfer_order','777039','TOB00025','Codex maintenance',
        'operator_duplicate_cleanup',to_jsonb(obsolete),to_jsonb(obsolete)||'{"netsuite_active":false}'::jsonb,
        '{"canonicalNetSuiteId":799386,"reason":"Obsolete ID absent from fresh NetSuite lookup; same-number canonical TO is Received. Six prior missing lookups and explicit obsolete-duplicate reconciliation note. Only the local active flag changes."}'::jsonb);
  END IF;
  SELECT jsonb_agg(to_jsonb(t) ORDER BY netsuite_id) INTO current_headers FROM transfer_orders t
    WHERE netsuite_id<>777039;
  SELECT jsonb_agg(to_jsonb(l) ORDER BY id) INTO current_lines FROM transfer_order_lines l
    WHERE transfer_order_id IN (777039,799386);
  SELECT jsonb_agg(to_jsonb(s) ORDER BY id) INTO current_states FROM scm_reconciliation_order_state s
    WHERE order_kind='TO' AND source_order_netsuite_id IN (777039,799386);
  IF before_headers IS DISTINCT FROM current_headers OR before_lines IS DISTINCT FROM current_lines
    OR before_states IS DISTINCT FROM current_states THEN RAISE EXCEPTION 'Protected data changed; rollback'; END IF;
  IF (SELECT to_jsonb(t) FROM transfer_orders t WHERE netsuite_id=777039)
    IS DISTINCT FROM (to_jsonb(obsolete)||'{"netsuite_active":false}'::jsonb)
    THEN RAISE EXCEPTION 'Unexpected obsolete-row change; rollback'; END IF;
END
$repair$;
SELECT jsonb_build_object('obsoleteId',777039,'obsoleteActive',
  (SELECT netsuite_active FROM transfer_orders WHERE netsuite_id=777039),
  'canonicalId',799386,'canonicalFulfillment',
  (SELECT fulfillment_status FROM transfer_orders WHERE netsuite_id=799386),
  'canonicalReceiving',(SELECT receiving_status FROM transfer_orders WHERE netsuite_id=799386));
