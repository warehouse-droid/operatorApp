import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import fc from 'fast-check';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {backorderPurchaseReady} from '../../../public/backorder-workflow.js';
import {normalizeSpecialSupplyResponse} from '../../../src/special-stock-request-domain.js';

let f,outbound=0;const nativeFetch=globalThis.fetch;
before(async()=>{f=await fixture();globalThis.fetch=async()=>{outbound++;throw Error('No external call is allowed');};});
after(async()=>{globalThis.fetch=nativeFetch;await f?.close();assert.equal(outbound,0);});
const state=async d=>(await f.query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[d.id])).rows[0].stage;

test('Already Ordered completes without synced orders, vendor, ETA or Sales acceptance and persists both references',async()=>{
  const initial=await f.create(1),d=await f.ordered(initial,0,{poNumber:'  PO-unlinked-42  ',poRefNumber:'  REF-42  '});
  assert.equal(d.revision,initial.revision+1);assert.equal(d.stage,'completed');assert.equal(d.bucket,'completed');
  assert.equal(await state(d),'completed');assert.equal(d.salesOrderId,null);assert.equal(d.purchaseOrderId,null);assert.deepEqual(d.transfers,[]);
  assert.equal(backorderPurchaseReady(d),false);
  for(const role of ['sales','scm']) {
    const saved=await f.detail(d,role),line=saved.lines[0];
    assert.equal(line.supplyStatus,'already_ordered');assert.equal(line.completed,true);assert.equal(line.poNumber,'PO-unlinked-42');assert.equal(line.poRefNumber,'REF-42');
    assert.ok(line.stockCheckedAt);assert.equal(line.reminderDueDate,null);
    const event=saved.events.find(event=>event.eventType==='backorder_already_ordered');assert.ok(event);assert.equal(event.details.poNumber,'PO-unlinked-42');
    const key=role==='sales'?'bucket':'queue';
    for(const [queue,present] of [[role==='sales'?'completed':'closed',true],[role==='sales'?'pending':'request',false]]) {
      const list=await f.http(role,`/api/${role}/stock-requests?${key}=${queue}&search=${d.requestRef}`);
      assert.equal(list.status,200);assert.equal(list.body.requests.some(row=>row.id===d.id),present);
    }
  }
  assert.ok(!(await f.http('sales','/api/sales/stock-requests/alerts')).body.requests.some(row=>row.id===d.id));
  assert.equal((await f.query('SELECT count(*)::int AS n FROM sales_special_stock_order_lines WHERE request_id=$1',[d.id])).rows[0].n,0);
});

test('Mixed Backorder skips completed materials in PO readiness and finishes remaining normal workflow',async()=>{
  let d=await f.create();const untouched=(await f.detail(d,'scm')).lines[1];d=await f.ordered(d);
  assert.equal(d.stage,'new_enquiry');assert.equal(await state(d),'new_enquiry');assert.deepEqual(d.lines[1],untouched);
  assert.equal(backorderPurchaseReady(d),false);assert.equal(d.lines[0].poRefNumber,'');
  d=await f.review(d,1);assert.equal(d.stage,'await_customer_confirmation');
  d=await f.action(d,'sales',`lines/${d.lines[1].id}/decision`,{decision:'accepted'});
  assert.equal(d.stage,'confirmed');assert.equal(await state(d),'confirmed');assert.equal(backorderPurchaseReady(d),true);
  assert.ok(!(await f.http('sales','/api/sales/stock-requests/alerts')).body.requests.some(row=>row.id===d.id));
  const po=88999710,so=88999711;
  await f.query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,netsuite_active) VALUES($1,'TEST-ALREADY-PO',331,1,true)",[po]);
  await f.query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,order_location_id,netsuite_active) VALUES($1,'TEST-ALREADY-SO',18,1,true)",[so]);
  let planId;
  try {
    d=await f.action(d,'scm','purchase-order/link',{purchaseOrderRef:'TEST-ALREADY-PO'});assert.equal(d.stage,'confirmed');
    planId=(await f.query("INSERT INTO dispatch_plans(plan_date,status) VALUES('2099-07-01','draft') RETURNING id")).rows[0].id;
    await f.query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2,$3,'{}')",[planId,JSON.stringify([{id:'TEST-ALREADY-PO',type:'PO'}]),JSON.stringify([{plate:'TEST truck',loads:[{name:'TEST load',stops:[{type:'pickup',orderId:'TEST-ALREADY-PO'}]}]}])]);
    d=await f.action(d,'sales','sales-order/link',{salesOrderRef:'TEST-ALREADY-SO'});assert.equal(d.stage,'confirmed');assert.equal(d.lines[0].poNumber,'PO-UNSYNCED-'+d.id);
  } finally {
    await f.query('DELETE FROM sales_stock_requests WHERE id=$1',[d.id]);
    if(planId)await f.query('DELETE FROM dispatch_plans WHERE id=$1',[planId]);
    await f.query('DELETE FROM purchase_orders WHERE netsuite_id=$1',[po]);await f.query('DELETE FROM sales_orders WHERE netsuite_id=$1',[so]);
  }
});

test('PO number and optional reference reject invalid text atomically and accept their exact length limits',async()=>{
  let d=await f.create();const before=await f.detail(d);
  const badNumbers=[undefined,null,'',' \t ',42,{},[],true,'x'.repeat(121),'PO\n1','PO\u00001'];
  const badRefs=[42,{},[],false,'x'.repeat(201),'REF\r1','REF\u007f1'];
  for(const input of [...badNumbers.map(poNumber=>({poNumber})),...badRefs.map(poRefNumber=>({poNumber:'PO-ok',poRefNumber}))]) {
    const r=await f.http('scm',f.path(d,'scm',`lines/${d.lines[0].id}/response`),{expectedRevision:d.revision,supplyStatus:'already_ordered',...input});
    assert.equal(r.status,400,JSON.stringify(input));assert.deepEqual(await f.detail(d),before);
  }
  d=await f.ordered(d,0,{poNumber:'x'.repeat(120),poRefNumber:'y'.repeat(200)});
  assert.equal(d.lines[0].poNumber.length,120);assert.equal(d.lines[0].poRefNumber.length,200);
});

test('Only SCM on the correct Backorder can complete a line and stale revisions fail',async()=>{
  const d=await f.create(),other=await f.create(),input={expectedRevision:d.revision,supplyStatus:'already_ordered',poNumber:'PO-private'};
  assert.equal((await f.http('sales',f.path(d,'sales',`lines/${d.lines[0].id}/response`),input)).status,403);
  assert.equal((await f.http('foreign',f.path(d,'sales',`lines/${d.lines[0].id}/response`),input)).status,403);
  assert.equal((await f.http('scm',f.path(d,'scm',`lines/${other.lines[0].id}/response`),input)).status,404);
  for(const revision of [undefined,0,d.revision+1])assert.equal((await f.http('scm',f.path(d,'scm',`lines/${d.lines[0].id}/response`),{...input,expectedRevision:revision})).status,409);
  const saved=await f.ordered(d);assert.equal(saved.revision,d.revision+1);
  assert.equal((await f.http('scm',f.path(saved,'scm',`lines/${saved.lines[1].id}/response`),input)).status,409);
  assert.throws(()=>normalizeSpecialSupplyResponse({supplyStatus:'already_ordered',availabilityMode:'no_projection',poNumber:'PO-special',vendorId:331,vendorName:'TEST',vendorYard:'TEST'}),{code:'SPECIAL_RESPONSE_STATUS_INVALID'});
  const specialPath=`/api/scm/special-stock-requests/${saved.id}/lines/${saved.lines[1].id}/response`;
  assert.equal((await f.http('scm',specialPath,{expectedRevision:saved.revision,supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:331,vendorName:'TEST Vendor',vendorYard:'TEST'})).status,404);
  const unsupported=await f.http('scm',specialPath,{...input,expectedRevision:saved.revision});
  assert.equal(unsupported.status,400);assert.equal(unsupported.body.code,'SPECIAL_RESPONSE_STATUS_INVALID');
});

test('Completed lines cannot be reopened by responses, Sales decisions, edits or readiness while other lines stay active',async()=>{
  let d=await f.review(await f.create());d=await f.action(d,'sales',`lines/${d.lines[0].id}/decision`,{decision:'accepted'});d=await f.ordered(d);
  const before=await f.detail(d);
  for(const [role,kind,fields] of [
    ['scm','response',{supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:331,vendorName:'TEST Vendor',vendorYard:'TEST'}],
    ['scm','response',{supplyStatus:'already_ordered',poNumber:'PO-replaced'}],
    ['sales','decision',{decision:'declined',reason:'Attempt reopen'}],
    ['sales','edit',{quantity:17}],['scm','readiness',{ready:true}]
  ]) {
    const result=await f.http(role,f.path(d,role,`lines/${d.lines[0].id}/${kind}`),{expectedRevision:d.revision,...fields});
    assert.equal(result.status,409);assert.equal(result.body.code,'BACKORDER_LINE_COMPLETED');assert.deepEqual(await f.detail(d),before);
  }
  d=await f.ordered(d,1);assert.equal(d.stage,'completed');
  for(const [role,action,input] of [['scm','purchase-order/link',{purchaseOrderRef:'ANY'}],['sales','sales-order/link',{salesOrderRef:'ANY'}]]) {
    const r=await f.http(role,f.path(d,role,action),{expectedRevision:d.revision,...input});assert.equal(r.status,409);assert.equal(r.body.code,'BACKORDER_CLOSED');
  }
});

test('Already Ordered plus declined or closed materials completes in either action order',async()=>{
  for(const decision of ['declined','closed'])for(const orderedFirst of [true,false]) {
    let d=await f.create();if(orderedFirst)d=await f.ordered(d);
    d=await f.review(d,1);d=await f.action(d,'sales',`lines/${d.lines[1].id}/decision`,{decision,reason:'TEST no longer required'});
    if(!orderedFirst)d=await f.ordered(d);
    assert.equal(d.stage,'completed');assert.equal(await state(d),'completed');assert.notEqual(d.status,'cancelled');assert.equal(d.closeStatus,'active');
  }
});

test('Accepted production lines lose ETA reminders when marked Already Ordered',async()=>{
  let d=await f.create();
  d=await f.action(d,'scm',`lines/${d.lines[0].id}/response`,{supplyStatus:'production',availabilityMode:'dated',availableDate:'2099-03-01',vendorId:331,vendorName:'TEST Vendor',vendorYard:'TEST'});
  d=await f.action(d,'sales',`lines/${d.lines[0].id}/decision`,{decision:'accepted'});assert.ok(d.lines[0].reminderDueDate);
  d=await f.ordered(d);assert.equal(d.lines[0].availableDate,null);assert.equal(d.lines[0].reminderDueDate,null);assert.equal(d.lines[0].availabilityMode,null);
  d=await f.review(d,1);d=await f.action(d,'sales',`lines/${d.lines[1].id}/decision`,{decision:'accepted'});
  assert.equal(d.stage,'confirmed');assert.deepEqual(d.readinessAlerts,[]);
});

test('Already Ordered clears an outstanding SCM review alert while the remaining material awaits PO linkage',async()=>{
  let d=await f.review(await f.create());
  d=await f.action(d,'sales',`lines/${d.lines[0].id}/decision`,{decision:'request_update',reason:'TEST recheck'});
  d=await f.review(d,1);d=await f.action(d,'sales',`lines/${d.lines[1].id}/decision`,{decision:'accepted'});
  const before=(await f.http('scm','/api/scm/stock-requests/alerts')).body.manualReview;
  d=await f.ordered(d);assert.equal(d.stage,'confirmed');assert.equal(await state(d),'confirmed');
  assert.equal((await f.http('scm','/api/scm/stock-requests/alerts')).body.manualReview,before-1);
  assert.ok(!(await f.http('sales','/api/sales/stock-requests/alerts')).body.requests.some(row=>row.id===d.id));
});

test('Concurrent SCM completions commit exactly once and another line can finish with the fresh revision',async()=>{
  const d=await f.create();
  const saves=await Promise.all(['PO-A','PO-B'].map(poNumber=>f.http('scm',f.path(d,'scm',`lines/${d.lines[0].id}/response`),{expectedRevision:d.revision,supplyStatus:'already_ordered',poNumber})));
  assert.deepEqual(saves.map(r=>r.status).sort(),[200,409]);
  let saved=await f.detail(d);assert.equal(saved.revision,d.revision+1);assert.equal(saved.events.filter(e=>e.eventType==='backorder_already_ordered').length,1);
  saved=await f.ordered(saved,1);assert.equal(saved.stage,'completed');assert.equal(await state(saved),'completed');
});

test('property: arbitrary safe PO references round trip without external orders and always complete the only line',async()=>{
  const reference=fc.array(fc.constantFrom(...'abcXYZ012 /-<&>"\''),{minLength:1,maxLength:50}).map(chars=>'PO-'+chars.join(''));
  await fc.assert(fc.asyncProperty(reference,reference,async(poNumber,poRefNumber)=>{
    const d=await f.ordered(await f.create(1),0,{poNumber:' '+poNumber+' ',poRefNumber:' '+poRefNumber+' '});
    assert.equal(d.lines[0].poNumber,poNumber.trim());assert.equal(d.lines[0].poRefNumber,poRefNumber.trim());assert.equal(d.stage,'completed');assert.equal(await state(d),'completed');
    assert.equal(d.salesOrderId,null);assert.equal(d.purchaseOrderId,null);
  }),{seed:105080,numRuns:24});
});
