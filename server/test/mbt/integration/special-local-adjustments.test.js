import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import * as repository from '../../../src/special-stock-request-repository.js';
import { createSpecialQuantityService } from '../../../src/special-stock-quantity-service.js';

after(closeDb);
const context={operatorId:'special-local-adjustment-test',authorizedStoreLocationIds:[1]};
async function fixture(run) {
  const rollback=await beginRollbackContext();
  try { await rollback.run(async()=>{
    await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES($1,$1,'TEST','hash','salt','admin',ARRAY['admin'],ARRAY[1]) ON CONFLICT DO NOTHING",[context.operatorId]);
    await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()),(1784,'PALLET','EACH','{}',now()) ON CONFLICT DO NOTHING");
    await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(8899800,'TEST','TEST Local Adjustment','TEST Local Adjustment','CAD',true,now(),'test',repeat('d',64)) ON CONFLICT DO NOTHING");
    await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
    let d=await repository.createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerId:8899800,
      customerName:'TEST Local Adjustment',vendorId:8899200,vendorName:'TEST Vendor',fulfillmentMethod:'yard_pickup',
      lines:[1,2,3].map(i=>({productName:`TEST Local ${i}`,quantity:2,uom:'PCS',rate:10,requiredDate:'2099-02-01'}))},context);
    for(const line of d.lines) {
      d=await repository.respondSpecialStockLine(d.id,line.id,{expectedRevision:d.revision,supplyStatus:line.lineNumber===3?'vendor_transfer':'in_stock',
        availabilityMode:line.lineNumber===3?'dated':'no_projection',...(line.lineNumber===3?{availableDate:'2099-02-01'}:{}),
        vendorId:8899200,vendorName:'TEST Vendor',vendorYard:'TEST Yard'},context);
      d=await repository.decideSpecialStockLine(d.id,line.id,{expectedRevision:d.revision,decision:'accepted'},context);
    }
    d=await repository.saveSpecialSalesOrderDraft(d.id,{expectedRevision:d.revision,customerId:8899800,operationalYardLocationId:1,
      fulfillmentMethod:'yard_pickup',palletTotal:2,palletRate:40,materialLines:d.lines.map(line=>({caseLineId:line.id,itemId:2055,
        description:line.productName,packageQuantity:2,conversionToPc:1,quantity:2,uom:'PC',rate:10,discountPercent:0}))},context);
    await query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,order_location_id,order_location,outbound_location_id,outbound_location,status_text,netsuite_active) VALUES(8899801,'TEST-LOCAL-SO',8899800,1,'3445',1,'3445','Pending Fulfillment',true)");
    await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,status_text,netsuite_active) VALUES(8899802,'TEST-LOCAL-PO',8899200,1,'Pending Receipt',true)");
    for(const [index,line] of d.lines.entries()) {
      await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES(8899801,$1,2055,'MBBS-Special Order',$2,2,'PC',true)",[100+index,line.productName]);
      await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES(8899802,$1,2055,'MBBS-Special Order',$2,2,'PC',true)",[200+index,line.productName]);
      await query("UPDATE sales_special_stock_order_lines SET remote_line_id=CASE WHEN order_kind='sales_order' THEN $3::bigint ELSE $4::bigint END,unit_purchase_cost=4 WHERE request_id=$1 AND case_line_id=$2",[d.id,line.id,100+index,200+index]);
    }
    await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES(8899801,103,1784,'PALLET','PALLET',2,'EACH',true)");
    await query("UPDATE sales_special_stock_order_lines SET remote_line_id=103 WHERE request_id=$1 AND item_id=1784",[d.id]);
    await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=8899801,sales_order_ref='TEST-LOCAL-SO',sales_order_approved=true,purchase_order_netsuite_id=8899802,purchase_order_ref='TEST-LOCAL-PO' WHERE request_id=$1",[d.id]);
    await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,allocated_sales_qty,dispatch_target_ref,dispatch_target_line_key)
      SELECT 8899801,'TEST-LOCAL-SO',so.id,8899802,'TEST-LOCAL-PO',po.id,2055,2,'TEST-LOCAL-SO','TEST-LOCAL-SO::line'
      FROM sales_order_lines so,purchase_order_lines po WHERE so.sales_order_id=8899801 AND so.line_id=100 AND po.purchase_order_id=8899802 AND po.line_id=200`);
    await run(await repository.getSpecialStockCase(d.id),d.id);
  }); } finally { await rollback.rollback(); }
}
const proposal=(d,removeIds=[])=>({expectedRevision:d.revision,lines:d.lines.filter(l=>l.salesDecision==='accepted').map(l=>
  removeIds.includes(l.id)?{caseLineId:l.id,remove:true}:{caseLineId:l.id,quantity:l.packageQuantity,discountPercent:l.discountPercent})});
const decision=d=>({reviewId:d.quantityReview.id,expectedRevision:d.revision,decision:'approve'});
const service=()=>createSpecialQuantityService();
async function ordersSnapshot(id) {
  return (await query(`SELECT
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM sales_special_stock_order_lines o WHERE request_id=$1) AS issued,
    (SELECT to_jsonb(o) FROM sales_orders o WHERE netsuite_id=8899801) AS sales,
    (SELECT to_jsonb(o) FROM purchase_orders o WHERE netsuite_id=8899802) AS purchase,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM sales_order_lines o WHERE sales_order_id=8899801) AS sales_lines,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM purchase_order_lines o WHERE purchase_order_id=8899802) AS purchase_lines,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM dispatch_so_po_allocations o WHERE sales_order_id=8899801) AS allocations`,[id])).rows[0];
}

test('local removal waits for SCM then hides the line and retains its row, history and every issued order record',()=>fixture(async(d,id)=>{
  const removed=d.lines[2].id, before=await ordersSnapshot(id);
  d=await repository.requestSpecialQuantityChange(id,proposal(d,[removed]),context);
  assert.equal(d.lines.length,3); assert.equal(d.quantityReview.localOnly,true); assert.equal(d.quantityReview.lines.length,1);
  d=await service().reviewQuantityChange(id,decision(d),context);
  assert.deepEqual(d.lines.map(l=>l.id),d.lines.map(l=>l.id).filter(n=>n!==removed)); assert.equal(d.lines.length,2);
  assert.equal(d.readinessAlerts.some(a=>a.lineId===removed),false);
  const archived=(await query('SELECT sales_decision,removed_at,removed_by FROM sales_special_stock_lines WHERE id=$1',[removed])).rows[0];
  assert.equal(archived.sales_decision,'accepted'); assert.ok(archived.removed_at); assert.equal(archived.removed_by,context.operatorId);
  assert.equal(d.events.filter(e=>e.eventType==='special_request_line_removed'&&e.lineId===removed).length,1);
  assert.equal((await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[id])).rows[0].stage,d.stage);
  assert.deepEqual(await ordersSnapshot(id),before);
  const approved=d; d=await service().reviewQuantityChange(id,{...decision(d)},context);
  assert.equal(d.revision,approved.revision); assert.equal(d.events.filter(e=>e.eventType==='special_quantity_review_approved').length,1);
}));
test('unprepared delivery failure permits local removal through SCM while preserving the failed journal and issued orders',()=>fixture(async(d,id)=>{
  const journal={id:'test-failed-delivery',status:'attention',error:'A complete, distinct NetSuite order is required.',
    target:{fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST delivery'},requestedBy:context.operatorId};
  await query('UPDATE sales_special_stock_cases SET fulfillment_change=$2::jsonb,attention=true,attention_reason=$3 WHERE request_id=$1',
    [id,JSON.stringify(journal),'PALLET reconciliation requires attention']);
  const before=await ordersSnapshot(id),removed=d.lines[0].id;
  d=await repository.requestSpecialQuantityChange(id,proposal(d,[removed]),context);
  assert.equal(d.quantityReview.status,'pending');assert.equal(d.lines.length,3);
  d=await service().reviewQuantityChange(id,decision(d),context);
  assert.equal(d.quantityReview.status,'approved');assert.equal(d.lines.length,2);
  assert.equal(d.lines.some(line=>line.id===removed),false);
  assert.equal(d.events.filter(event=>event.eventType==='special_request_line_removed').length,1);
  assert.deepEqual(await ordersSnapshot(id),before);
  const saved=(await query('SELECT fulfillment_change,attention,attention_reason FROM sales_special_stock_cases WHERE request_id=$1',[id])).rows[0];
  assert.deepEqual(saved,{fulfillment_change:journal,attention:true,attention_reason:'PALLET reconciliation requires attention'});
  assert.ok((await query('SELECT removed_at FROM sales_special_stock_lines WHERE id=$1',[removed])).rows[0].removed_at);
  await assert.rejects(()=>repository.respondSpecialStockLine(id,d.lines[0].id,{expectedRevision:d.revision,
    supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:8899200,vendorName:'TEST Vendor',vendorYard:'TEST Yard'},context),{code:'SPECIAL_OPERATION_BUSY'});
}));
test('delivery locks remain enforced at proposal, SCM claim and completion when remote work can be active',()=>fixture(async(d,id)=>{
  const before=await ordersSnapshot(id);
  const locked=[{status:'applying'},{status:'applying',plan:{}},{status:'attention',plan:{}}];
  for(const journal of locked){
    await query('UPDATE sales_special_stock_cases SET fulfillment_change=$2::jsonb WHERE request_id=$1',[id,JSON.stringify(journal)]);
    await assert.rejects(()=>repository.requestSpecialQuantityChange(id,proposal(d,[d.lines[0].id]),context),{code:'SPECIAL_OPERATION_BUSY'});
  }
  await query("UPDATE sales_special_stock_cases SET fulfillment_change='{}'::jsonb WHERE request_id=$1",[id]);
  d=await repository.requestSpecialQuantityChange(id,proposal(d,[d.lines[0].id]),context);
  for(const journal of locked){
    await query('UPDATE sales_special_stock_cases SET fulfillment_change=$2::jsonb WHERE request_id=$1',[id,JSON.stringify(journal)]);
    await assert.rejects(()=>repository.claimSpecialQuantityReview(id,decision(d),context),{code:'SPECIAL_FULFILLMENT_PENDING'});
  }
  await query("UPDATE sales_special_stock_cases SET fulfillment_change='{}'::jsonb WHERE request_id=$1",[id]);
  d=await repository.claimSpecialQuantityReview(id,decision(d),context);
  for(const journal of locked){
    await query('UPDATE sales_special_stock_cases SET fulfillment_change=$2::jsonb WHERE request_id=$1',[id,JSON.stringify(journal)]);
    await assert.rejects(()=>repository.finishSpecialQuantityReview(id,{reviewId:d.quantityReview.id},context),{code:'SPECIAL_FULFILLMENT_PENDING'});
  }
  await query("UPDATE sales_special_stock_cases SET fulfillment_change='{\"status\":\"attention\"}'::jsonb,quantity_review=quantity_review || '{\"remoteStarted\":true}'::jsonb WHERE request_id=$1",[id]);
  await assert.rejects(()=>repository.finishSpecialQuantityReview(id,{reviewId:d.quantityReview.id},context),{code:'SPECIAL_FULFILLMENT_PENDING'});
  assert.deepEqual(await ordersSnapshot(id),before);
  assert.equal((await query('SELECT count(*)::int AS n FROM sales_special_stock_lines WHERE request_id=$1 AND removed_at IS NOT NULL',[id])).rows[0].n,0);
}));
test('SCM rejection preserves removed lines and all records; stale and foreign removals do not write',()=>fixture(async(d,id)=>{
  const old=d, before=await ordersSnapshot(id);
  await assert.rejects(()=>repository.requestSpecialQuantityChange(id,proposal(d,[d.lines[0].id]),{...context,authorizedStoreLocationIds:[28]}),{code:'SPECIAL_CASE_STORE_FORBIDDEN'});
  d=await repository.requestSpecialQuantityChange(id,proposal(d,[d.lines[0].id]),context);
  await assert.rejects(()=>repository.requestSpecialQuantityChange(id,proposal(old,[old.lines[0].id]),context),{code:'SPECIAL_REVISION_CONFLICT'});
  d=await service().reviewQuantityChange(id,{...decision(d),decision:'reject',reason:'Keep material'},context);
  assert.equal(d.lines.length,3); assert.equal(d.quantityReview.status,'rejected'); assert.deepEqual(await ordersSnapshot(id),before);
  assert.equal((await query('SELECT count(*)::int AS n FROM sales_special_stock_lines WHERE request_id=$1 AND removed_at IS NOT NULL',[id])).rows[0].n,0);
}));
test('planned orders permit local removal and edits; rejection and a webhook never mutate Dispatch or restore the line',()=>fixture(async(d,id)=>{
  await query('UPDATE sales_orders SET dispatch_planned=true WHERE netsuite_id=8899801');
  await query("INSERT INTO sales_special_stock_handoffs(request_id,route,status,sales_order_netsuite_id,purchase_order_netsuite_id,pickup_address,destination_address,operational_yard_location_id,line_snapshot) VALUES($1,'direct','planned',8899801,8899802,'TEST yard','3445',1,'[]')",[id]);
  const before=await ordersSnapshot(id),removed=d.lines[2].id;
  const input=proposal(d,[removed]); input.lines[0].quantity=4; input.lines[0].color='red'; input.palletTotal=0;
  d=await repository.requestSpecialQuantityChange(id,input,context);
  d=await service().reviewQuantityChange(id,decision(d),context);
  assert.equal(d.lines[0].packageQuantity,4); assert.equal(d.lines[0].color,'red'); assert.equal(d.palletTotal,0);
  assert.equal(d.lines[0].originalRate,10); assert.deepEqual(await ordersSnapshot(id),before); assert.equal(d.handoff.status,'planned');
  await repository.reconcileSpecialOrderWebhook({orderKind:'sales_order',orderId:8899801});
  d=await repository.getSpecialStockCase(id);
  assert.equal(d.lines.length,2); assert.equal(d.lines[0].packageQuantity,4); assert.equal(d.lines[0].color,'red');
  assert.equal(d.attention,false); assert.deepEqual(await ordersSnapshot(id),before);
  const next=proposal(d);next.lines[0].quantity=5;next.lines[0].discountPercent=20;
  d=await repository.requestSpecialQuantityChange(id,next,context);d=await service().reviewQuantityChange(id,decision(d),context);
  assert.equal(d.lines[0].packageQuantity,5);assert.equal(d.lines[0].discountPercent,20);assert.equal(d.lines[0].originalRate,10);
  assert.deepEqual(await ordersSnapshot(id),before);
}));
test('all-line removal remains local and completed requests stay locked',()=>fixture(async(d,id)=>{
  const before=await ordersSnapshot(id);
  d=await repository.requestSpecialQuantityChange(id,proposal(d,d.lines.map(l=>l.id)),context);
  d=await service().reviewQuantityChange(id,decision(d),context);
  assert.equal(d.lines.length,0);assert.equal(d.stage,'dispatch_arrangement');assert.equal(d.closeStatus,'active');
  assert.deepEqual(await ordersSnapshot(id),before);
  await query("UPDATE purchase_orders SET receipt_status='received' WHERE netsuite_id=8899802");
  await query("UPDATE sales_orders SET status_text='Pending Billing' WHERE netsuite_id=8899801");
  d=await repository.getSpecialStockCase(id);assert.equal(d.stage,'completed');
  await assert.rejects(()=>repository.requestSpecialQuantityChange(id,{expectedRevision:d.revision,lines:[],palletTotal:0},context),{code:'SPECIAL_QUANTITY_LOCKED'});
}));
test('removal migration is repeatable, preserves existing business rows and rolls back cleanly',()=>fixture(async(d,id)=>{
  const before=await ordersSnapshot(id); const count=(await query('SELECT count(*)::int AS n FROM sales_special_stock_lines WHERE request_id=$1',[id])).rows[0].n;
  const migration=await readFile('migrations/284_special_local_adjustments.sql','utf8');
  await query('SAVEPOINT local_adjustments_migration');
  await query('DROP VIEW special_stock_workflow_stages');
  await query('ALTER TABLE sales_special_stock_lines DROP COLUMN removed_at,DROP COLUMN removed_by');
  await query('ALTER TABLE sales_special_stock_cases DROP COLUMN local_adjusted_at');
  await query(migration);await query(migration);
  assert.deepEqual(await ordersSnapshot(id),before);
  assert.equal((await query('SELECT count(*)::int AS n FROM sales_special_stock_lines WHERE request_id=$1',[id])).rows[0].n,count);
  await query('ROLLBACK TO SAVEPOINT local_adjustments_migration');
  assert.equal((await repository.getSpecialStockCase(id)).lines.length,d.lines.length);
}));
test('a failed local approval rolls back every removal and audit row, then retries once after the fault is resolved',()=>fixture(async(d,id)=>{
  const before=await ordersSnapshot(id);
  d=await repository.requestSpecialQuantityChange(id,proposal(d,d.lines.slice(0,2).map(l=>l.id)),context);
  await query(`CREATE FUNCTION pg_temp.reject_local_removal() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.line_number=2 AND NEW.removed_at IS NOT NULL THEN RAISE EXCEPTION 'TEST local removal failure'; END IF; RETURN NEW; END $$`);
  await query('CREATE TRIGGER test_local_removal_failure BEFORE UPDATE ON sales_special_stock_lines FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_local_removal()');
  await assert.rejects(()=>service().reviewQuantityChange(id,decision(d),context),/TEST local removal failure/);
  d=await repository.getSpecialStockCase(id);assert.equal(d.quantityReview.status,'attention');assert.equal(d.lines.length,3);
  assert.equal(d.events.filter(e=>e.eventType==='special_request_line_removed').length,0);
  assert.deepEqual(await ordersSnapshot(id),before);
  await query('DROP TRIGGER test_local_removal_failure ON sales_special_stock_lines');
  d=await service().reviewQuantityChange(id,decision(d),context);
  assert.equal(d.lines.length,1);assert.equal(d.quantityReview.status,'approved');
  assert.equal(d.events.filter(e=>e.eventType==='special_request_line_removed').length,2);
  assert.equal(d.events.filter(e=>e.eventType==='special_quantity_review_approved').length,1);
}));
test('local removal before PO creation updates the draft, releases only remaining materials and preserves the issued SO',()=>fixture(async(d,id)=>{
  await query("UPDATE sales_special_stock_cases SET purchase_order_netsuite_id=NULL,purchase_order_ref=NULL WHERE request_id=$1",[id]);
  const removed=d.lines[2].id,input=proposal(d,[removed]);input.lines[0].quantity=4;input.lines[0].color='red';
  d=await repository.requestSpecialQuantityChange(id,input,context);
  d=await service().reviewQuantityChange(id,decision(d),context);
  assert.equal(d.purchaseOrderLines.length,2);assert.equal(d.purchaseOrderLines[0].quantity,4);
  assert.match(d.purchaseOrderLines[0].description,/red/);
  const sales=JSON.stringify(d.salesOrderLines);
  d=await repository.prepareSpecialPurchaseOrder(id,{expectedRevision:d.revision,pallet:{quantity:0},lines:d.purchaseOrderLines.map(line=>
    ({caseLineId:line.caseLineId,description:line.description,quantity:line.quantity,uom:line.uom,unitPurchaseCost:4,vendorDiscountPercent:0}))},context);
  assert.equal(d.purchaseOrderLines.length,2);assert.equal(JSON.stringify(d.salesOrderLines),sales);
  d=await repository.claimSpecialOrderOperation(id,{expectedRevision:d.revision,orderKind:'purchase_order',operationId:'13c13c13-0000-4000-8000-000000000001'},context);
  assert.equal(d.purchaseOrderOperationStatus,'creating');assert.equal(JSON.stringify(d.salesOrderLines),sales);
  assert.equal((await query("SELECT count(*)::int AS n FROM sales_special_stock_order_lines WHERE request_id=$1 AND case_line_id=$2 AND order_kind='purchase_order'",[id,removed])).rows[0].n,0);
}));
