import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {readFileSync} from 'node:fs';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {withTransaction} from '../../../src/db.js';
import {acknowledgeBackorderAlert} from '../../../src/backorder-request-service.js';
let f,sequence=0;const poIds=[],soId=8899957999,requestIds=[];
before(async()=>{f=await fixture({sku:88999553});});
after(async()=>{if(f){await f.query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[requestIds]);await f.query('DELETE FROM sales_orders WHERE netsuite_id=$1',[soId]);await f.query('DELETE FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[])',[poIds]);await f.close();}});
async function po(status='Fully Received'){
  const id=8899957000+(++sequence),ref='TEST-ARRIVAL-INTEGRITY-'+id;poIds.push(id);
  await f.query('INSERT INTO purchase_orders(netsuite_id,tranid,netsuite_active,status_text) VALUES($1,$2,true,$3)',[id,ref,status]);return {id,ref};
}
const alerts=async()=> (await f.http('sales','/api/sales/stock-requests/alerts')).body.requests;
const ack=(d,arrivalKey,eventId=d.revision)=>f.http('sales',`/api/sales/stock-requests/${d.id}/decisions/read`,{eventId,arrivalKey});
test('canonical receipt quantities drive arrival while drafts, inactive POs and GET requests cannot change business state',async()=>{
  const p=await po('Billed');let d=await f.ordered(await f.create(1),0,{poNumber:p.ref.toLowerCase()});
  const revision=d.revision,events=d.events.length;
  await f.query('INSERT INTO purchase_order_lines(purchase_order_id,line_id,quantity,netsuite_received_qty,received_sales_qty) VALUES($1,1,10,9,10),($1,2,2,2,0)',[p.id]);
  d=await f.detail(d);assert.equal(d.alreadyOrderedArrival.status,'arrival');assert(!(await alerts()).some(row=>row.id===d.id&&row.action==='arrival'));
  await f.query('UPDATE purchase_order_lines SET netsuite_received_qty=quantity WHERE purchase_order_id=$1',[p.id]);
  d=await f.detail(d);assert.equal(d.alreadyOrderedArrival.status,'arrived');assert((await alerts()).some(row=>row.id===d.id&&row.action==='arrival'));
  assert.equal(d.revision,revision);assert.equal(d.events.length,events);
  await f.query('UPDATE purchase_orders SET netsuite_active=false WHERE netsuite_id=$1',[p.id]);
  d=await f.detail(d);assert.equal(d.alreadyOrderedArrival.status,'arrival');assert(!(await alerts()).some(row=>row.id===d.id&&row.action==='arrival'));
});
test('receipt acknowledgements validate displayed keys and requester while legacy revision acknowledgements preserve them',async()=>{
  const p=await po();let d=await f.ordered(await f.create(1),0,{poNumber:p.ref});
  const key=d.alreadyOrderedArrival.key;assert(key);
  for(const invalid of [null,'',{},'not-a-key','a'.repeat(65)])assert.equal((await ack(d,invalid)).status,400);
  assert.equal((await ack(d,key,d.revision+1)).status,400);
  await assert.rejects(acknowledgeBackorderAlert(d.id,d.revision,{operatorId:f.users.foreign.id,authorizedDestinationLocationIds:[1]},key),error=>error.status===403);
  assert.equal((await ack(d,key)).status,200);assert.equal((await ack(d,undefined)).status,200);
  assert.equal((await f.query('SELECT backorder_arrival_key FROM regular_stock_decision_reads WHERE request_id=$1',[d.id])).rows[0].backorder_arrival_key,key);
  d=await f.action(d,'sales','already-ordered/sales-order',{salesOrderRef:'SO-CHANGED-REFERENCE'});
  assert.equal((await ack(d,key)).status,409);assert((await alerts()).some(row=>row.id===d.id&&row.action==='arrival'));
});
test('a linked canonical SO cannot be replaced by a conflicting optional reference',async()=>{
  let d=await f.review(await f.create(1));requestIds.push(d.id);
  d=await f.action(d,'sales',`lines/${d.lines[0].id}/decision`,{decision:'accepted'});
  await f.query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,order_location_id,netsuite_active) VALUES($1,'TEST-ARRIVAL-CANONICAL-SO',18,1,true)",[soId]);
  d=await f.action(d,'sales','sales-order/link',{salesOrderRef:'TEST-ARRIVAL-CANONICAL-SO'});d=await f.ordered(d);
  const conflict=await f.http('sales',f.path(d,'sales','already-ordered/sales-order'),{expectedRevision:d.revision,salesOrderRef:'SO-CONFLICT'});assert.equal(conflict.status,409);
  const unchanged=await f.detail(d);assert.equal(unchanged.revision,d.revision);assert.equal(unchanged.salesOrderId,soId);
  d=await f.action(d,'sales','already-ordered/sales-order',{salesOrderRef:'TEST-ARRIVAL-CANONICAL-SO'});assert.equal(d.stage,'completed');assert.equal(d.salesOrderId,soId);
});
test('arrival notices remain available alongside a Sales input action on a mixed request',async()=>{
  const p=await po();let d=await f.ordered(await f.create(),0,{poNumber:p.ref});d=await f.review(d,1);
  const notices=(await alerts()).filter(row=>row.id===d.id);assert(notices.some(row=>row.action==='input_required'));assert(notices.some(row=>row.action==='arrival'));
  assert.equal(d.statusSummary.status,'pending_sales');assert.equal(d.alreadyOrderedArrival.status,'arrived');
});
test('additive arrival-read migration supports existing revision rows and transaction rollback preserves read history',async()=>{
  const p=await po();const d=await f.ordered(await f.create(1),0,{poNumber:p.ref});assert.equal((await ack(d,d.alreadyOrderedArrival.key)).status,200);
  const before=(await f.query('SELECT * FROM regular_stock_decision_reads ORDER BY request_id,operator_id')).rows;
  const rollback=new Error('TEST rollback rehearsal');
  await assert.rejects(withTransaction(async()=>{
    await f.query('ALTER TABLE regular_stock_decision_reads DROP COLUMN backorder_arrival_key');
    await f.query(readFileSync('migrations/299_backorder_arrival_reads.sql','utf8'));
    const rows=(await f.query('SELECT * FROM regular_stock_decision_reads ORDER BY request_id,operator_id')).rows;
    assert.equal(rows.length,before.length);assert(rows.every(row=>row.backorder_arrival_key===''));
    assert.deepEqual(rows.map(({backorder_arrival_key,...rest})=>rest),before.map(({backorder_arrival_key,...rest})=>rest));
    throw rollback;
  }),error=>error===rollback);
  assert.deepEqual((await f.query('SELECT * FROM regular_stock_decision_reads ORDER BY request_id,operator_id')).rows,before);
  await assert.rejects(f.query("UPDATE regular_stock_decision_reads SET backorder_arrival_key='invalid' WHERE request_id=$1",[d.id]),error=>error.code==='23514');
});
