import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {poProgressFixture} from '../helpers/backorder-po-progress.js';
import {backorderAlerts,acknowledgeBackorderAlert} from '../../../src/backorder-request-service.js';
let f;
after(async()=>{await f?.close();});
before(async()=>{f=await poProgressFixture(88999351);});
const progress=rows=>rows.filter(row=>['po_reference','po_planned'].includes(row.action));

test('a completed Already Ordered line follows the live PO ref in Sales/SCM and alerts once per new ref',async()=>{
  const p=await f.po();let d=await f.ordered(await f.create(1),0,{poNumber:p.ref,poRefNumber:'SAVED-REF'});
  assert.equal(d.stage,'completed');assert.equal(d.lines[0].poRefNumber,'SAVED-REF');
  assert.deepEqual(progress(await f.alerts(d)),[]);
  assert.equal((await f.ack(d,undefined)).status,200);
  await f.query('UPDATE purchase_orders SET dispatch_ref=$2 WHERE netsuite_id=$1',[p.id,'  LIVE-REF  ']);
  for (const role of ['sales','scm']) {
    d=await f.detail(d,role);assert.equal(d.lines[0].poRefNumber,'LIVE-REF');assert.equal(d.stage,'completed');
    const queue=await f.http(role,`/api/${role}/stock-requests?allStatuses=1&search=${d.requestRef}`);
    assert.equal(queue.status,200);assert.equal(queue.body.requests[0].lines[0].poRefNumber,'LIVE-REF');
  }
  const notice=progress(await f.alerts(d));assert.equal(notice.length,1);assert.equal(notice[0].action,'po_reference');
  assert.equal(notice[0].purchaseOrderRef,p.ref+' / LIVE-REF');
  assert.deepEqual(progress(await f.alerts(d)),notice);
  assert.equal((await f.ack(d,undefined)).status,200);assert.equal(progress(await f.alerts(d)).length,1);
  assert.equal((await f.ack(d,[notice[0].noticeKey])).status,200);
  assert.equal((await f.ack(d,[notice[0].noticeKey])).status,200);assert.deepEqual(progress(await f.alerts(d)),[]);
  await f.query('UPDATE purchase_orders SET dispatch_ref=$2,synced_at=now() WHERE netsuite_id=$1',[p.id,'live-ref']);
  assert.deepEqual(progress(await f.alerts(d)),[]);
  await f.query('UPDATE purchase_orders SET dispatch_ref=$2 WHERE netsuite_id=$1',[p.id,'NEXT-REF']);
  const next=progress(await f.alerts(d));assert.equal(next.length,1);assert.notEqual(next[0].noticeKey,notice[0].noticeKey);
  assert.equal((await f.ack(d,[notice[0].noticeKey])).status,409);
  assert.equal((await f.query('SELECT backorder_po_ref_number FROM sales_special_stock_lines WHERE id=$1',[d.lines[0].id])).rows[0].backorder_po_ref_number,'SAVED-REF');
});

test('planning alerts without a ref, follows grouped split pickups, and ignores assignment/ETA noise',async()=>{
  const p=await f.po(),d=await f.ordered(await f.create(1),0,{poNumber:p.ref});
  await f.plan(p.ref,{assigned:false});assert.deepEqual(progress(await f.alerts(d)),[]);
  const plan=await f.plan(p.ref,{group:true,split:true});
  let detail=await f.detail(d);assert.equal(detail.lines[0].poPlanning.planned,true);
  assert.equal(detail.lines[0].poPlanning.plans[0].planDate,plan.plan_date);
  const notices=progress(await f.alerts(d));assert.equal(notices.length,1);assert.equal(notices[0].action,'po_planned');
  assert(notices[0].message.includes(plan.plan_date));assert.equal(notices[0].purchaseOrderRef,p.ref);
  assert.equal((await f.ack(detail,[notices[0].noticeKey])).status,200);
  plan.trucks[0].plate='DIFFERENT';plan.trucks[0].loads[0].stops[0].timing={arrival:600};
  await f.query('UPDATE dispatch_plan_snapshots SET trucks=$2 WHERE plan_id=$1',[plan.id,JSON.stringify(plan.trucks)]);
  assert.deepEqual(progress(await f.alerts(d)),[]);
  await f.query('UPDATE purchase_orders SET dispatch_ref=$2 WHERE netsuite_id=$1',[p.id,'LATER-REF']);
  assert.deepEqual(progress(await f.alerts(d)).map(n=>n.action),['po_reference']);
  await f.query("UPDATE dispatch_plans SET status='cancelled' WHERE id=$1",[plan.id]);
  detail=await f.detail(d);assert.equal(detail.lines[0].poPlanning.planned,false);
  assert.equal((await f.ack(detail,[notices[0].noticeKey])).status,409);
});

test('plans match the dispatch reference and exclude return-only or cancelled schedules',async()=>{
  const p=await f.po({reference:'ALIAS-PO-PLAN'}),d=await f.ordered(await f.create(1),0,{poNumber:p.ref});
  await f.plan(p.ref,{alias:'ALIAS-PO-PLAN',returnOnly:true});
  await f.plan(p.ref,{alias:'ALIAS-PO-PLAN',status:'cancelled'});
  assert.equal((await f.detail(d)).lines[0].poPlanning.planned,false);
  await f.plan(p.ref,{alias:'ALIAS-PO-PLAN'});
  assert.equal((await f.detail(d)).lines[0].poPlanning.planned,true);
  assert.deepEqual(progress(await f.alerts(d)).map(n=>n.action),['po_reference','po_planned']);
});

test('multiple POs and duplicate materials acknowledge independently; receipt alerts remain independent',async()=>{
  const p=await f.po({reference:'MULTI-A'}),q=await f.po({reference:'MULTI-B'});
  let d=await f.ordered(await f.create(3),0,{poNumber:p.ref});d=await f.ordered(d,1,{poNumber:p.ref});d=await f.ordered(d,2,{poNumber:q.ref});
  await f.plan(p.ref);d=await f.detail(d);
  let notices=progress(await f.alerts(d));assert.equal(notices.length,3);
  const first=notices.find(n=>n.purchaseOrderId===p.id&&n.action==='po_reference');
  assert.equal((await f.ack(d,[first.noticeKey])).status,200);
  notices=progress(await f.alerts(d));assert.equal(notices.length,2);assert(notices.some(n=>n.purchaseOrderId===q.id));
  const receiptCount=async()=>Number((await f.query('SELECT count(*) n FROM backorder_po_alert_receipts WHERE request_id=$1',[d.id])).rows[0].n);
  assert.equal(await receiptCount(),1);
  assert.equal((await f.ack(d,[notices[0].noticeKey,'a'.repeat(64)])).status,409);assert.equal(await receiptCount(),1);
  for(const keys of [null,'bad',['bad'],[123],Array(7).fill(first.noticeKey)]) assert.equal((await f.ack(d,keys)).status,400);
  assert.equal((await f.ack(d,notices.map(n=>n.noticeKey))).status,200);
  await f.query("UPDATE purchase_orders SET status_text='Fully Received' WHERE netsuite_id=$1",[p.id]);
  let rows=await f.alerts(d);assert.equal(rows.filter(n=>n.action==='arrival').length,1);assert.deepEqual(progress(rows),[]);
  d=await f.detail(d);assert.equal((await f.ack(d,[], 'sales',{arrivalKey:d.alreadyOrderedArrival.key})).status,200);
  assert.deepEqual(await f.alerts(d),[]);
  await f.query('UPDATE purchase_orders SET dispatch_ref=$2 WHERE netsuite_id=$1',[q.id,'MULTI-B-NEW']);
  assert.equal(progress(await f.alerts(d)).length,1);
});

test('progress is scoped to the requester and request yard, not the replenishment PO yard',async()=>{
  const p=await f.po({reference:'SCOPED'});await f.query('UPDATE purchase_orders SET destination_location_id=28 WHERE netsuite_id=$1',[p.id]);
  const d=await f.ordered(await f.create(1),0,{poNumber:p.ref}),notices=progress(await f.alerts(d));assert.equal(notices.length,1);
  for(const scope of [[],[28]]) assert(!(await backorderAlerts({operatorId:f.users.sales.id,authorizedDestinationLocationIds:scope})).requests.some(row=>row.id===d.id));
  assert(!(await backorderAlerts({operatorId:f.users.foreign.id,authorizedDestinationLocationIds:[1]})).requests.some(row=>row.id===d.id));
  assert.equal((await f.ack(d,[notices[0].noticeKey],'foreign')).status,403);
  await assert.rejects(()=>acknowledgeBackorderAlert(d.id,d.revision,{operatorId:f.users.foreign.id,authorizedDestinationLocationIds:[1]},undefined,[notices[0].noticeKey]),error=>error.status===403);
});

test('unknown, ambiguous, inactive, cancelled, removed and closed PO lines provide no progress alerts',async()=>{
  const cases=[{poNumber:'NO-SYNC-PO',poRefNumber:'MANUALLY-SAVED'}];
  for(const options of [{active:false},{status:'Purchase Order : Cancelled'},{status:'Rejected'}]) cases.push({poNumber:(await f.po({reference:'IGNORE',...options})).ref});
  const ambiguous=await f.po({reference:'IGNORE'});await f.po({native:ambiguous.ref,reference:'IGNORE-TOO'});cases.push({poNumber:ambiguous.ref});
  for(const input of cases) {
    const d=await f.ordered(await f.create(1),0,input);assert.deepEqual(progress(await f.alerts(d)),[]);assert.equal(d.lines[0].poPlanning.planned,false);
  }
  const p=await f.po({reference:'REMOVED'}),d=await f.ordered(await f.create(1),0,{poNumber:p.ref});
  await f.query('UPDATE sales_special_stock_lines SET removed_at=now() WHERE id=$1',[d.lines[0].id]);assert.deepEqual(progress(await f.alerts(d)),[]);
  const closed=await f.ordered(await f.create(1),0,{poNumber:p.ref});
  await f.query("UPDATE sales_special_stock_cases SET close_status='closed' WHERE request_id=$1",[closed.id]);assert.deepEqual(progress(await f.alerts(closed)),[]);
});
