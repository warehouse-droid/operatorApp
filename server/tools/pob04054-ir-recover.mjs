// Bounded operational repair. Run inside the live application using docker exec.
// Default is read-only; recovery uses the normal durable IR pipeline.
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {query,withTransaction,closeDb} from '/app/src/db.js';
import {createDirectPoSourceFetcher,prepareDirectPoReceiptJob} from '/app/src/direct-po-auto-receipt.js';
import {operatorNetSuitePostingRuntime} from '/app/src/operator-netsuite-posting-runtime.js';
import {fetchItemReceiptFromNetSuite} from '/app/src/netsuite.js';

const mode=process.env.POB04054_MODE||'inspect';
assert(['inspect','recover','verify'].includes(mode));
const poId=1064064,pickId=7399,dropId=7403,group='GOA-10208-10209S1';
const expectedAllocations=[[450,545052,27],[451,545043,1614.24],[452,545044,126.6],[453,545045,1],
  [454,545046,127.44],[455,545047,8],[456,545049,78.75],[457,545050,20],[458,545051,1]];
// REST line, immutable NetSuite line key, item, quantity.
const expectedLines=[[1,'5137561',2055,1614.24],[2,'5137562',2055,126.6],[3,'5137563',2055,1],
  [4,'5137564',2055,127.44],[5,'5137565',2055,8],[7,'5137567',2055,78.75],
  [8,'5137568',2055,20],[9,'5137569',2055,1],[10,'5137570',1784,27]];
const fetchSource=createDirectPoSourceFetcher();
async function fingerprints() {
  return (await query(`SELECT
    (SELECT md5(jsonb_agg(to_jsonb(j) ORDER BY id)::text) FROM driver_job_records j WHERE id IN (7399,7403)) AS jobs,
    (SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY id)::text) FROM dispatch_so_po_allocations a WHERE po_order_id=1064064) AS allocations,
    (SELECT md5(jsonb_agg(to_jsonb(s) ORDER BY split_ref)::text) FROM dispatch_global_order_splits s WHERE split_ref IN ('SOA10209-S1','SOA10209-S2')) AS splits,
    (SELECT md5(jsonb_agg(to_jsonb(s) ORDER BY netsuite_id)::text) FROM sales_orders s WHERE netsuite_id=-265738537252212) AS sibling,
    (SELECT md5(jsonb_agg(to_jsonb(e) ORDER BY id)::text) FROM dispatch_so_po_allocation_execution_events e WHERE id BETWEEN 242 AND 257) AS existing_events`)).rows[0];
}
function assertSource(source,received) {
  assert.equal(Number(source.sourceNetSuiteId),poId);
  const lines=[...source.lines].sort((a,b)=>Number(a.restOrderLine)-Number(b.restOrderLine));
  assert.deepEqual(lines.map(l=>[Number(l.restOrderLine),String(l.sourceLineKey),Number(l.itemId),Number(l.orderedQuantity??l.quantity)]),expectedLines);
  for(const line of lines) {
    assert.equal(line.identityStatus,'exact');assert.equal(Number(line.location),28);
    assert.equal(Number(line.completedQuantity),received?Number(line.orderedQuantity??line.quantity):0);
    assert.equal(Number(line.remainingQuantity),received?0:Number(line.orderedQuantity??line.quantity));
    if(!received) assert.equal(line.linkedTransactions?.length||0,0,'An existing receipt requires reconciliation, never blind reposting');
  }
}
async function jobs() {
  return (await query(`SELECT j.id,j.status AS job_status,j.command_id,c.status,c.last_error,
    s.netsuite_transaction_id,s.netsuite_transaction_ref,po.receipt_status,po.last_item_receipt_id
    FROM dispatch_direct_po_ir_jobs j LEFT JOIN operator_netsuite_posting_commands c ON c.id=j.command_id
    LEFT JOIN operator_netsuite_posting_steps s ON s.command_id=c.id
    JOIN purchase_orders po ON po.netsuite_id=j.local_po_id WHERE j.local_po_id=$1 ORDER BY j.created_at`,[poId])).rows;
}
try {
  const before=await fingerprints(),prior=await jobs();
  console.log(JSON.stringify({event:'inspect',mode,fingerprints:before,jobs:prior}));
  if(mode==='inspect' || (mode==='recover' && !prior.length)) {
    const source=await fetchSource({sourceOrderKind:'PO',sourceNetSuiteId:poId});assertSource(source,false);
    console.log(JSON.stringify({event:'live-source-verified',po:poId,lines:expectedLines}));
  }
  if(mode==='recover' && !prior.length) {
    const admitted=await withTransaction(async()=>{
      await query("SET LOCAL lock_timeout='5s'");await query("SET LOCAL statement_timeout='60s'");
      await query("SELECT pg_advisory_xact_lock(hashtext('pob04054-ir-recovery'))");
      const po=(await query('SELECT tranid,dispatch_ref,receipt_status,last_item_receipt_id FROM purchase_orders WHERE netsuite_id=$1 FOR UPDATE',[poId])).rows[0];
      assert.deepEqual(po,{tranid:'POB04054',dispatch_ref:'LOINC-040399',receipt_status:'not_received',last_item_receipt_id:null});
      assert.equal((await jobs()).length,0);
      assert.equal((await query('SELECT id FROM operator_netsuite_posting_steps WHERE source_netsuite_id=$1',[poId])).rowCount,0);
      const allocations=(await query("SELECT id,po_line_id,allocated_sales_qty,dispatch_target_ref FROM dispatch_so_po_allocations WHERE po_order_id=$1 AND status='active' ORDER BY id FOR UPDATE",[poId])).rows;
      assert.deepEqual(allocations.map(a=>[Number(a.id),Number(a.po_line_id),Number(a.allocated_sales_qty)]),expectedAllocations);
      assert(allocations.every(a=>a.dispatch_target_ref===group));
      const records=(await query('SELECT id,job_id,plan_id,load_id,stop_type,status,completed_at,order_refs FROM driver_job_records WHERE id=ANY($1::bigint[]) ORDER BY id FOR SHARE',[[pickId,dropId]])).rows;
      assert.equal(records.length,2);
      for(const [index,record] of records.entries()) {
        assert.equal(record.status,'complete');assert.equal(record.stop_type,index===0?'pickup':'dropoff');assert.equal(Number(record.plan_id),369);
        assert.equal(record.load_id,'T4-L1792959816572-c7545ac483e5d8');
        assert.deepEqual([...record.order_refs].sort(),['SOA10208','SOA10209-S1']);
        assert.equal(record.completed_at.toISOString(),index===0?'2026-10-26T13:08:32.533Z':'2026-10-26T14:22:12.899Z');
      }
      const completions=(await query('SELECT id,order_ref,completion_evidence_id FROM dispatch_effective_order_completion_events WHERE id=ANY($1::bigint[]) ORDER BY id',[[82787,82788,82789]])).rows;
      assert.deepEqual(completions.map(e=>[Number(e.id),e.order_ref]),[[82787,'SOA10208'],[82788,'SOA10209-S1'],[82789,'LOINC-040399']]);
      assert(completions.every(e=>e.completion_evidence_id===records[1].job_id));
      assert.equal((await query("SELECT id FROM driver_job_corrections WHERE action='reopen' AND (driver_job_record_id=ANY($1::bigint[]) OR result->'physicalVisitJobIds' ?| $2::text[])",[[pickId,dropId],records.map(r=>r.job_id)])).rowCount,0);
      assert.deepEqual(await fingerprints(),before);
      // Read again immediately before admission; the adapter revalidates at transform time.
      const live=await fetchSource({sourceOrderKind:'PO',sourceNetSuiteId:poId});assertSource(live,false);
      await query('SELECT dispatch_record_so_po_allocation_execution($1)',[pickId]);
      await query('SELECT dispatch_record_so_po_allocation_execution($1)',[dropId]);
      const events=(await query('SELECT phase,driver_job_record_id,allocated_sales_qty FROM dispatch_so_po_allocation_execution_events WHERE allocation_id=450 ORDER BY id')).rows;
      assert.deepEqual(events.map(e=>[e.phase,Number(e.driver_job_record_id),Number(e.allocated_sales_qty)]),[['pickup',pickId,27],['delivered',dropId,27]]);
      const discovered=await jobs();assert.equal(discovered.length,1);
      const ready=await prepareDirectPoReceiptJob(discovered[0].id,{fetchSource:async()=>live});
      assert(ready?.command,'Receipt must be admitted normally');assert.equal(ready.command.steps.length,1);
      assert.deepEqual(ready.command.steps[0].payload.item.items,
        expectedLines.map(([orderLine,,,quantity])=>({orderLine,quantity,itemReceive:true,location:28})));
      assert.equal(ready.command.inputSnapshot.directDeliveryEvidence.deliveryJobRecordId,dropId);
      assert.equal(ready.command.inputSnapshot.directDeliveryEvidence.executionEventIds.length,9);
      assert.equal((await query('SELECT allocation_id FROM dispatch_direct_po_ir_allocation_claims WHERE job_id=$1',[ready.id])).rowCount,9);
      assert.deepEqual(await fingerprints(),before);
      console.log(JSON.stringify({event:'admitted',job:ready.id,command:ready.command.id,lines:ready.command.steps[0].payload.item.items}));
      return ready.command.id;
    });
    await operatorNetSuitePostingRuntime.enqueue(admitted);
  } else if(mode==='recover') {
    assert.equal(prior.length,1);assert(prior[0].command_id,'Existing unadmitted job requires investigation');
    if(prior[0].status!=='completed') await operatorNetSuitePostingRuntime.enqueue(prior[0].command_id);
  }
  if(mode==='recover' || mode==='verify') {
    let result=await jobs();
    for(let attempt=0;attempt<30 && result.some(j=>['queued','posting','finalizing','retry_wait'].includes(j.status));attempt++) {await delay(1000);result=await jobs();}
    console.log(JSON.stringify({event:'posting-result',jobs:result}));
    assert.equal(result.length,1);assert.equal(result[0].status,'completed',result[0].last_error);
    assert.equal(result[0].receipt_status,'received');
    assert.equal(String(result[0].last_item_receipt_id),String(result[0].netsuite_transaction_id));
    const receipt=await fetchItemReceiptFromNetSuite(result[0].netsuite_transaction_id);
    assert.equal(Number(receipt.createdFrom?.id),poId);
    const lines=(receipt.item?.items||[]).filter(l=>l.itemReceive!==false && Number(l.quantity)>0).sort((a,b)=>Number(a.orderLine)-Number(b.orderLine));
    assert.deepEqual(lines.map(l=>[Number(l.orderLine),Number(l.item?.id),Number(l.quantity)]),expectedLines.map(([line,,item,qty])=>[line,item,qty]));
    assert.deepEqual(await fingerprints(),before);
    console.log(JSON.stringify({event:'verified-receipt',id:receipt.id,ref:receipt.tranId,po:poId,lines:lines.map(l=>({line:l.orderLine,item:l.item?.id,quantity:l.quantity})),fingerprints:before}));
  }
} finally {await closeDb();}
