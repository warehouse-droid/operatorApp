import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {beginRollbackContext,query,closeDb} from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import {createSpecialClosureService} from '../../../src/special-stock-closure-service.js';
import {readSpecialClosedOrders} from '../../../src/special-stock-closed-orders.js';
after(closeDb);
const context={operatorId:'TEST-LOCAL-CLOSE',authorizedStoreLocationIds:[1]};
async function fixture(run) {
  const tx=await beginRollbackContext();
  try {await tx.run(async()=>{
    await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES($1,$1,'TEST','hash','salt','sales',ARRAY['sales'],ARRAY[1]) ON CONFLICT DO NOTHING",[context.operatorId]);
    const d=await repo.createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST',vendorName:'TEST',fulfillmentMethod:'yard_pickup',lines:[{productName:'TEST',quantity:5,uom:'Pcs',rate:20,requiredDate:'2099-02-01'}]},context);
    await query("INSERT INTO sales_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES(8877811,'TEST-LOCAL-SO','Pending Fulfillment',true)");
    await query("INSERT INTO purchase_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES(8877812,'TEST-LOCAL-PO','Pending Receipt',true)");
    await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=8877811,sales_order_ref='TEST-LOCAL-SO',purchase_order_netsuite_id=8877812,purchase_order_ref='TEST-LOCAL-PO',sales_order_approved=true WHERE request_id=$1",[d.id]);
    await query("INSERT INTO sales_special_stock_handoffs(request_id,route,status,sales_order_netsuite_id,purchase_order_netsuite_id,pickup_address,destination_address,operational_yard_location_id,line_snapshot) VALUES($1,'direct','ready',8877811,8877812,'TEST vendor','TEST destination',1,'[]')",[d.id]);
    const boundary={queryAll:async sql=>{
      const so=sql.includes('t.id = 8877811');
      return [{id:so?'8877811':'8877812',tranid:so?'TEST-LOCAL-SO':'TEST-LOCAL-PO',type:so?'SalesOrd':'PurchOrd',status:'H',status_text:so?'Sales Order : Closed':'Purchase Order : Closed'}];
    }};
    const service=createSpecialClosureService({readClosedOrders:detail=>readSpecialClosedOrders(detail,boundary),
      resolveOrderUnits:async()=>assert.fail('Closed orders need no unit resolution'),preparePlan:async()=>assert.fail('Closed orders need no remote plan'),
      applyPlan:async()=>assert.fail('No NetSuite writes allowed')});
    await run({d:await repo.getSpecialStockCase(d.id),service,boundary});
  });} finally {await tx.rollback();}
}

test('local reconciliation finishes the confirmed attention journal despite historical execution and preserves original confirmer',()=>fixture(async({d,service})=>{
  const pending=await repo.requestSpecialCaseClosure(d.id,{expectedRevision:d.revision,reason:'Already closed'},context);
  const review={...pending.closureReview,status:'attention',confirmedBy:context.operatorId,confirmedAt:'2026-09-30T19:40:00Z',error:'Workflow lock'};
  await query('UPDATE sales_special_stock_cases SET closure_review=$2::jsonb,operationally_complete=true WHERE request_id=$1',[d.id,JSON.stringify(review)]);
  await query("UPDATE sales_orders SET fulfilled_at='2026-09-30T18:00:00Z' WHERE netsuite_id=8877811");
  await query("UPDATE purchase_orders SET received_at='2026-09-30T18:00:00Z' WHERE netsuite_id=8877812");
  await query("UPDATE sales_special_stock_handoffs SET status='completed' WHERE request_id=$1",[d.id]);
  const current=await repo.getSpecialStockCase(d.id);
  const result=await service.reviewClosure(d.id,{expectedRevision:current.revision,reviewId:review.id,decision:'approve'},{operatorId:null});
  assert.equal(result.closeStatus,'closed');assert.equal(result.status,'cancelled');assert.equal(result.closureReview.id,review.id);
  assert.equal(result.closureReview.status,'approved');assert.equal(result.closureReview.confirmedBy,review.confirmedBy);
  assert.equal(result.closureReview.confirmedAt,review.confirmedAt);assert.equal(result.closureReview.error,null);
  assert.equal(result.closureReview.localOnly,true);assert.equal(result.closureReview.remoteStarted,false);
  assert.equal((await query('SELECT status FROM sales_special_stock_handoffs WHERE request_id=$1',[d.id])).rows[0].status,'completed');
  assert.ok((await query('SELECT fulfilled_at FROM sales_orders WHERE netsuite_id=8877811')).rows[0].fulfilled_at);
  assert.ok((await query('SELECT received_at FROM purchase_orders WHERE netsuite_id=8877812')).rows[0].received_at);
  assert.deepEqual((await query("SELECT status FROM sales_orders WHERE netsuite_id=8877811 UNION ALL SELECT status FROM purchase_orders WHERE netsuite_id=8877812")).rows.map(row=>row.status),['closed','closed']);
  const event=(await query("SELECT details FROM sales_special_stock_events WHERE request_id=$1 AND event_type='special_case_closed'",[d.id])).rows[0];
  assert.equal(event.details.localOnly,true);assert.equal(event.details.verifiedOrders.length,2);
  const again=await service.reviewClosure(d.id,{expectedRevision:result.revision,reviewId:review.id,decision:'approve'},context);
  assert.equal(again.revision,result.revision);
}));

test('Sales closes a remote Closed pair locally without SCM cancellation and retains commercial lines',()=>fixture(async({d,service})=>{
  const before=(await query('SELECT to_jsonb(l) AS data FROM sales_special_stock_lines l WHERE request_id=$1 ORDER BY id',[d.id])).rows;
  const result=await service.requestClosure(d.id,{expectedRevision:d.revision,reason:'Both orders already closed'},context);
  assert.equal(result.closeStatus,'closed');assert.equal(result.closureReview.status,'approved');assert.equal(result.closureReview.localOnly,true);
  assert.deepEqual((await query('SELECT to_jsonb(l) AS data FROM sales_special_stock_lines l WHERE request_id=$1 ORDER BY id',[d.id])).rows,before);
  assert.equal((await query('SELECT status FROM sales_special_stock_handoffs WHERE request_id=$1',[d.id])).rows[0].status,'cancelled');
  assert.equal(result.closureReviewPlan,undefined);
}));

test('local closure preserves Sales scope, stale revision and reason guards',()=>fixture(async({d,service})=>{
  await assert.rejects(service.requestClosure(d.id,{expectedRevision:d.revision,reason:'Closed'},{...context,authorizedStoreLocationIds:[28]}),{status:403});
  await assert.rejects(service.requestClosure(d.id,{expectedRevision:d.revision+1,reason:'Closed'},context),{status:409});
  await assert.rejects(service.requestClosure(d.id,{expectedRevision:d.revision,reason:''},context),{status:400});
  assert.equal((await repo.getSpecialStockCase(d.id)).closeStatus,'active');
}));

test('an active Dispatch plan still blocks local closure of remote Closed orders',()=>fixture(async({d,service})=>{
  await query('UPDATE sales_orders SET dispatch_planned=true WHERE netsuite_id=8877811');
  await assert.rejects(service.requestClosure(d.id,{expectedRevision:d.revision,reason:'Closed'},context),{code:'SPECIAL_CLOSURE_PLANNED'});
  assert.equal((await repo.getSpecialStockCase(d.id)).closeStatus,'active');
}));

test('local finalization validates exact current links and review before any partial local update',()=>fixture(async({d})=>{
  assert.equal(typeof repo.closeSpecialCaseForClosedOrders,'function');
  const evidence={orders:[{id:8877811,kind:'sales_order',reference:'TEST-LOCAL-SO',type:'SalesOrd',status:'H',statusText:'Closed'}]};
  await assert.rejects(repo.closeSpecialCaseForClosedOrders(d.id,{expectedRevision:d.revision,reason:'Closed',closedOrders:evidence},context),{status:409});
  const current=await repo.getSpecialStockCase(d.id);assert.equal(current.closeStatus,'active');assert.equal(current.revision,d.revision);
  assert.equal((await query('SELECT status_text FROM sales_orders WHERE netsuite_id=8877811')).rows[0].status_text,'Pending Fulfillment');
}));

test('pending quantity and uncertain order operations cannot be discarded by local closure',()=>fixture(async({d,service})=>{
  for(const change of ["quantity_review='{\"id\":\"TEST\",\"status\":\"pending\"}'::jsonb","sales_order_operation_status='attention'"]) {
    await query(`UPDATE sales_special_stock_cases SET ${change} WHERE request_id=$1`,[d.id]);
    await assert.rejects(service.requestClosure(d.id,{expectedRevision:d.revision,reason:'Closed'},context),{status:409});
    await query("UPDATE sales_special_stock_cases SET quantity_review='{}',sales_order_operation_status='idle' WHERE request_id=$1",[d.id]);
  }
  assert.equal((await repo.getSpecialStockCase(d.id)).closeStatus,'active');
}));

test('authorized fulfilled-SO recovery closes only the request and preserves its actual Pending Billing status',()=>fixture(async({d,boundary})=>{
  const pending=await repo.requestSpecialCaseClosure(d.id,{expectedRevision:d.revision,reason:'Replacement request in NetSuite'},context);
  const original=boundary.queryAll;boundary.queryAll=async sql=>sql.includes('transactionline')?
    [{uniquekey:'999999',item:'2055',base_quantity:'-5',execution_quantity:'5'}]:
    (await original(sql)).map(row=>row.type==='SalesOrd'?{...row,status:'F',status_text:'Sales Order : Pending Billing'}:row);
  const service=createSpecialClosureService({readClosedOrders:detail=>readSpecialClosedOrders(detail,boundary,{allowFulfilledSalesOrder:true}),
    applyPlan:async()=>assert.fail('No NetSuite writes')});
  const input={expectedRevision:pending.revision,reviewId:pending.closureReview.id,decision:'approve'};
  await assert.rejects(service.reviewClosure(d.id,input,context),{status:409});
  assert.equal((await repo.getSpecialStockCase(d.id)).closeStatus,'closure_pending');
  const result=await service.reviewClosure(d.id,input,{...context,allowFulfilledSalesOrder:true});
  assert.equal(result.closeStatus,'closed');assert.equal(result.status,'cancelled');
  assert.equal(result.salesOrderStatus,'Sales Order : Pending Billing');
  const so=(await query('SELECT status,status_text FROM sales_orders WHERE netsuite_id=8877811')).rows[0];
  assert.equal(so.status,'F');assert.equal(so.status_text,'Sales Order : Pending Billing');
  assert.equal(result.purchaseOrderStatus,'Purchase Order : Closed');assert.equal(result.closureReview.localOnly,true);
}));

test('a rejected or mismatched review cannot authorize local finalization and causes no partial mirror update',()=>fixture(async({d,boundary})=>{
  const pending=await repo.requestSpecialCaseClosure(d.id,{expectedRevision:d.revision,reason:'Closed'},context);
  const closedOrders=await readSpecialClosedOrders(pending,boundary);
  await assert.rejects(repo.closeSpecialCaseForClosedOrders(d.id,{expectedRevision:pending.revision,reviewId:'wrong-review',closedOrders},context),{code:'SPECIAL_CLOSURE_STALE'});
  await query("UPDATE sales_special_stock_cases SET closure_review=jsonb_set(closure_review,'{status}','\"rejected\"') WHERE request_id=$1",[d.id]);
  await assert.rejects(repo.closeSpecialCaseForClosedOrders(d.id,{expectedRevision:pending.revision,reviewId:pending.closureReview.id,closedOrders},context),{code:'SPECIAL_CLOSURE_STALE'});
  assert.equal((await repo.getSpecialStockCase(d.id)).closeStatus,'closure_pending');
  assert.equal((await query('SELECT status_text FROM sales_orders WHERE netsuite_id=8877811')).rows[0].status_text,'Pending Fulfillment');
}));
