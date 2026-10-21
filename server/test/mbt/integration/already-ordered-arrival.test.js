import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {fixture} from '../helpers/backorder-already-ordered.js';
let f,sequence=0;const poIds=[];
before(async()=>{f=await fixture({sku:88999551});});
after(async()=>{if(f){await f.query('DELETE FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[])',[poIds]);await f.close();}});
async function po(status='Pending Receipt'){
  const id=8899955000+(++sequence),ref='TEST-ARRIVAL-'+id;poIds.push(id);
  await f.query('INSERT INTO purchase_orders(netsuite_id,tranid,netsuite_active,status_text) VALUES($1,$2,true,$3)',[id,ref,status]);return {id,ref};
}
const attach=(d,ref='SOM-ARRIVAL-TEST')=>f.action(d,'sales','already-ordered/sales-order',{salesOrderRef:ref});
const alerts=async role=>(await f.http(role||'sales','/api/sales/stock-requests/alerts')).body;
const received=id=>f.query("UPDATE purchase_orders SET status_text='Fully Received' WHERE netsuite_id=$1",[id]);
const acknowledge=(d,key)=>f.http('sales',`/api/sales/stock-requests/${d.id}/decisions/read`,{eventId:d.manualDecisionEventId,arrivalKey:key});
test('SO reference replaces quotation without reopening Completed and appears in both arrival-filtered queues',async()=>{
  const p=await po();let d=await f.ordered(await f.create(1),0,{poNumber:p.ref});
  d=await f.action(d,'sales','quotation/link',{quotationNumber:'QUOTE-KEEP-HISTORY'});
  const revision=d.revision;d=await attach(d,'  SOM-ARRIVAL-TEST  ');
  assert.equal(d.alreadyOrderedSalesOrderRef,'SOM-ARRIVAL-TEST');assert.equal(d.estimateNumber,'QUOTE-KEEP-HISTORY');
  assert.equal(d.revision,revision+1);assert.equal(d.stage,'completed');assert.equal(d.statusSummary.status,'completed');
  assert.deepEqual(d.statusSummary.waitingReasons,['arrival']);assert.equal(d.salesOrderId,null);
  assert(d.events.some(e=>e.eventType==='backorder_already_ordered_so_attached'));
  for(const role of ['sales','scm']){
    const response=await f.http(role,`/api/${role}/stock-requests?unifiedStatus=completed&waitingReason=arrival&search=${d.requestRef}`);
    assert.equal(response.status,200);assert.equal(response.body.requests.length,1);assert.equal(response.body.requests[0].id,d.id);
  }
  assert.equal((await f.query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[d.id])).rows[0].stage,'completed');
});
test('receipt alerts survive an earlier read, deduplicate after ack, and alert again for the next received PO',async()=>{
  const first=await po(),second=await po();let d=await f.ordered(await f.create(),0,{poNumber:first.ref});d=await f.ordered(d,1,{poNumber:second.ref});d=await attach(d);
  assert.equal((await acknowledge(d,undefined)).status,200);
  assert(!(await alerts()).requests.some(row=>row.id===d.id&&row.action==='arrival'));
  await f.query("UPDATE purchase_orders SET status_text='Partially Received' WHERE netsuite_id=$1",[first.id]);
  assert(!(await alerts()).requests.some(row=>row.id===d.id&&row.action==='arrival'));
  await received(first.id);d=await f.detail(d);
  let notice=(await alerts()).requests.find(row=>row.id===d.id&&row.action==='arrival');assert(notice);assert(notice.message.includes(first.ref));
  assert.equal(d.stage,'completed');assert.deepEqual(d.statusSummary.waitingReasons,['arrival']);
  assert.equal((await acknowledge(d,notice.arrivalKey)).status,200);assert.equal((await acknowledge(d,notice.arrivalKey)).status,200);
  assert(!(await alerts()).requests.some(row=>row.id===d.id&&row.action==='arrival'));
  await received(second.id);const next=(await alerts()).requests.find(row=>row.id===d.id&&row.action==='arrival');assert(next);assert.notEqual(next.arrivalKey,notice.arrivalKey);
  assert.equal((await acknowledge(d,notice.arrivalKey)).status,409);
  assert(!(await alerts('foreign')).requests.some(row=>row.id===d.id));
  d=await f.detail(d);assert.deepEqual(d.statusSummary.waitingReasons,['arrived']);assert.equal(d.statusSummary.status,'completed');
  assert.equal((await acknowledge(d,next.arrivalKey)).status,200);
});
test('SO attachment enforces role, scope, revision, terminal eligibility and atomic concurrent saves',async()=>{
  let d=await f.ordered(await f.create(1));const path=role=>f.path(d,role==='foreign'?'sales':role,'already-ordered/sales-order');
  for(const role of ['foreign','scm'])assert([403,409].includes((await f.http(role,path(role),{expectedRevision:d.revision,salesOrderRef:'SOM-NO'})).status));
  for(const salesOrderRef of ['',null,{},'x'.repeat(121),'SO\nBAD'])assert.equal((await f.http('sales',path('sales'),{expectedRevision:d.revision,salesOrderRef})).status,400);
  const attempts=await Promise.all(['SO-A','SO-B'].map(salesOrderRef=>f.http('sales',path('sales'),{expectedRevision:d.revision,salesOrderRef})));
  assert.deepEqual(attempts.map(row=>row.status).sort(),[200,409]);d=await f.detail(d);assert.equal(d.stage,'completed');
  assert.equal(d.events.filter(e=>e.eventType==='backorder_already_ordered_so_attached').length,1);
  const normal=await f.create(1);assert.equal((await f.http('sales',f.path(normal,'sales','already-ordered/sales-order'),{expectedRevision:normal.revision,salesOrderRef:'SO-NO'})).status,409);
  const closed=await f.action(normal,'sales','close',{reason:'TEST closed'});assert.equal((await f.http('sales',f.path(closed,'sales','already-ordered/sales-order'),{expectedRevision:closed.revision,salesOrderRef:'SO-NO'})).status,409);
});
test('unknown or ambiguous PO references stay waiting and mixed open materials keep their status',async()=>{
  let d=await f.ordered(await f.create(),0,{poNumber:'UNKNOWN-PO'});d=await attach(d);assert.equal(d.stage,'new_enquiry');assert.equal(d.statusSummary.status,'pending_scm');assert.deepEqual(d.statusSummary.waitingReasons,['arrival']);
  const p=await po('Fully Received'),p2=await po('Fully Received');await f.query('UPDATE purchase_orders SET tranid=$2 WHERE netsuite_id=$1',[p2.id,p.ref]);
  let ambiguous=await f.ordered(await f.create(1),0,{poNumber:p.ref});ambiguous=await attach(ambiguous);
  assert.deepEqual(ambiguous.statusSummary.waitingReasons,['arrival']);assert(!(await alerts()).requests.some(row=>row.id===ambiguous.id&&row.action==='arrival'));
});

test('Already Ordered tracks its attached PO before Sales enters an optional SO number',async()=>{
  const p=await po();let d=await f.ordered(await f.create(1),0,{poNumber:p.ref});
  assert.equal(d.alreadyOrderedSalesOrderRef,null);assert.equal(d.statusSummary.status,'completed');assert.deepEqual(d.statusSummary.waitingReasons,['arrival']);
  await received(p.id);d=await f.detail(d);assert.deepEqual(d.statusSummary.waitingReasons,['arrived']);
  const notice=(await alerts()).requests.find(row=>row.id===d.id&&row.action==='arrival');assert(notice);assert(notice.message.includes(p.ref));assert(!notice.message.includes('undefined'));
});
