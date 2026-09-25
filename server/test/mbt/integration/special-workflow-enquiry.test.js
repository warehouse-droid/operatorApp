import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import fc from 'fast-check';
import {findSpecialCustomer} from '../../../src/special-stock-customer-directory.js';
import {buildSpecialSalesOrderPayload} from '../../../src/special-stock-request-netsuite.js';
import {readFile} from 'node:fs/promises';
import {beginRollbackContext,closeDb,query} from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
after(closeDb);
const id=8899501, actor='special-enquiry-test';
const context={operatorId:actor,authorizedStoreLocationIds:[1]};
async function fixture(run){
 const tx=await beginRollbackContext();
 try {await tx.run(async()=>{
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES($1,$1,'TEST','hash','salt','sales',ARRAY['sales'],ARRAY[1]) ON CONFLICT DO NOTHING",[actor]);
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()) ON CONFLICT DO NOTHING");
  await query("INSERT INTO return_customer_directory(netsuite_customer_id,entity_code,company_name,display_name,phone) VALUES($1,'600020 TEST-ACTION','TEST Action Home Services','TEST Action Home Services','416-555-0100'),($2,'40 TEST-ACTION','TEST Action Home Services','TEST Action Home Services','')",[id,id+1]);
  await run();
 });}finally{await tx.rollback();}
}
function input(){return {storeLocationId:1,inquiryDate:'2099-01-01',customerId:id,customerName:'Untrusted browser name',vendorId:8899200,vendorName:'TEST vendor brand',fulfillmentMethod:'yard_pickup',lines:[{productName:'TEST product',quantity:2,uom:'PLT',rate:120,discountPercent:10,requiredDate:'2099-01-01'}]};}
async function canonical(customerId,active=true){await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES($1,$3,'TEST canonical','TEST canonical','CAD',$2,now(),'test',repeat('e',64))",[customerId,active,'600020 TEST-ACTION-'+customerId]);}
test('directory-only MBBS customer searches by account/name, keeps separate accounts and escapes wildcard input',()=>fixture(async()=>{
 assert.deepEqual((await repo.searchSpecialCustomers({search:'600020 TEST-ACTION'})).map(x=>x.id),[id]);
 assert.deepEqual(new Set((await repo.searchSpecialCustomers({search:'TEST Action Home Services'})).map(x=>x.id)),new Set([id,id+1]));
 assert.equal((await repo.searchSpecialCustomers({search:'TEST-ACTION%'})).length,0);
 assert.equal((await repo.searchSpecialCustomers({search:'TEST-ACTION',limit:1})).length,1);
}));
test('canonical IDs deduplicate the full directory and explicit inactive customers are excluded',()=>fixture(async()=>{
 await canonical(id);await canonical(id+1,false);
 const rows=await repo.searchSpecialCustomers({search:'TEST-ACTION'});
 assert.equal(rows.length,1);assert.equal(rows[0].id,id);assert.equal(rows[0].displayName,'TEST canonical');
 await assert.rejects(()=>repo.createSpecialStockCase({...input(),customerId:id+1},context),{code:'SPECIAL_CASE_CUSTOMER_INVALID'});
}));
test('directory customer identity persists from enquiry through SO draft without creating canonical data',()=>fixture(async()=>{
 let d=await repo.createSpecialStockCase(input(),context);
 assert.equal(d.customerId,id);assert.equal(d.customerName,'TEST Action Home Services');assert.equal(d.lines[0].brand,'TEST vendor brand');
 assert.equal((await query('SELECT 1 FROM netsuite_customers WHERE netsuite_id=$1',[id])).rowCount,0);
 d=await repo.respondSpecialStockLine(d.id,d.lines[0].id,{expectedRevision:d.revision,supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:8899200,vendorName:'TEST vendor brand',vendorYard:'TEST yard'},context);
 d=await repo.decideSpecialStockLine(d.id,d.lines[0].id,{expectedRevision:d.revision,decision:'accepted'},context);
 const draft={expectedRevision:d.revision,customerId:id,operationalYardLocationId:1,fulfillmentMethod:'yard_pickup',palletTotal:0,materialLines:[{caseLineId:d.lines[0].id,itemId:2055,description:'TEST product',packageQuantity:2,conversionToPc:1,quantity:2,uom:'PC',rate:120,discountPercent:10}]};
 d=await repo.saveSpecialSalesOrderDraft(d.id,draft,context);assert.equal(d.customerId,id);assert.equal(d.salesOrderLines[0].quantity,2);assert.equal(d.salesOrderLines[0].rate,108);
 const payload=buildSpecialSalesOrderPayload({caseId:d.id,netsuiteLocationId:1,pickupMethodId:1,deliveryMethodId:2,draft:{customerId:d.customerId,fulfillmentMethod:'yard_pickup',materialLines:d.salesOrderLines}});
 assert.equal(Number(payload.entity.id),id);
 await query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,status_text,netsuite_active) VALUES(8899570,'TEST-WRONG-CUSTOMER',8899502,'Pending Fulfillment',true)");
 await assert.rejects(()=>repo.linkSpecialSalesOrder(d.id,{expectedRevision:d.revision,salesOrderId:8899570,salesOrderRef:'TEST-WRONG-CUSTOMER'},context),{code:'SPECIAL_SO_CUSTOMER_MISMATCH'});
 await canonical(id+2);
 d=await repo.saveSpecialSalesOrderDraft(d.id,{...draft,expectedRevision:d.revision,customerId:id+2},context);assert.equal(d.customerId,id+2);
 const stored=(await query('SELECT canonical_customer_id,directory_customer_id FROM sales_special_stock_cases WHERE request_id=$1',[d.id])).rows[0];
 assert.equal(Number(stored.canonical_customer_id),id+2);assert.equal(stored.directory_customer_id,null);
}));
test('unknown directory identities and unauthorized yards remain rejected',()=>fixture(async()=>{
 await assert.rejects(()=>repo.createSpecialStockCase({...input(),customerId:id+99},context),{code:'SPECIAL_CASE_CUSTOMER_INVALID'});
 await assert.rejects(()=>repo.createSpecialStockCase(input(),{...context,authorizedStoreLocationIds:[28]}),{code:'SPECIAL_CASE_STORE_FORBIDDEN'});
}));
test('directory-ID migration is idempotent and rollback preserves the canonical foreign key',async()=>{
 const tx=await beginRollbackContext();
 try{await tx.run(async()=>{
  await query('CREATE SCHEMA special_enquiry_migration');await query('SET LOCAL search_path=special_enquiry_migration,public');
  await query('CREATE TABLE special_enquiry_migration.sales_special_stock_cases(request_id bigint PRIMARY KEY,canonical_customer_id bigint REFERENCES public.netsuite_customers(netsuite_id))');
  const sql=await readFile('migrations/229_special_workflow_customer_directory.sql','utf8');await query(sql);await query(sql);
  await assert.rejects(async()=>{await query('SAVEPOINT invalid_id');try{await query('INSERT INTO special_enquiry_migration.sales_special_stock_cases VALUES(1,NULL,-1)');}catch(e){await query('ROLLBACK TO SAVEPOINT invalid_id');throw e;}},{code:'23514'});
  assert.equal((await query("SELECT 1 FROM pg_constraint WHERE conrelid='special_enquiry_migration.sales_special_stock_cases'::regclass AND contype='f'")).rowCount,1);
 });}finally{await tx.rollback();}
 assert.equal((await query("SELECT 1 FROM pg_namespace WHERE nspname='special_enquiry_migration'")).rowCount,0);
});

test('property: customer search is bounded and deduplicated across both directories',()=>fixture(async()=>{
 await canonical(id);
 await fc.assert(fc.asyncProperty(fc.constantFrom('TEST-ACTION','test-action','TEST Action Home Services','600020 TEST-ACTION'),fc.integer({min:1,max:150}),async(search,limit)=>{
  const rows=await repo.searchSpecialCustomers({search,limit});
  assert.ok(rows.length>0 && rows.length<=Math.min(limit,80));
  assert.equal(new Set(rows.map(x=>x.id)).size,rows.length);
  assert.ok(rows.every(x=>[id,id+1].includes(x.id)));
 }),{numRuns:80,seed:25092026});
 assert.equal(await findSpecialCustomer(0),null);assert.equal(await findSpecialCustomer('invalid'),null);
}));
