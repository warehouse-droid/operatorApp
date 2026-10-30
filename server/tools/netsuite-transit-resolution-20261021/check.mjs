// Bundled with the original read-only inventory by check.py.
import assert from 'node:assert/strict';
import {query,closeDb} from './src/db.js';
import {listScmSchedule} from './src/dispatch-repository.js';
import {enrichScmScheduleWithReconciliation} from './src/scm-reconciliation-repository.js';
import {getIfirPostingRestletEnabled} from './src/netsuite-ifir-posting-policy.js';
try {
  const ids=[...BEFORE.purchase,...BEFORE.transfer].map(o=>Number(o.netsuite_id));
  const positiveIds=ids.filter(id=>id>0);
  const snapshots={};
  const reads={
    states:['SELECT * FROM scm_reconciliation_order_state WHERE source_order_netsuite_id=ANY($1::bigint[]) ORDER BY source_order_netsuite_id',positiveIds],
    purchase:['SELECT * FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id',ids],
    transfer:['SELECT * FROM transfer_orders WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id',ids],
    purchaseLines:['SELECT * FROM purchase_order_lines WHERE purchase_order_id=ANY($1::bigint[]) ORDER BY id',ids],
    transferLines:['SELECT * FROM transfer_order_lines WHERE transfer_order_id=ANY($1::bigint[]) ORDER BY id',ids],
    splits:['SELECT * FROM dispatch_scm_po_splits WHERE source_po_id=ANY($1::bigint[]) ORDER BY id',positiveIds],
    splitLines:['SELECT l.* FROM dispatch_scm_po_split_lines l JOIN dispatch_scm_po_splits s ON s.id=l.split_id WHERE s.source_po_id=ANY($1::bigint[]) ORDER BY l.id',positiveIds],
    loads:['SELECT id,load_type,order_family,order_id,order_ref,loaded_qty,loaded_uom,line_snapshot,response,created_at FROM operator_load_records WHERE order_id=ANY($1::bigint[]) ORDER BY id',ids],
    receipts:['SELECT id,order_id,item_receipt_id,item_receipt_tranid,receipt_status,payload,response,created_at FROM receiving_receipt_records WHERE order_id=ANY($1::bigint[]) ORDER BY id',ids],
    drivers:[`SELECT id,job_id,plan_id,plan_date,load_id,stop_id,stop_type,order_refs,status,completed_at,started_at,job_details,mbt_assignment_withdrawn_at
      FROM driver_job_records WHERE order_refs ?| $1::text[] ORDER BY id`,BEFORE.refs],
    storedSchedule:["SELECT * FROM scm_transport_schedule WHERE order_kind IN ('PO','TO') AND (order_ref=ANY($1::text[]) OR display_ref=ANY($1::text[])) ORDER BY id",BEFORE.refs]
  };
  for(const [key,[sql,params]] of Object.entries(reads)) snapshots[key]=(await query(sql,[params])).rows;
  const schedule=await listScmSchedule({kind:['PO','TO'],status:'In Transit'});
  const targetSchedule=await listScmSchedule({kind:['PO','TO'],exactRefs:BEFORE.refs});
  const enriched=await enrichScmScheduleWithReconciliation(targetSchedule,{includeDetails:true});
  const restletEnabled=await getIfirPostingRestletEnabled();
  const result={at:new Date().toISOString(),mode:MODE,restletEnabled,schedule,targetSchedule:enriched,...snapshots};
  console.log(JSON.stringify(result));
  assert.equal(restletEnabled,false);
  if(MODE==='verify') {
    assert.equal(schedule.length,0,'No displayed PO/TO should still be in transit.');
    assert.equal(snapshots.states.length,positiveIds.length);
    for(const state of snapshots.states) {
      assert.equal(state.application_status,'Completed',state.source_order_ref);
      assert.notEqual(state.reconciliation_status,'review',state.source_order_ref);
    }
    for(const ref of ['TOB01227','LOINC-039408']) {
      const row=enriched.find(r=>r.orderRef===ref);assert.ok(row,ref);
      assert.equal(row.calculatedStatus,'Completed',ref);
    }
    const stable=rows=>JSON.parse(JSON.stringify(rows)).sort((a,b)=>Number(a.id)-Number(b.id));
    assert.deepEqual(stable(snapshots.loads),stable(BEFORE.evidence.loads),'Physical load records must remain unchanged.');
    assert.deepEqual(stable(snapshots.receipts),stable(BEFORE.evidence.receipts),'Physical receiving records must remain unchanged.');
    assert.deepEqual(stable(snapshots.drivers),stable(BEFORE.evidence.drivers),'Driver history must remain unchanged.');
    const originalSplitLines=BEFORE.evidence.purchaseLines.filter(r=>Number(r.purchase_order_id)<0);
    for(const original of originalSplitLines) {
      const current=snapshots.purchaseLines.find(r=>r.id===original.id);assert.ok(current);
      for(const key of ['line_id','item_id','quantity','unit','pallet_qty','layer_qty','piece_qty','section_qty','netsuite_active'])
        assert.equal(current[key],original[key],`Preserve ${original.id} ${key}`);
    }
    for(const order of snapshots.transfer) assert.equal(order.receiving_status,'received',order.tranid);
    assert.equal(snapshots.purchase.find(o=>o.tranid==='LOINC-039408').receipt_status,'received');
  }
} finally {await closeDb();}
