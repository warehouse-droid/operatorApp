import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {beginRollbackContext,query,closeDb} from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import * as alerts from '../../../src/special-stock-alerts.js';
const context={operatorId:'special-enhancements-a',authorizedStoreLocationIds:[1,28]};
after(closeDb);
async function fixture(run){
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 const rollback=await beginRollbackContext();
 try{await rollback.run(async()=>{
 await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
 for(const id of ['special-enhancements-a','special-enhancements-b'])await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES($1,$1,$1,'hash','salt','sales',ARRAY['sales'],ARRAY[1,28]) ON CONFLICT DO NOTHING",[id]);
 await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()) ON CONFLICT DO NOTHING");
 for(const [id,name]of [[8899801,'Original customer'],[8899802,'Account lender']])await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES($1::bigint,$1::text,$2,$2,'CAD',true,now(),'test',repeat('e',64)) ON CONFLICT DO NOTHING",[id,name]);
 await run();
 });}finally{await rollback.rollback();}
}
async function enquiry(extra={},ctx=context){return repo.createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerId:8899801,customerName:'Original customer',customerPhone:'555-0199',vendorId:8899200,vendorName:'Vendor A',fulfillmentMethod:'yard_pickup',netsuiteSalesRep:{id:123,name:'Chosen Rep'},lines:[{productName:'Stone',detailSpec:'Honed edge',quantity:2,uom:'PLT',rate:120,discountPercent:10,requiredDate:'2099-02-01',palletQty:1,layerQty:2,sectionQty:3,pieceQty:4}],...extra},ctx);}
async function draft(){let d=await enquiry();d=await repo.respondSpecialStockLine(d.id,d.lines[0].id,{expectedRevision:d.revision,supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:8899200,vendorName:'Vendor A',vendorYard:'TEST'},context);d=await repo.decideSpecialStockLine(d.id,d.lines[0].id,{expectedRevision:d.revision,decision:'accepted'},context);return repo.saveSpecialSalesOrderDraft(d.id,{expectedRevision:d.revision,customerId:8899802,operationalYardLocationId:1,fulfillmentMethod:'yard_pickup',palletTotal:0,materialLines:[{caseLineId:d.lines[0].id,itemId:2055,description:'Stone · Honed edge',packageQuantity:2,conversionToPc:12,quantity:24,uom:'PC',rate:120,discountPercent:10,pieceQty:999}]},context);}

test('SO account selection preserves original customer ID/name/phone, pack details and prices',()=>fixture(async()=>{
 const d=await draft();assert.equal(d.customerId,8899801);assert.equal(d.customerName,'Original customer');assert.equal(d.customerPhone,'555-0199');
 assert.equal(d.netsuiteCustomerId,8899802);assert.equal(d.netsuiteCustomerName,'Account lender');assert.equal(d.netsuiteSalesRepId,123);assert.equal(d.requestedBy,'special-enhancements-a');
 assert.equal(d.lines[0].detailSpec,'Honed edge');assert.deepEqual([d.salesOrderLines[0].palletQty,d.salesOrderLines[0].layerQty,d.salesOrderLines[0].sectionQty,d.salesOrderLines[0].pieceQty],[1,2,3,4]);
 assert.equal(d.salesOrderLines[0].quantity,24);assert.equal(d.salesOrderLines[0].rate,10);assert.equal(d.salesOrderLines[0].nativeDiscountPercent,10);
}));
test('manual SO linking skips the selected customer account comparison and preserves the original request',()=>fixture(async()=>{
 const d=await draft();await query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,status_text,netsuite_active) VALUES(8899901,'TEST-OTHER-ACCOUNT',8899801,'Pending Fulfillment',true)");
 const linked=await repo.linkSpecialSalesOrder(d.id,{expectedRevision:d.revision,salesOrderId:8899901,salesOrderRef:'TEST-OTHER-ACCOUNT'},context);
 assert.equal(linked.salesOrderId,8899901);assert.equal(linked.customerId,d.customerId);assert.equal(linked.netsuiteCustomerId,d.netsuiteCustomerId);
}));
test('new enquiry retains chosen rep, editable expiry and original requester',()=>fixture(async()=>{
 const d=await enquiry({expiresOn:'2099-03-01'});assert.equal(d.expiresOn,'2099-03-01');assert.equal(d.netsuiteSalesRepName,'Chosen Rep');
 const edited=await repo.updateSpecialCaseExpiry(d.id,{expectedRevision:d.revision,expiresOn:'2099-04-01'},context);assert.equal(edited.expiresOn,'2099-04-01');assert.equal(edited.revision,d.revision+1);
 await assert.rejects(()=>repo.updateSpecialCaseExpiry(d.id,{expectedRevision:d.revision,expiresOn:'2099-05-01'},context),{status:409});
 await assert.rejects(()=>repo.updateSpecialCaseExpiry(d.id,{expectedRevision:edited.revision,expiresOn:'2099-05-01'},{...context,authorizedStoreLocationIds:[28]}),{status:403});
}));
test('expiry closes only past unissued idle cases, once, and rejects further edits',()=>fixture(async()=>{
 const eligible=await enquiry(),today=await enquiry();await query("UPDATE sales_special_stock_cases SET expires_on='2026-09-27' WHERE request_id=$1",[eligible.id]);await query("UPDATE sales_special_stock_cases SET expires_on='2026-09-28' WHERE request_id=$1",[today.id]);
 await query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,status_text,netsuite_active) VALUES(8899901,'TEST-EXPIRY-SO',8899801,'Pending Fulfillment',true)");
 await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,status_text,netsuite_active) VALUES(8899902,'TEST-EXPIRY-PO',8899200,'Pending Receipt',true)");
 const guards=["sales_order_skipped=true","sales_order_skipped=true,purchase_order_skipped=true","sales_order_operation_status='creating'","purchase_order_operation_status='attention'","attention=true","operationally_complete=true","sales_order_submission_started_at=now()","quantity_review='{\"status\":\"pending\",\"id\":\"test\"}'","fulfillment_change='{\"status\":\"applying\",\"id\":\"test\"}'","close_status='closure_pending'"];
 const protectedIds=[];for(const guard of guards){const d=await enquiry();protectedIds.push(d.id);await query(`UPDATE sales_special_stock_cases SET expires_on='2026-09-27',${guard} WHERE request_id=$1`,[d.id]);}
 for(const column of ['sales_order_netsuite_id','purchase_order_netsuite_id']){const d=await enquiry();protectedIds.push(d.id);await query(`UPDATE sales_special_stock_cases SET expires_on='2026-09-27',${column}=$2,${column.replace('_netsuite_id','_ref')}='TEST-EXPIRY' WHERE request_id=$1`,[d.id,column==='sales_order_netsuite_id'?8899901:8899902]);}
 await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='special_stock_request_workflow'");
 assert.deepEqual(await repo.expireSpecialStockCases({today:'2026-09-28'}),[]);
 await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
 const ids=await repo.expireSpecialStockCases({today:'2026-09-28'});assert.ok(ids.includes(eligible.id));assert.ok(!ids.includes(today.id));assert.ok(protectedIds.every(id=>!ids.includes(id)));
 const closed=await repo.getSpecialStockCase(eligible.id);assert.equal(closed.closeStatus,'closed');assert.equal(closed.status,'cancelled');assert.equal(closed.stage,'closed');assert.equal(closed.revision,eligible.revision+1);assert.match(closed.closureReason,/Expired/);
 assert.ok(!(await repo.expireSpecialStockCases({today:'2026-09-28'})).includes(eligible.id));
 await assert.rejects(()=>repo.updateSpecialCaseExpiry(closed.id,{expectedRevision:closed.revision,expiresOn:'2099-01-01'},context),{code:'SPECIAL_EXPIRY_LOCKED'});
 assert.equal((await query("SELECT count(*)::int AS n FROM sales_special_stock_events WHERE request_id=$1 AND event_type='special_case_expired'",[eligible.id])).rows[0].n,1);
}));
test('multi-vendor selection intersects yard and owner restrictions and supports punctuation',()=>fixture(async()=>{
 const a=await enquiry(),b=await enquiry({vendorName:'B, Inc.'}),outside=await enquiry({storeLocationId:28,vendorName:'Outside'});await enquiry({vendorName:'Vendor A'},{...context,operatorId:'special-enhancements-b'});
 const listed=await repo.listSpecialStockCases({authorizedStoreLocationIds:[1],requestedByOperatorId:context.operatorId,vendorNames:JSON.stringify(['Vendor A','B, Inc.'])});
 assert.deepEqual(listed.map(x=>x.id).sort((a,b)=>a-b),[a.id,b.id]);assert.ok(!listed.some(x=>x.id===outside.id));
 const vendors=await repo.listSpecialCaseVendors({authorizedStoreLocationIds:[1],requestedByOperatorId:context.operatorId});assert.deepEqual(vendors,['B, Inc.','Vendor A']);
 assert.deepEqual(await repo.listSpecialStockCases({authorizedStoreLocationIds:[1],vendorNames:JSON.stringify(["x' OR true --"])}),[]);
}));
test('Sales alert counts are own requests within permitted yards, regardless of list pagination',()=>fixture(async()=>{
 const a=await enquiry(),b=await enquiry({}, {...context,operatorId:'special-enhancements-b'}),outside=await enquiry({storeLocationId:28});
 for(const d of [a,b,outside])await query("UPDATE sales_special_stock_lines SET supply_status='in_stock' WHERE request_id=$1",[d.id]);
 const counts=await alerts.getSpecialSalesAlertCounts({operatorId:context.operatorId,authorizedStoreLocationIds:[1]});assert.deepEqual(counts,{awaitCustomerConfirmation:1,dispatchArrangement:0,waitForProduction:0,pendingUpdate:0,total:1});
 const transfer=await enquiry(),dispatch=await enquiry();await query("UPDATE sales_special_stock_lines SET sales_decision='accepted',supply_status='vendor_transfer',available_date='2099-03-01' WHERE request_id=$1",[transfer.id]);
 await query("UPDATE sales_special_stock_cases SET sales_order_skipped=true,purchase_order_skipped=true WHERE request_id=$1",[dispatch.id]);
 assert.deepEqual(await alerts.getSpecialSalesAlertCounts({operatorId:context.operatorId,authorizedStoreLocationIds:[1]}),{awaitCustomerConfirmation:1,dispatchArrangement:1,waitForProduction:1,pendingUpdate:0,total:3});
 const page=await repo.listSpecialStockCases({requestedByOperatorId:context.operatorId,authorizedStoreLocationIds:[1],limit:1});assert.equal(page.length,1);
 assert.equal((await alerts.getSpecialSalesAlertCounts({operatorId:context.operatorId,authorizedStoreLocationIds:[]})).total,0);
}));
test('migration is repeatable and additive',()=>fixture(async()=>{
 const d=await draft(),before=await repo.getSpecialStockCase(d.id);const sql=await readFile('migrations/238_special_request_details_expiry.sql','utf8');
 await query('SAVEPOINT enhancement_migration');await query(sql);await query(sql);assert.deepEqual(await repo.getSpecialStockCase(d.id),before);await query('ROLLBACK TO SAVEPOINT enhancement_migration');
}));
