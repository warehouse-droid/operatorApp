-- Run with psql -X -v ON_ERROR_STOP=1 -v apply=false (rollback rehearsal),
-- then apply=true only after preserving a verified private database backup.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('dispatch_fleet_planning_mutation'));

DO $cleanup$
DECLARE
  refs text[] := ARRAY['TOA-CO-DEPENDENCY-0FB08978','TOA-GLOBAL-PICKUP-0FB08978',
    'SOA-CO-DEPENDENCY-0FB08978','CO-TOA-CO-DEPENDENCY-0FB08978','CO-TOA-GLOBAL-PICKUP-0FB08978'];
  ids bigint[] := ARRAY[6526455536,6526455537,7000263227768,-146,-147]::bigint[];
  fk record;
  parent_ids bigint[];
  child_count bigint;
  deleted_count bigint;
BEGIN
  PERFORM 1 FROM transfer_orders WHERE netsuite_id IN (6526455537,7000263227768) FOR UPDATE;
  PERFORM 1 FROM sales_orders WHERE netsuite_id=6526455536 FOR UPDATE;
  PERFORM 1 FROM local_co_orders WHERE id IN (146,147) FOR UPDATE;
  PERFORM 1 FROM order_dependencies WHERE id=236 FOR UPDATE;

  IF NOT EXISTS (SELECT FROM transfer_orders WHERE tranid=ANY(refs) OR netsuite_id=ANY(ids))
     AND NOT EXISTS (SELECT FROM sales_orders WHERE tranid=ANY(refs) OR netsuite_id=6526455536)
     AND NOT EXISTS (SELECT FROM local_co_orders WHERE co_ref=ANY(refs) OR id IN (146,147)) THEN
    RAISE NOTICE 'Already removed; no changes.';
    RETURN;
  END IF;

  IF (SELECT count(*) FROM transfer_orders WHERE
      (netsuite_id,tranid) IN ((6526455537::bigint,'TOA-CO-DEPENDENCY-0FB08978'),
        (7000263227768::bigint,'TOA-GLOBAL-PICKUP-0FB08978'))
      AND trandate='2026-09-03' AND synced_at IS NULL AND NOT dispatch_planned
      AND fulfilled_at IS NULL AND received_at IS NULL AND preparing_started_at IS NULL
      AND fulfillment_status='not_fulfilled' AND outbound_operator_status='open') <> 2 THEN
    RAISE EXCEPTION 'Transfer identity/provenance or unused-state guard failed';
  END IF;
  IF (SELECT count(*) FROM sales_orders WHERE netsuite_id=6526455536
      AND tranid='SOA-CO-DEPENDENCY-0FB08978' AND is_test_fixture
      AND customer='CO dependency routing fixture' AND dispatch_planned IS NOT TRUE
      AND synced_at IS NULL
      AND fulfillment_status='not_fulfilled') <> 1 THEN
    RAISE EXCEPTION 'Linked sales fixture guard failed';
  END IF;
  IF (SELECT count(*) FROM local_co_orders WHERE
      (id,co_ref,source_order_ref) IN
      ((146::bigint,'CO-TOA-CO-DEPENDENCY-0FB08978','TOA-CO-DEPENDENCY-0FB08978'),
       (147::bigint,'CO-TOA-GLOBAL-PICKUP-0FB08978','TOA-GLOBAL-PICKUP-0FB08978'))
      AND loaded_at IS NULL AND received_at IS NULL AND preparing_started_at IS NULL
      AND dispatch_plan_id IS NULL AND status IN ('cancelled','pending_load')
      AND ((id=146 AND details->>'testOnly'='true')
        OR (id=147 AND created_by='global-pickup-0FB08978'))) <> 2 THEN
    RAISE EXCEPTION 'Linked CO fixture guard failed';
  END IF;
  IF (SELECT count(*) FROM order_dependencies WHERE id=236
      AND sales_order_id=6526455536 AND transfer_order_id=6526455537
      AND sales_order_ref='SOA-CO-DEPENDENCY-0FB08978'
      AND transfer_order_ref='TOA-CO-DEPENDENCY-0FB08978'
      AND planned_plan_id IS NULL AND local_completed_at IS NULL
      AND direct_received_at IS NULL AND proposal_id IS NULL) <> 1 THEN
    RAISE EXCEPTION 'Dependency identity/execution guard failed';
  END IF;
  IF (SELECT count(*) FROM transfer_order_lines WHERE transfer_order_id IN (6526455537,7000263227768)) <> 1
     OR (SELECT count(*) FROM transfer_order_lines WHERE transfer_order_id=7000263227768
       AND line_id=7000263227769 AND sku='GLOBAL-CO-0FB08978' AND quantity=10
       AND COALESCE(loaded_qty,0)=0 AND packed_sales_qty=0 AND received_sales_qty=0
       AND COALESCE(packed_pallet_qty,0)=0 AND COALESCE(received_pallet_qty,0)=0
       AND COALESCE(netsuite_received_qty,0)=0
       AND COALESCE(packed_layer_qty,0)=0 AND COALESCE(packed_piece_qty,0)=0
       AND COALESCE(packed_section_qty,0)=0 AND COALESCE(received_layer_qty,0)=0
       AND COALESCE(received_piece_qty,0)=0 AND COALESCE(received_section_qty,0)=0
       AND fulfilled_pallet_qty=0 AND fulfilled_layer_qty=0
       AND fulfilled_piece_qty=0 AND fulfilled_section_qty=0
       AND confirmed_at IS NULL) <> 1
     OR EXISTS (SELECT FROM sales_order_lines WHERE sales_order_id=6526455536)
     OR (SELECT count(*) FROM local_co_order_lines WHERE co_id IN (146,147)) <> 1
     OR (SELECT count(*) FROM local_co_order_lines WHERE co_id=147 AND id=487
       AND sku='GLOBAL-CO-0FB08978' AND quantity=10 AND confirmed_at IS NULL
       AND packed_sales_qty=0 AND received_sales_qty=0
       AND packed_pallet_qty=0 AND received_pallet_qty=0) <> 1 THEN
    RAISE EXCEPTION 'Fixture cargo identity/execution guard failed';
  END IF;

  -- Reject every unreviewed FK cascade, including new child tables added later.
  FOR fk IN SELECT c.conrelid::regclass AS child_table,c.confrelid::regclass AS parent_table,
      a.attname AS child_column,array_length(c.conkey,1) AS key_count
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
    WHERE c.contype='f' AND c.confrelid IN ('transfer_orders'::regclass,'sales_orders'::regclass,
      'local_co_orders'::regclass,'order_dependencies'::regclass)
  LOOP
    IF fk.key_count <> 1 THEN RAISE EXCEPTION 'Unreviewed composite FK: %',fk.child_table; END IF;
    parent_ids := CASE fk.parent_table::text
      WHEN 'transfer_orders' THEN ARRAY[6526455537,7000263227768]::bigint[]
      WHEN 'sales_orders' THEN ARRAY[6526455536]::bigint[]
      WHEN 'local_co_orders' THEN ARRAY[146,147]::bigint[]
      WHEN 'order_dependencies' THEN ARRAY[236]::bigint[] END;
    EXECUTE format('SELECT count(*) FROM %s WHERE %I=ANY($1)',fk.child_table,fk.child_column)
      INTO child_count USING parent_ids;
    IF child_count <> (CASE WHEN fk.child_table::text IN ('order_dependencies','local_co_order_lines') THEN 1 ELSE 0 END) THEN
      RAISE EXCEPTION 'Unreviewed related rows in %: %',fk.child_table,child_count;
    END IF;
  END LOOP;

  IF EXISTS (SELECT FROM dispatch_plan_order_assignments WHERE order_ref=ANY(refs) OR planned_order_ref=ANY(refs))
    OR EXISTS (SELECT FROM driver_job_records WHERE order_refs::text LIKE ANY(ARRAY(SELECT '%'||r||'%' FROM unnest(refs) r)))
    OR EXISTS (SELECT FROM dispatch_plan_snapshots WHERE trucks::text LIKE ANY(ARRAY(SELECT '%'||r||'%' FROM unnest(refs) r)))
    OR EXISTS (SELECT FROM dispatch_order_completion_events WHERE order_ref=ANY(refs))
    OR EXISTS (SELECT FROM receiving_receipt_records WHERE order_id=ANY(ids))
    OR EXISTS (SELECT FROM delivery_fulfillment_records WHERE order_id=ANY(ids))
    OR EXISTS (SELECT FROM scm_transport_schedule WHERE order_ref=ANY(refs))
    OR EXISTS (SELECT FROM scm_schedule_group_members WHERE order_ref=ANY(refs))
    OR EXISTS (SELECT FROM dispatch_global_order_group_members WHERE member_order_ref=ANY(refs)) THEN
    RAISE EXCEPTION 'Operational references exist; removal aborted';
  END IF;

  DELETE FROM dispatch_order_catalog_refresh_outbox WHERE order_ref=ANY(refs);
  DELETE FROM dispatch_order_catalog_entries WHERE order_ref=ANY(refs);
  GET DIAGNOSTICS deleted_count=ROW_COUNT;
  RAISE NOTICE 'Removed % catalog entries',deleted_count;
  DELETE FROM order_dependencies WHERE id=236;
  DELETE FROM transfer_order_lines WHERE transfer_order_id IN (6526455537,7000263227768);
  DELETE FROM transfer_orders WHERE netsuite_id IN (6526455537,7000263227768);
  DELETE FROM local_co_orders WHERE id IN (146,147);
  DELETE FROM sales_orders WHERE netsuite_id=6526455536;

  IF EXISTS (SELECT FROM co_orders WHERE id IN (146,147))
    OR EXISTS (SELECT FROM co_order_lines WHERE co_id IN (146,147))
    OR EXISTS (SELECT FROM local_co_order_lines WHERE co_id IN (146,147)) THEN
    RAISE EXCEPTION 'Canonical CO cleanup did not complete';
  END IF;
  UPDATE dispatch_order_catalog_state SET generation=generation+1,
    catalog_count=(SELECT count(*) FROM dispatch_order_catalog_entries),updated_at=now()
    WHERE singleton=true;
  INSERT INTO delivery_audit_log(actor_type,source,action,details)
    VALUES ('system','authorized-test-fixture-cleanup','test_fixture_orders_removed',
      jsonb_build_object('suffix','0FB08978','orderRefs',refs,'transferIds',ARRAY[6526455537,7000263227768]::bigint[],
        'salesFixtureId',6526455536::bigint,'coIds',ARRAY[146,147],
        'authorization','User requested removal of the two identified automated test orders',
        'backup','schedule-columns-20260910/before-fixture-removal.dump',
        'historicalSnapshots','Preserved; no route stops reference these fixtures'));
  RAISE NOTICE 'Removed 2 transfer fixtures, 1 synthetic sales order, 1 dependency, 2 COs and their synthetic cargo';
END
$cleanup$;
\if :apply
COMMIT;
\else
ROLLBACK;
\endif
