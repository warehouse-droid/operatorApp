import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beginRollbackContext, query, closeDb, withTransaction } from '../../../src/db.js';
import { readFileSync } from 'node:fs';
import * as repo from '../../../src/special-stock-request-repository.js';
import { createSpecialClosureService } from '../../../src/special-stock-closure-service.js';
import { createDispatchPlan, saveDispatchPlanSnapshot } from '../../../src/dispatch-plan-repository.js';
import { applyDispatchV2Command } from '../../../src/dispatch-planner-v2-repository.js';
import { digestDispatchPlan } from '../../../src/dispatch-planner-performance.js';
import { prepareSpecialClosurePlan, applySpecialClosurePlan } from '../../../src/special-stock-closure-adapter.js';
import { linkedClosureBoundary } from '../../support/special-linked-closure-fixture.js';
after(closeDb);
const context = { operatorId: 'TEST-CLOSURE-SALES', authorizedStoreLocationIds: [1] };
async function fixture(run) {
  const tx = await beginRollbackContext();
  try { await tx.run(async () => {
    await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES($1,$1,'TEST','hash','salt','sales',ARRAY['sales'],ARRAY[1]) ON CONFLICT DO NOTHING",[context.operatorId]);
    let d=await repo.createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST',vendorName:'TEST',fulfillmentMethod:'yard_pickup',lines:[{productName:'TEST',quantity:50,uom:'Pcs',rate:17,requiredDate:'2099-02-01'}]},context);
    await query("INSERT INTO sales_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES(8877701,'TEST-CLOSE-SO','Pending Fulfillment',true)");
    await query("INSERT INTO purchase_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES(8877702,'TEST-CLOSE-PO','Pending Receipt',true)");
    await query("INSERT INTO inventory_items(item_id,item_name,raw,synced_at) VALUES(2055,'MBBS-Special Order','{}',now()) ON CONFLICT DO NOTHING");
    await query("INSERT INTO sales_special_stock_order_lines(request_id,case_line_id,order_kind,item_id,description,quantity,uom,unit_rate,unit_purchase_cost,remote_line_id) VALUES($1,$2,'sales_order',2055,'TEST',50,'PC',17,NULL,701),($1,$2,'purchase_order',2055,'TEST',50,'PC',NULL,5,702)",[d.id,d.lines[0].id]);
    await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=8877701,sales_order_ref='TEST-CLOSE-SO',purchase_order_netsuite_id=8877702,purchase_order_ref='TEST-CLOSE-PO',sales_order_approved=true WHERE request_id=$1",[d.id]);
    await query("INSERT INTO sales_special_stock_handoffs(request_id,route,status,sales_order_netsuite_id,purchase_order_netsuite_id,pickup_address,destination_address,operational_yard_location_id,line_snapshot) VALUES($1,'direct','ready',8877701,8877702,'TEST vendor','TEST destination',1,'[]')",[d.id]);
    d=await repo.getSpecialStockCase(d.id); await run(d);
  }); } finally { await tx.rollback(); }
}
test('issued PO closure waits for SCM and both verified remote closures before local cancellation',()=>fixture(async d=>{
  const pending=await repo.requestSpecialCaseClosure(d.id,{expectedRevision:d.revision,reason:'Customer cancelled'},context);
  assert.equal(pending.closeStatus,'closure_pending'); assert.equal(pending.closureReview.status,'pending');
  assert.equal((await query('SELECT status_text FROM purchase_orders WHERE netsuite_id=8877702')).rows[0].status_text,'Pending Receipt');
  await repo.setSpecialSalesOrderStatus(d.id,{salesOrderStatus:'Closed',active:false});
  const afterWebhook=await repo.getSpecialStockCase(d.id);assert.equal(afterWebhook.closeStatus,'closure_pending');
  let prepared=0,applied=0;
  const service=createSpecialClosureService({readClosedOrders:async()=>null,withReviewLock:async(_id,run)=>run(),resolveOrderUnits:async lines=>lines,
    preparePlan:async()=>{prepared++;return {version:1,orders:[{id:8877702,kind:'purchase_order',lines:[]},{id:8877701,kind:'sales_order',lines:[]}]};},
    applyPlan:async()=>{applied++;return {verifiedOrderIds:[8877702,8877701]};}});
  const closed=await service.reviewClosure(d.id,{expectedRevision:afterWebhook.revision,reviewId:pending.closureReview.id,decision:'approve'},{operatorId:context.operatorId});
  assert.equal(closed.closeStatus,'closed'); assert.equal(closed.status,'cancelled'); assert.equal(closed.closureReview.status,'approved');
  assert.deepEqual((await query("SELECT status_text FROM sales_orders WHERE netsuite_id=8877701 UNION ALL SELECT status_text FROM purchase_orders WHERE netsuite_id=8877702")).rows.map(r=>r.status_text),['Closed','Closed']);
  await service.reviewClosure(d.id,{expectedRevision:closed.revision,reviewId:closed.closureReview.id,decision:'approve'},{operatorId:context.operatorId});
  assert.equal(prepared,1);assert.equal(applied,1);
}));
test('SCM rejection restores active request without remote calls and stale reviews cannot confirm',()=>fixture(async d=>{
  const pending=await repo.requestSpecialCaseClosure(d.id,{expectedRevision:d.revision,reason:'Customer cancelled'},context);
  const service=createSpecialClosureService({readClosedOrders:async()=>null,withReviewLock:async(_id,run)=>run()});
  const rejected=await service.reviewClosure(d.id,{expectedRevision:pending.revision,reviewId:pending.closureReview.id,decision:'reject',reason:'Vendor has already prepared stock'},context);
  assert.equal(rejected.closeStatus,'active'); assert.equal(rejected.closureReview.status,'rejected');
  await assert.rejects(service.reviewClosure(d.id,{expectedRevision:rejected.revision,reviewId:randomUUID(),decision:'approve'},context),{status:409});
}));
test('a PO planned by Dispatch prevents Sales closure and appears in the detail projection',()=>fixture(async d=>{
  const plan=(await query("INSERT INTO dispatch_plans(plan_date,status) VALUES('2099-12-23','draft') RETURNING id")).rows[0];
  await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,'[]',$2::jsonb,'{}')",[plan.id,JSON.stringify([{loads:[{stops:[{type:'pickup',orderId:'TEST-CLOSE-PO'}]}]}])]);
  const planned=await repo.getSpecialStockCase(d.id);assert.equal(planned.dispatchPlanning.purchaseOrder.planned,true);assert.equal(planned.dispatchPlanning.salesOrder.planned,false);assert.equal(planned.dispatchPlanning.purchaseOrder.plans[0].planDate,'2099-12-23');
  await assert.rejects(repo.requestSpecialCaseClosure(d.id,{expectedRevision:planned.revision,reason:'Cancel'},context),{code:'SPECIAL_CLOSURE_PLANNED'});
  await query("UPDATE dispatch_plans SET status='cancelled' WHERE id=$1",[plan.id]);
  assert.equal((await repo.getSpecialStockCase(d.id)).dispatchPlanning.anyPlanned,false);
  const pending=await repo.requestSpecialCaseClosure(d.id,{expectedRevision:planned.revision,reason:'Cancel'},context);
  assert.equal(pending.closureReview.status,'pending');
}));

test('SCM closure requests precede newer adjustment reviews before pagination',()=>fixture(async d=>{
  await query("UPDATE sales_special_stock_cases SET customer_name='TEST-CLOSURE-PRIORITY' WHERE request_id=$1",[d.id]);
  const pending=await repo.requestSpecialCaseClosure(d.id,{expectedRevision:d.revision,reason:'Cancel'},context);
  await query("UPDATE sales_stock_requests SET updated_at='2000-01-01' WHERE id=$1",[d.id]);
  const newer=await repo.createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST-CLOSURE-PRIORITY',vendorName:'TEST',fulfillmentMethod:'yard_pickup',lines:[{productName:'TEST',quantity:1,uom:'Pcs',rate:1,requiredDate:'2099-02-01'}]},context);
  await query('UPDATE sales_special_stock_cases SET quantity_review=$2::jsonb WHERE request_id=$1',[newer.id,JSON.stringify({id:'TEST-ADJUSTMENT',status:'pending',lines:[]})]);
  const first=await repo.listSpecialStockCases({audience:'scm',search:'TEST-CLOSURE-PRIORITY',limit:1});
  assert.equal(first[0].id,d.id);
  const second=await repo.listSpecialStockCases({audience:'scm',search:'TEST-CLOSURE-PRIORITY',limit:1,offset:1});
  assert.equal(second[0].id,newer.id);
  await repo.rejectSpecialClosureReview(d.id,{expectedRevision:pending.revision,reviewId:pending.closureReview.id,reason:'Keep open'},context);
  assert.equal((await repo.listSpecialStockCases({audience:'scm',search:'TEST-CLOSURE-PRIORITY',limit:1}))[0].id,newer.id);
}));
test('partial close keeps both local orders open and recovers the saved plan; rejection is blocked after remote start',()=>fixture(async d=>{
  let pending=await repo.requestSpecialCaseClosure(d.id,{expectedRevision:d.revision,reason:'Cancel'},context),calls=0,prepared=0;
  const service=createSpecialClosureService({readClosedOrders:async()=>null,withReviewLock:async(_id,run)=>run(),resolveOrderUnits:async lines=>lines,
    preparePlan:async()=>{prepared++;return {version:1,orders:[{id:8877702,kind:'purchase_order',lines:[]},{id:8877701,kind:'sales_order',lines:[]}]};},
    applyPlan:async()=>{if(++calls===1)throw Error('Lost response');return {verifiedOrderIds:[8877702,8877701]};}});
  const input=()=>({expectedRevision:pending.revision,reviewId:pending.closureReview.id,decision:'approve'});
  await assert.rejects(service.reviewClosure(d.id,input(),context),/Lost response/);
  pending=await repo.getSpecialStockCase(d.id);assert.equal(pending.closureReview.status,'attention');assert.equal(pending.closeStatus,'closure_pending');
  await assert.rejects(service.reviewClosure(d.id,{...input(),decision:'reject'},context),{status:409});
  assert.equal((await service.reviewClosure(d.id,input(),context)).closeStatus,'closed');assert.equal(prepared,1);
}));

test('pending Special closure permits full and incremental Dispatch saves without changing the closure review',()=>fixture(async d=>{
  await repo.requestSpecialCaseClosure(d.id,{expectedRevision:d.revision,reason:'Cancel'},context);
  const plan=await createDispatchPlan({planDate:'2099-12-24'});
  const truck=(await query("INSERT INTO dispatch_trucks(plate,active) VALUES('TEST-CLOSURE-TRUCK',true) RETURNING id::text,plate")).rows[0];
  const orders=[{id:'TEST-CLOSE-SO',type:'SO',deliveryMethod:'Delivery',sourceYard:'3445',address:'TEST destination',items:[]}];
  const trucks=[{...truck,loads:[{id:'TEST-CLOSE-LOAD',name:'Load 1',stops:[{id:'TEST-DROP',type:'drop',orderId:'TEST-CLOSE-SO',location:'TEST destination'}]}]}];
  const saved=await saveDispatchPlanSnapshot(plan.id,{planDate:plan.planDate,baseRevision:plan.revision,orders,trucks,summary:{}});
  assert.equal(saved.trucks[0].loads[0].stops[0].orderId,'TEST-CLOSE-SO');
  const nextTrucks=trucks.map(value=>({...value,loads:value.loads.map(load=>({...load,name:'Load 2'}))}));
  const updated=await applyDispatchV2Command({planId:plan.id,command:{commandId:randomUUID(),commandType:'update_load',baseRevision:saved.revision,
    baseDigest:digestDispatchPlan(saved),payload:{planDelta:{orders,trucks:nextTrucks,summary:{}}}}});
  assert.equal(updated.payload.plan.trucks[0].loads[0].name,'Load 2');
  assert.equal(Number((await query('SELECT revision FROM dispatch_plans WHERE id=$1',[plan.id])).rows[0].revision),saved.revision+1);
  const current=await repo.getSpecialStockCase(d.id);assert.equal(current.closeStatus,'closure_pending');assert.equal(current.closureReview.status,'pending');
}));

test('SCM closure end-to-end uses the real journal, service and native adapter with only NetSuite mocked',()=>fixture(async d=>{
  const pending=await repo.requestSpecialCaseClosure(d.id,{expectedRevision:d.revision,reason:'Customer cancelled'},context);
  const closed=new Set(),writes=[];
  const boundary={queryAll:async sql=>{const id=Number(/tl.transaction = (\d+)/.exec(sql)[1]);return [{uniquekey:id===8877701?701:702,rest_line_id:1,item:2055,execution_quantity:0,billed_quantity:0,
    line_closed:closed.has(id)?'T':'F',status_text:closed.has(id)?'Closed':'Pending Receipt'}];},
    rest:async(path,options={})=>{const id=Number(/\/(\d+)/.exec(path)[1]);if(options.method==='PATCH'){writes.push(id);assert.deepEqual(options.body,{item:{items:[{line:1,isClosed:true}]}});closed.add(id);}
      return {data:{item:{items:[{line:1,item:{id:2055},quantity:50,description:'TEST',units:'865',rate:id===8877701?17:5,isClosed:closed.has(id)}]}}};}};
  const service=createSpecialClosureService({readClosedOrders:async()=>null,resolveOrderUnits:async lines=>lines.map(line=>({...line,unitId:865})),
    preparePlan:input=>prepareSpecialClosurePlan(input,boundary),applyPlan:plan=>applySpecialClosurePlan(plan,boundary)});
  const result=await service.reviewClosure(d.id,{expectedRevision:pending.revision,reviewId:pending.closureReview.id,decision:'approve'},context);
  assert.equal(result.closeStatus,'closed');assert.deepEqual(writes,[8877702,8877701]);
  assert.equal((await query('SELECT status FROM sales_special_stock_handoffs WHERE request_id=$1',[d.id])).rows[0].status,'cancelled');
  const sales=await repo.getSpecialStockCase(d.id,{audience:'sales',authorizedStoreLocationIds:[1]});assert.equal(sales.closureReviewPlan,undefined);
}));

test('changed linked orders close through the real journal without resolving stale local lines',()=>fixture(async d=>{
  let pending=await repo.requestSpecialCaseClosure(d.id,{expectedRevision:d.revision,reason:'Customer cancelled'},context);
  const boundary=linkedClosureBoundary();
  // Reproduce the earlier preflight failure; it must be retryable without a saved plan.
  await query('UPDATE sales_special_stock_cases SET closure_review=closure_review || $2::jsonb WHERE request_id=$1',
    [d.id,JSON.stringify({status:'attention',error:'The complete NetSuite order must match this request.'})]);
  const service=createSpecialClosureService({readClosedOrders:async()=>null,
    resolveOrderUnits:async()=>{throw Error('Closure must not resolve request line units');},
    preparePlan:input=>{
      assert.deepEqual(input,{orders:[{kind:'sales_order',id:8877701},{kind:'purchase_order',id:8877702}],closeRemaining:true});
      return prepareSpecialClosurePlan(input,boundary);
    },applyPlan:plan=>applySpecialClosurePlan(plan,boundary)});
  const input=()=>({expectedRevision:pending.revision,reviewId:pending.closureReview.id,decision:'approve'});
  boundary.loseResponse=true;
  await assert.rejects(service.reviewClosure(d.id,input(),context),/Lost close response/);
  pending=await repo.getSpecialStockCase(d.id);
  assert.equal(pending.closeStatus,'closure_pending');assert.equal(pending.closureReview.status,'attention');
  assert.notEqual(pending.status,'cancelled');
  assert.deepEqual(boundary.writes.map(write=>write.id),[8877702]);
  assert.equal((await query('SELECT status_text FROM sales_orders WHERE netsuite_id=8877701')).rows[0].status_text,'Pending Fulfillment');
  const closed=await service.reviewClosure(d.id,input(),context);
  assert.equal(closed.closeStatus,'closed');assert.equal(closed.status,'cancelled');assert.equal(closed.closureReview.status,'approved');
  assert.deepEqual(boundary.writes.map(write=>write.id),[8877702,8877701]);
  assert.deepEqual(closed.closureReviewPlan.orders.map(order=>order.lines.map(line=>line.line)),[[7,9,11],[7,9,11]]);
  assert.ok(closed.events.some(event=>event.eventType==='special_case_closed'));
  assert.deepEqual((await query("SELECT status FROM sales_orders WHERE netsuite_id=8877701 UNION ALL SELECT status FROM purchase_orders WHERE netsuite_id=8877702")).rows.map(row=>row.status),['closed','closed']);
}));

test('SCM closure lock rejects simultaneous reviewers and is released after failure',()=>fixture(async d=>{
  let entered,release;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const first=repo.withSpecialClosureReviewLock(d.id,async()=>{entered();await gate;throw Error('TEST release');});
  await started;await assert.rejects(repo.withSpecialClosureReviewLock(d.id,async()=>{}),{code:'SPECIAL_CLOSURE_BUSY'});
  release();await assert.rejects(first,/TEST release/);await repo.withSpecialClosureReviewLock(d.id,async()=>{});
}));

test('workflow-locked closed SO completes the real SCM journal by closing only the PO',()=>fixture(async d=>{
  const pending=await repo.requestSpecialCaseClosure(d.id,{expectedRevision:d.revision,reason:'Customer cancelled'},context);
  const closed=new Set([8877701]),writes=[];
  const boundary={queryAll:async sql=>{
    const id=Number(/tl.transaction = (\d+)/.exec(sql)[1]);
    return [{uniquekey:id===8877701?701:702,rest_line_id:1,item:2055,execution_quantity:0,billed_quantity:0,
      line_closed:closed.has(id)?'T':'F',status_text:closed.has(id)?'Closed':'Pending Receipt',
      base_quantity:id===8877701?-50:50,line_rate:id===8877701?17:5,unit_id:865,description:'TEST'}];
  },rest:async(path,options={})=>{
    const id=Number(/\/(\d+)/.exec(path)[1]);
    if(options.method==='PATCH'){
      assert.equal(id,8877702);assert.equal(closed.has(id),false);
      assert.deepEqual(options.body,{item:{items:[{line:1,isClosed:true}]}});
      writes.push(id);closed.add(id);return {data:{}};
    }
    if(closed.has(id))throw Object.assign(Error('This record has been locked by a user defined workflow.'),{status:400,netsuiteErrorCodes:['USER_ERROR']});
    return {data:{item:{items:[{line:1,item:{id:2055},quantity:50,description:'TEST',units:'865',rate:5,isClosed:false}]}}};
  }};
  const service=createSpecialClosureService({readClosedOrders:async()=>null,resolveOrderUnits:async lines=>lines.map(line=>({...line,unitId:865})),
    preparePlan:input=>prepareSpecialClosurePlan(input,boundary),applyPlan:plan=>applySpecialClosurePlan(plan,boundary)});
  const result=await service.reviewClosure(d.id,{expectedRevision:pending.revision,reviewId:pending.closureReview.id,decision:'approve'},context);
  assert.equal(result.closeStatus,'closed');assert.equal(result.status,'cancelled');assert.equal(result.closureReview.status,'approved');
  assert.deepEqual(writes,[8877702]);
  assert.deepEqual((await query("SELECT status FROM sales_orders WHERE netsuite_id=8877701 UNION ALL SELECT status FROM purchase_orders WHERE netsuite_id=8877702")).rows.map(r=>r.status),['closed','closed']);
  await service.reviewClosure(d.id,{expectedRevision:result.revision,reviewId:result.closureReview.id,decision:'approve'},context);
  assert.deepEqual(writes,[8877702]);
}));

test('execution recorded locally prevents closure even when the plan was removed',()=>fixture(async d=>{
  await query("UPDATE sales_special_stock_handoffs SET status='in_progress' WHERE request_id=$1",[d.id]);
  await assert.rejects(repo.requestSpecialCaseClosure(d.id,{expectedRevision:d.revision,reason:'Cancel'},context),{code:'SPECIAL_CLOSURE_EXECUTED'});
  assert.equal((await repo.getSpecialStockCase(d.id)).closeStatus,'active');
  assert.equal((await repo.getSpecialStockCase(d.id)).revision,d.revision);
}));

test('a partial verified order pair cannot cancel either local order',()=>fixture(async d=>{
  const pending=await repo.requestSpecialCaseClosure(d.id,{expectedRevision:d.revision,reason:'Cancel'},context);
  const service=createSpecialClosureService({readClosedOrders:async()=>null,resolveOrderUnits:async lines=>lines,
    preparePlan:async()=>({version:1,orders:[{id:8877702,kind:'purchase_order',lines:[]},{id:8877701,kind:'sales_order',lines:[]}]}),
    applyPlan:async()=>({verifiedOrderIds:[8877702]})});
  await assert.rejects(service.reviewClosure(d.id,{expectedRevision:pending.revision,reviewId:pending.closureReview.id,decision:'approve'},context),{code:'SPECIAL_CLOSURE_UNVERIFIED'});
  const current=await repo.getSpecialStockCase(d.id);assert.equal(current.closeStatus,'closure_pending');assert.equal(current.closureReview.status,'attention');
  assert.deepEqual((await query("SELECT status_text FROM sales_orders WHERE netsuite_id=8877701 UNION ALL SELECT status_text FROM purchase_orders WHERE netsuite_id=8877702")).rows.map(r=>r.status_text),['Pending Fulfillment','Pending Receipt']);
}));

test('closure migration upgrades legacy cases transactionally and rollback retains the prior journal',()=>fixture(async d=>{
  const migration=readFileSync(new URL('../../../migrations/232_special_stock_closure_review.sql',import.meta.url),'utf8');
  const marker=Error('Rollback rehearsal');
  await assert.rejects(withTransaction(async()=>{
    await query('ALTER TABLE sales_special_stock_cases DROP COLUMN closure_review');
    await query(migration);await query(migration);
    assert.deepEqual((await query('SELECT closure_review FROM sales_special_stock_cases WHERE request_id=$1',[d.id])).rows[0].closure_review,{});
    await assert.rejects(withTransaction(()=>query("UPDATE sales_special_stock_cases SET closure_review='[]' WHERE request_id=$1",[d.id])),{code:'23514'});
    await query("UPDATE sales_special_stock_cases SET closure_review=$2::jsonb WHERE request_id=$1",[d.id,JSON.stringify({id:'TEST',status:'pending'})]);
    throw marker;
  }),error=>error===marker);
  assert.deepEqual((await query('SELECT closure_review FROM sales_special_stock_cases WHERE request_id=$1',[d.id])).rows[0].closure_review,{});
}));

test('readiness reminder stays informational while SCM closes remaining fulfilled SO and untouched PO lines',()=>fixture(async d=>{
 await query("UPDATE sales_special_stock_lines SET sales_decision='accepted',supply_status='vendor_transfer',available_date='2099-02-01',reminder_due_date='2000-01-01' WHERE request_id=$1",[d.id]);
 d=await repo.getSpecialStockCase(d.id);assert.equal(d.readinessAlerts.length,1);
 const boundary=linkedClosureBoundary(),original=boundary.queryAll;
 boundary.queryAll=async sql=>(await original(sql)).map(row=>({...row,
  execution_quantity:sql.includes('8877701')?10:0,billed_quantity:sql.includes('8877701')?10:0,
  status_text:row.line_closed==='T'?'Closed':sql.includes('8877701')?'Sales Order : Pending Billing':'Purchase Order : Pending Receipt'}));
 const before=JSON.stringify([...boundary.remote].map(([id,lines])=>[id,lines.map(({closed:_closed,...line})=>line)]));
 const service=createSpecialClosureService({readClosedOrders:async()=>null,
  preparePlan:input=>prepareSpecialClosurePlan(input,boundary),applyPlan:plan=>applySpecialClosurePlan(plan,boundary)});
 const pending=await service.requestClosure(d.id,{expectedRevision:d.revision,reason:'Customer cancelled remaining order'},context);
 assert.equal(pending.closeStatus,'closure_pending');assert.equal(pending.readinessAlerts.length,1);assert.equal(boundary.writes.length,0);
 const closed=await service.reviewClosure(d.id,{expectedRevision:pending.revision,reviewId:pending.closureReview.id,decision:'approve'},context);
 assert.equal(closed.closeStatus,'closed');assert.equal(closed.closureReview.status,'approved');assert.deepEqual(closed.readinessAlerts,[]);
 assert.deepEqual(boundary.writes.map(w=>w.id),[8877702,8877701]);
 assert.equal(JSON.stringify([...boundary.remote].map(([id,lines])=>[id,lines.map(({closed:_closed,...line})=>line)])),before);
}));
