/* global structuredClone */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import {readFile} from 'node:fs/promises';
import {beginRollbackContext,closeDb,query,withTransaction} from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';

after(closeDb);
const context={operatorId:'po-pallet-test',authorizedStoreLocationIds:[1]};
async function fixture(run) {
  const rollback=await beginRollbackContext();
  try {await rollback.run(async()=>{
    await query(await readFile('migrations/246_special_po_pallet.sql','utf8'));
    await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES('po-pallet-test','po-pallet-test','TEST','hash','salt','admin',ARRAY['admin'],ARRAY[1]) ON CONFLICT DO NOTHING");
    await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()),(1784,'PALLET','EACH','{}',now()) ON CONFLICT DO NOTHING");
    await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(8899717,'TEST','TEST PALLET','TEST PALLET','CAD',true,now(),'test',repeat('d',64)) ON CONFLICT DO NOTHING");
    let d=await repo.createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerId:8899717,customerName:'TEST PALLET',vendorId:8899200,vendorName:'TEST Vendor',fulfillmentMethod:'yard_pickup',
      lines:[{productName:'TEST product',quantity:2,uom:'PLT',rate:144,requiredDate:'2099-02-01'}]},context);
    d=await repo.respondSpecialStockLine(d.id,d.lines[0].id,{expectedRevision:d.revision,supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:8899200,vendorName:'TEST Vendor',vendorYard:'TEST Yard'},context);
    d=await repo.decideSpecialStockLine(d.id,d.lines[0].id,{expectedRevision:d.revision,decision:'accepted'},context);
    d=await repo.saveSpecialSalesOrderDraft(d.id,{expectedRevision:d.revision,customerId:8899717,operationalYardLocationId:1,fulfillmentMethod:'yard_pickup',palletTotal:2,palletRate:40,
      materialLines:[{caseLineId:d.lines[0].id,itemId:2055,description:'TEST product',quantity:24,packageQuantity:2,conversionToPc:12,uom:'PC',rate:144}]},context);
    await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=8899718,sales_order_ref='TEST-SO-PALLET',sales_order_approved=true,sales_order_operation_status='linked' WHERE request_id=$1",[d.id]);
    d=await repo.getSpecialStockCase(d.id,{audience:'scm'});
    await run(d);
  });} finally {await rollback.rollback();}
}
const input=(d,pallet={quantity:2,unitPurchaseCost:35})=>({expectedRevision:d.revision,pallet,
  lines:[{caseLineId:d.lines[0].id,description:'TEST reviewed product',quantity:24,uom:'PC',unitPurchaseCost:33.87,vendorDiscountPercent:10}]});

test('PO preparation stores one reviewed PALLET, replaces it on retry and removes it at zero',()=>fixture(async d=>{
  const so=structuredClone(d.salesOrderLines);
  d=await repo.prepareSpecialPurchaseOrder(d.id,input(d),context);
  const pallet=d.purchaseOrderLines.filter(line=>line.itemId===1784);
  assert.equal(pallet.length,1);
  assert.deepEqual([pallet[0].quantity,pallet[0].uom,pallet[0].unitPurchaseCost,pallet[0].ancillary],[2,'EACH',35,true]);
  assert.deepEqual(d.salesOrderLines,so);
  d=await repo.prepareSpecialPurchaseOrder(d.id,input(d,{quantity:3,unitPurchaseCost:30}),context);
  assert.deepEqual(d.purchaseOrderLines.filter(line=>line.itemId===1784).map(line=>line.quantity),[3]);
  assert.equal(d.vendorDiscountReview.amount,81.29);
  d=await repo.prepareSpecialPurchaseOrder(d.id,input(d,{quantity:0,unitPurchaseCost:''}),context);
  assert.equal(d.purchaseOrderLines.some(line=>line.itemId===1784),false);
  assert.equal(d.palletTotal,2);
  assert.equal(d.palletRate,40);
}));

test('missing PALLET review with SO pallets fails, and invalid review rolls back all PO edits',()=>fixture(async d=>{
  const before=structuredClone(d.purchaseOrderLines);
  const omitted=input(d);delete omitted.pallet;
  await assert.rejects(()=>repo.prepareSpecialPurchaseOrder(d.id,omitted,context),{code:'SPECIAL_PO_PALLET_REQUIRED'});
  await assert.rejects(()=>repo.prepareSpecialPurchaseOrder(d.id,input(d,{quantity:2,unitPurchaseCost:''}),context),{code:'SPECIAL_RATE_INVALID'});
  const unchanged=await repo.getSpecialStockCase(d.id,{audience:'scm'});
  assert.deepEqual(unchanged.purchaseOrderLines,before);
  assert.equal(unchanged.revision,d.revision);
}));

test('PALLET review uses the same stale case revision and post-submission protections',()=>fixture(async d=>{
  await assert.rejects(()=>repo.prepareSpecialPurchaseOrder(d.id,{...input(d),expectedRevision:d.revision-1},context),{status:409});
  await query("UPDATE sales_special_stock_cases SET purchase_order_operation_status='creating',purchase_order_submission_started_at=now() WHERE request_id=$1",[d.id]);
  await assert.rejects(()=>repo.prepareSpecialPurchaseOrder(d.id,input(d),context),{status:409});
}));

test('migration preserves material rules, rejects other PO ancillary items and duplicate PALLET rows',()=>fixture(async d=>{
  d=await repo.prepareSpecialPurchaseOrder(d.id,input(d),context);
  const insert=(itemId,ancillary,caseLineId=null)=>withTransaction(()=>query(`INSERT INTO sales_special_stock_order_lines(request_id,order_kind,ancillary,item_id,case_line_id,description,quantity,uom,unit_purchase_cost)
    VALUES($1,'purchase_order',$2,$3,$4,'TEST',1,'EACH',35)`,[d.id,ancillary,itemId,caseLineId]));
  await assert.rejects(()=>insert(2055,true),{code:'23514'});
  await assert.rejects(()=>insert(2055,false),{code:'23514'});
  await assert.rejects(()=>insert(1784,true),{code:'23505'});
  assert.equal((await repo.getSpecialStockCase(d.id,{audience:'scm'})).purchaseOrderLines.filter(line=>line.itemId===1784).length,1);
}));
