import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import * as repository from '../../../src/special-stock-request-repository.js';
import { createSpecialQuantityService } from '../../../src/special-stock-quantity-service.js';
import { prepareSpecialQuantityPlan, applySpecialQuantityPlan } from '../../../src/special-stock-quantity-adapter.js';

after(closeDb);
const context = { operatorId: 'special-pricing-test', authorizedStoreLocationIds: [1] };
async function fixture(run) {
  const rollback = await beginRollbackContext();
  try { await rollback.run(async () => {
    await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES('special-pricing-test','special-pricing-test','TEST','hash','salt','admin',ARRAY['admin'],ARRAY[1]) ON CONFLICT DO NOTHING");
    await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()) ON CONFLICT DO NOTHING");
    await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(8899400,'TEST','TEST Pricing','TEST Pricing','CAD',true,now(),'test',repeat('d',64)) ON CONFLICT DO NOTHING");
    await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ('special_stock_request_workflow','special_stock_request_test_skip_orders')");
    await run();
  }); } finally { await rollback.rollback(); }
}
async function enquiry() {
  return repository.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerId: 8899400,
    customerName: 'TEST Pricing', vendorId: 8899200, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
    lines: [{ productName: 'TEST priced pallets', quantity: 2, uom: 'PLT', rate: 120, discountPercent: 10, requiredDate: '2099-02-01' }] }, context);
}
function soInput(detail, quantity = 2, extra = {}) {
  return { expectedRevision: detail.revision, customerId: 8899400, operationalYardLocationId: 1, fulfillmentMethod: 'yard_pickup', palletTotal: 0,
    materialLines: [{ caseLineId: detail.lines[0].id, itemId: 2055, description: 'TEST priced pallets', packageQuantity: quantity,
      conversionToPc: 12, quantity: quantity * 12, uom: 'PC', rate: 120, discountPercent: 10, ...extra }] };
}
async function draft() {
  let d = await enquiry();
  d = await repository.respondSpecialStockLine(d.id,d.lines[0].id,{ expectedRevision:d.revision, supplyStatus:'in_stock', availabilityMode:'no_projection',vendorId:8899200,vendorName:'TEST Vendor',vendorYard:'TEST yard'},context);
  d = await repository.decideSpecialStockLine(d.id,d.lines[0].id,{expectedRevision:d.revision,decision:'accepted'},context);
  return repository.saveSpecialSalesOrderDraft(d.id,soInput(d),context);
}
const reviewInput = d => ({ expectedRevision: d.revision, reviewId: d.quantityReview.id });

test('enquiry price and discount persist and SO uses the explicit PC conversion',()=>fixture(async()=>{
  const e = await enquiry();
  assert.equal(e.lines[0].originalRate,120); assert.equal(e.lines[0].discountPercent,10); assert.equal(e.lines[0].subtotal,216);
  const d = await draft();
  assert.equal(d.salesOrderLines[0].quantity,24); assert.equal(d.salesOrderLines[0].rate,9);
  assert.equal(d.lines[0].packageQuantity,2); assert.equal(d.lines[0].conversionToPc,12);
  assert.equal(d.quantityReviewPending,false);
}));
test('server rejects original-rate tampering and unpriced or missing conversions',()=>fixture(async()=>{
  const d=await draft();
  await assert.rejects(()=>repository.saveSpecialSalesOrderDraft(d.id,soInput(d,2,{rate:119}),context),{code:'SPECIAL_RATE_LOCKED'});
  await assert.rejects(()=>repository.saveSpecialSalesOrderDraft(d.id,soInput(d,2,{conversionToPc:null}),context),{code:'SPECIAL_CONVERSION_INVALID'});
  const discounted=await repository.saveSpecialSalesOrderDraft(d.id,soInput(d,2,{discountPercent:25}),context);
  assert.equal(discounted.salesOrderLines[0].rate,7.5); assert.equal(discounted.lines[0].originalRate,120);
}));
test('changed draft quantities alert SCM, sort first and block SO release until approval',()=>fixture(async()=>{
  let d=await draft();
  d=await repository.saveSpecialSalesOrderDraft(d.id,soInput(d,3),context);
  assert.equal(d.quantityReviewPending,true); assert.equal(d.quantityReview.lines[0].fromQuantity,24); assert.equal(d.quantityReview.lines[0].toQuantity,36);
  const newer=await enquiry();
  await query("UPDATE sales_stock_requests SET updated_at=now()+interval '1 day' WHERE id=$1",[newer.id]);
  assert.equal((await repository.listSpecialStockCases({audience:'scm'}))[0].id,d.id);
  await assert.rejects(()=>repository.skipSpecialOrderCreation(d.id,{expectedRevision:d.revision,orderKind:'sales_order'},context),{code:'SPECIAL_QUANTITY_REVIEW_REQUIRED'});
  await assert.rejects(()=>repository.claimSpecialOrderOperation(d.id,{expectedRevision:d.revision,orderKind:'sales_order',operationId:'d9c97e50-5c7d-4227-8d37-000000000101'},context),{code:'SPECIAL_QUANTITY_REVIEW_REQUIRED'});
  await assert.rejects(()=>repository.linkSpecialSalesOrder(d.id,{expectedRevision:d.revision,salesOrderId:9999111,salesOrderRef:'TEST'},context),{code:'SPECIAL_QUANTITY_REVIEW_REQUIRED'});
  const old=d;
  d=await repository.claimSpecialQuantityReview(d.id,reviewInput(d),context);
  d=await repository.finishSpecialQuantityReview(d.id,{reviewId:d.quantityReview.id},context);
  assert.equal(d.quantityReviewPending,false); assert.equal(d.lines[0].reviewedPackageQuantity,3);
  assert.equal(d.salesOrderLines[0].quantity,36); assert.equal(d.salesOrderLines[0].rate,9);
  await assert.rejects(()=>repository.claimSpecialQuantityReview(old.id,reviewInput(old),context),{code:'SPECIAL_REVISION_CONFLICT'});
}));
test('SCM rejection restores the reviewed draft and conversion changes also require review',()=>fixture(async()=>{
  let d=await draft();
  d=await repository.saveSpecialSalesOrderDraft(d.id,soInput(d,3),context);
  d=await repository.rejectSpecialQuantityReview(d.id,{...reviewInput(d),reason:'Only two pallets available'},context);
  assert.equal(d.salesOrderLines[0].quantity,24); assert.equal(d.lines[0].packageQuantity,2); assert.equal(d.quantityReviewPending,false);
  d=await repository.saveSpecialSalesOrderDraft(d.id,soInput(d,2,{conversionToPc:10,quantity:20}),context);
  assert.equal(d.quantityReviewPending,true); assert.equal(d.quantityReview.lines[0].toQuantity,20);
  d=await repository.rejectSpecialQuantityReview(d.id,reviewInput(d),context);
  assert.equal(d.salesOrderLines[0].quantity,24); assert.equal(d.salesOrderLines[0].rate,9);
  assert.equal(d.lines[0].conversionToPc,12);
}));
test('issued test orders hold proposals until SCM approves both local quantities without changing rates',()=>fixture(async()=>{
  let d=await draft();
  d=await repository.skipSpecialOrderCreation(d.id,{expectedRevision:d.revision,orderKind:'sales_order'},context);
  d=await repository.skipSpecialOrderCreation(d.id,{expectedRevision:d.revision,orderKind:'purchase_order',lines:[{caseLineId:d.lines[0].id,description:'TEST',quantity:24,uom:'PC',unitPurchaseCost:4}]},context);
  const oldRate=d.salesOrderLines[0].rate;
  d=await repository.requestSpecialQuantityChange(d.id,{expectedRevision:d.revision,lines:[{caseLineId:d.lines[0].id,quantity:3}]},context);
  assert.equal(d.salesOrderLines[0].quantity,24); assert.equal(d.purchaseOrderLines[0].quantity,24);
  d=await repository.claimSpecialQuantityReview(d.id,reviewInput(d),context);
  d=await repository.finishSpecialQuantityReview(d.id,{reviewId:d.quantityReview.id},context);
  assert.equal(d.salesOrderLines[0].quantity,36); assert.equal(d.purchaseOrderLines[0].quantity,36);
  assert.equal(d.salesOrderLines[0].rate,oldRate); assert.equal(d.salesOrderId,null);assert.equal(d.purchaseOrderId,null);
  assert.equal(d.events.filter(e=>e.eventType==='special_quantity_review_approved').length,1);
}));

test('real pair retains a partial update, recovers exact lines and invalidates the old Dispatch quantities',()=>fixture(async()=>{
  let d=await draft();
  const orders=new Map();
  for(const [kind,id,rate]of [['sales_order',8899501,9],['purchase_order',8899502,4]]) {
    const sales=kind==='sales_order',ref=`TEST-PRICING-${id}`;
    if(sales) await query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,order_location_id,order_location,outbound_location_id,outbound_location,status_text,netsuite_active) VALUES($1,$2,8899400,1,'3445',1,'3445','Pending Fulfillment',true)",[id,ref]);
    else await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,status_text,netsuite_active) VALUES($1,$2,8899200,1,'Pending Receipt',true)",[id,ref]);
    const inserted=await query(`INSERT INTO ${sales?'sales_order_lines':'purchase_order_lines'}(${kind}_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES($1,$2,2055,'MBBS-Special Order','TEST priced pallets',24,'PC',true) RETURNING id`,[id,id*100+1]);
    orders.set(id,{localId:inserted.rows[0].id,kind,ref,items:[{line:3,item:{id:'2055'},quantity:24,rate,units:{id:'865'},description:'TEST priced pallets'}]});
    await query("UPDATE sales_special_stock_order_lines SET remote_line_id=$3,unit_purchase_cost=4 WHERE request_id=$1 AND order_kind=$2",[d.id,kind,id*100+1]);
  }
  await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=8899501,sales_order_ref='TEST-PRICING-8899501',sales_order_status='Pending Fulfillment',sales_order_approved=true,purchase_order_netsuite_id=8899502,purchase_order_ref='TEST-PRICING-8899502',purchase_order_status='Pending Receipt',handoff_route='direct' WHERE request_id=$1",[d.id]);
  await query("INSERT INTO sales_special_stock_handoffs(request_id,route,status,sales_order_netsuite_id,purchase_order_netsuite_id,pickup_address,destination_address,operational_yard_location_id,line_snapshot) VALUES($1,'direct','ready',8899501,8899502,'TEST yard','3445',1,'[]')",[d.id]);
  await query("INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,allocated_sales_qty,dispatch_target_ref,dispatch_target_line_key) VALUES(8899501,'TEST-PRICING-8899501',$1,8899502,'TEST-PRICING-8899502',$2,2055,24,'TEST-PRICING-8899501','TEST-PRICING-8899501::line')",[orders.get(8899501).localId,orders.get(8899502).localId]);
  let fail=true,patches=[];
  const boundary={queryAll:async sql=>{const id=Number(sql.match(/tl\.transaction\s*=\s*(\d+)/)[1]);return [{uniquekey:id*100+1,rest_line_id:3,item:2055,execution_quantity:0,billed_quantity:0,line_closed:'F',status_text:orders.get(id).kind==='sales_order'?'Pending Fulfillment':'Pending Receipt'}];},
    rest:async(path,options={})=>{const id=Number(path.match(/\/(\d+)(?:\?|$)/)[1]),order=orders.get(id);
      if(options.method==='PATCH'){if(id===8899502&&fail){fail=false;throw new Error('TEST failed PO');}patches.push(id);order.items[0].quantity=options.body.item.items[0].quantity;}
      return {data:{item:{items:structuredClone(order.items)}}};}};
  const service=createSpecialQuantityService({preparePlan:input=>prepareSpecialQuantityPlan(input,boundary),applyPlan:plan=>applySpecialQuantityPlan(plan,boundary),resolveOrderUnits:async lines=>lines.map(line=>({...line,unitId:865}))});
  d=await repository.requestSpecialQuantityChange(d.id,{expectedRevision:d.revision,lines:[{caseLineId:d.lines[0].id,quantity:3}]},context);
  await assert.rejects(()=>service.reviewQuantityChange(d.id,{...reviewInput(d),decision:'approve'},context),/TEST failed PO/);
  d=await repository.getSpecialStockCase(d.id,{audience:'scm'});
  assert.equal(d.quantityReview.status,'attention');assert.equal(d.salesOrderLines[0].quantity,24);assert.equal(d.quantityReviewPlan.orders.length,2);
  const sales=await repository.getSpecialStockCase(d.id,{audience:'sales',authorizedStoreLocationIds:[1]});assert.equal('quantityReviewPlan' in sales,false);
  await assert.rejects(()=>repository.rejectSpecialQuantityReview(d.id,reviewInput(d),context),{code:'SPECIAL_QUANTITY_REVIEW_BUSY'});
  d=await service.reviewQuantityChange(d.id,{...reviewInput(d),decision:'approve'},context);
  assert.deepEqual(patches,[8899501,8899502]);assert.equal(d.quantityReview.status,'approved');assert.equal(d.purchaseOrderLines[0].quantity,36);
  assert.equal(d.salesOrderLines[0].rate,9);assert.equal(d.handoff.status,'waiting_route');
  assert.equal((await query('SELECT status FROM dispatch_so_po_allocations WHERE sales_order_id=8899501')).rows[0].status,'cancelled');
  assert.equal(d.handoffRoute,'none');
}));

test('one quantity confirmation owns the case lock and the lock releases after failure',async()=>{
  let unlock;const pending=new Promise(resolve=>{unlock=resolve;});
  let entered;const ready=new Promise(resolve=>{entered=resolve;});
  const first=repository.withSpecialQuantityReviewLock(8899500,async()=>{entered();await pending;throw new Error('TEST interrupted');});
  await ready;
  await assert.rejects(()=>repository.withSpecialQuantityReviewLock(8899500,async()=>{}),{code:'SPECIAL_QUANTITY_REVIEW_BUSY'});
  unlock();await assert.rejects(()=>first,/TEST interrupted/);
  assert.equal(await repository.withSpecialQuantityReviewLock(8899500,async()=>42),42);
});

test('an aged delivery date before submission returns to an editable draft without remote uncertainty',()=>fixture(async()=>{
  let d=await draft();
  await query("UPDATE sales_special_stock_cases SET fulfillment_method='mbt_delivery',delivery_address='TEST address',delivery_date='2000-01-01' WHERE request_id=$1",[d.id]);
  const operationId='d9c97e50-5c7d-4227-8d37-000000000105';
  d=await repository.claimSpecialOrderOperation(d.id,{expectedRevision:d.revision,orderKind:'sales_order',operationId},context);
  await assert.rejects(()=>repository.markSpecialOrderSubmitted(d.id,{expectedRevision:d.revision,orderKind:'sales_order',operationId},context),{code:'SPECIAL_DELIVERY_DATE_TOO_SOON'});
  d=await repository.failSpecialOrderOperation(d.id,{orderKind:'sales_order',operationId,errorCode:'SPECIAL_DELIVERY_DATE_TOO_SOON',errorMessage:'Choose a later date'},context);
  assert.equal(d.salesOrderOperationStatus,'idle');assert.equal(d.salesOrderSubmissionStartedAt,null);
  d=await repository.saveSpecialSalesOrderDraft(d.id,soInput(d),context);assert.equal(d.quantityReviewPending,false);
}));

test('pricing migration preserves legacy order prices, leaves unknown rates unset and rolls back its schema changes',()=>fixture(async()=>{
  const d=await draft(),unpriced=await enquiry();
  await query('SAVEPOINT pricing_migration_rehearsal');
  await query(`ALTER TABLE sales_special_stock_lines DROP COLUMN original_unit_rate, DROP COLUMN original_rate_uom,
    DROP COLUMN pricing_source, DROP COLUMN quoted_discount_percent, DROP COLUMN discount_percent,
    DROP COLUMN sales_package_quantity, DROP COLUMN pieces_per_unit, DROP COLUMN scm_reviewed_quantity,
    DROP COLUMN scm_reviewed_pieces_per_unit`);
  await query('ALTER TABLE sales_special_stock_cases DROP COLUMN quantity_review');
  const migration=await readFile('migrations/228_special_workflow_pricing.sql','utf8');
  await query(migration);
  const legacy=await repository.getSpecialStockCase(d.id);
  assert.equal(legacy.lines[0].originalRate,9);assert.equal(legacy.lines[0].rateUom,'PC');assert.equal(legacy.lines[0].conversionToPc,1);
  assert.equal(legacy.lines[0].packageQuantity,24);
  assert.equal((await repository.getSpecialStockCase(unpriced.id)).lines[0].originalRate,null);
  assert.equal((await repository.getSpecialStockCase(unpriced.id)).lines[0].rateUom,'PC');
  await query(migration);
  assert.equal((await repository.getSpecialStockCase(d.id)).lines[0].originalRate,9);
  await query('SAVEPOINT immutable_price');
  await assert.rejects(()=>query('UPDATE sales_special_stock_lines SET original_unit_rate=99 WHERE request_id=$1',[d.id]),{code:'23514'});
  await query('ROLLBACK TO SAVEPOINT immutable_price');
  await query('ROLLBACK TO SAVEPOINT pricing_migration_rehearsal');
  assert.equal((await repository.getSpecialStockCase(d.id)).lines[0].originalRate,120);
}));

test('malformed, closed and mixed real/test quantity proposals cannot alter issued quantities',()=>fixture(async()=>{
  let d=await draft();
  d=await repository.skipSpecialOrderCreation(d.id,{expectedRevision:d.revision,orderKind:'sales_order'},context);
  for(const lines of [[],[{caseLineId:d.lines[0].id,quantity:3},{caseLineId:d.lines[0].id,quantity:4}]]) {
    await assert.rejects(()=>repository.requestSpecialQuantityChange(d.id,{expectedRevision:d.revision,lines},context),{code:'SPECIAL_QUANTITY_LINES_INVALID'});
  }
  const proposal={expectedRevision:d.revision,lines:[{caseLineId:d.lines[0].id,quantity:3}]};
  await query("UPDATE sales_special_stock_cases SET close_status='closed' WHERE request_id=$1",[d.id]);
  await assert.rejects(()=>repository.requestSpecialQuantityChange(d.id,proposal,context),{code:'SPECIAL_QUANTITY_LOCKED'});
  await query("UPDATE sales_special_stock_cases SET close_status='active',sales_order_skipped=false,sales_order_netsuite_id=8899560,sales_order_ref='TEST-MIXED-8899560',purchase_order_skipped=true WHERE request_id=$1",[d.id]);
  await assert.rejects(()=>repository.requestSpecialQuantityChange(d.id,proposal,context),{code:'SPECIAL_TEST_ORDER_REMOTE_BLOCKED'});
  const current=await repository.getSpecialStockCase(d.id);assert.equal(current.salesOrderLines[0].quantity,24);assert.equal(current.revision,d.revision);
}));
