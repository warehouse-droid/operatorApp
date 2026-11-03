import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {beginRollbackContext,closeDb,query} from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import {createSpecialStockRequestService} from '../../../src/special-stock-request-service.js';
import {readFile} from 'node:fs/promises';
after(closeDb);
const context={operatorId:'independent-po-test',authorizedStoreLocationIds:[1]};
async function fixture(run) {
  const rollback=await beginRollbackContext();
  try {await rollback.run(async()=>{
    await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES('independent-po-test','independent-po-test','TEST','hash','salt','scm',ARRAY['scm'],ARRAY[1]) ON CONFLICT DO NOTHING");
    await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(8899600,'TEST-INDEP','TEST','TEST','CAD',true,now(),'test',repeat('e',64)) ON CONFLICT DO NOTHING");
    await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()),(1784,'PALLET','EACH','{}',now()),(9001,'TEST Delivery Fee','','{}',now()) ON CONFLICT DO NOTHING");
    let d=await repo.createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerId:8899600,customerName:'TEST',vendorId:8899602,vendorName:'TEST Vendor',fulfillmentMethod:'yard_pickup',lines:[{productName:'Customer description',quantity:24,uom:'PCS',rate:10,requiredDate:'2099-02-01',palletQty:1,pieceQty:24}]},context);
    d=await repo.respondSpecialStockLine(d.id,d.lines[0].id,{expectedRevision:d.revision,supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:8899602,vendorName:'TEST Vendor',vendorYard:'TEST Yard'},context);
    d=await repo.decideSpecialStockLine(d.id,d.lines[0].id,{expectedRevision:d.revision,decision:'accepted'},context);
    d=await repo.saveSpecialSalesOrderDraft(d.id,{expectedRevision:d.revision,customerId:8899600,operationalYardLocationId:1,fulfillmentMethod:'yard_pickup',palletTotal:0,
      materialLines:[{caseLineId:d.lines[0].id,itemId:2055,description:'Customer description',quantity:24,packageQuantity:24,conversionToPc:1,uom:'PC',rate:10}]},context);
    await query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,customer,order_location_id,status,status_text,netsuite_active) VALUES(8899601,'TEST-SO-INDEP',8899600,'TEST',1,'B','Pending Fulfillment',true)");
    await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES(8899601,960101,2055,'MBBS-Special Order','Customer description',24,'PC',true)");
    d=await repo.linkSpecialSalesOrder(d.id,{expectedRevision:d.revision,salesOrderId:8899601,salesOrderRef:'TEST-SO-INDEP',source:'standalone'},context);
    await run(await repo.getSpecialStockCase(d.id,{audience:'scm'}));
  });}finally{await rollback.rollback();}
}
const review=d=>({expectedRevision:d.revision,pallet:{quantity:0},lines:[{caseLineId:d.lines[0].id,description:'Vendor description',quantity:2,uom:'PLT',unitPurchaseCost:50,vendorDiscountPercent:10,palletQty:2,sectionQty:3,layerQty:4,pieceQty:30}],extraLines:[{itemId:9001,description:'Vendor delivery fee',quantity:1,uom:'',unitPurchaseCost:25,pieceQty:0}]});

test('independent review persists PO packing and fee while preserving SO and request sales details',()=>fixture(async d=>{
  const sales=structuredClone(d.salesOrderLines),description=d.lines[0].itemResolution.description;
  const prepared=await repo.prepareSpecialPurchaseOrder(d.id,review(d),context);
  assert.deepEqual(prepared.salesOrderLines,sales);
  assert.equal(prepared.lines[0].itemResolution.description,description);
  assert.equal(prepared.lines[0].quantity,24);assert.equal(prepared.lines[0].palletQty,1);
  assert.equal(prepared.purchaseOrderLines.length,2);
  const [material,fee]=prepared.purchaseOrderLines;
  assert.deepEqual([material.description,material.quantity,material.uom,material.palletQty,material.sectionQty,material.layerQty,material.pieceQty],['Vendor description',2,'PLT',2,3,4,30]);
  assert.deepEqual([fee.itemId,fee.ancillary,fee.quantity,fee.unitPurchaseCost],[9001,true,1,25]);
  assert.equal(prepared.vendorDiscountReview.independent,true);
  assert.equal(prepared.purchaseOrderCustomLinkage,false,'Reviewing a PO must preserve existing Dispatch route choices');
  const claimed=await repo.claimSpecialOrderOperation(d.id,{expectedRevision:prepared.revision,orderKind:'purchase_order',operationId:crypto.randomUUID()},context);
  assert.deepEqual(claimed.salesOrderLines,sales);
}));
test('invalid PO-only items and packing roll back the entire review',()=>fixture(async d=>{
  for(const patch of [{extraLines:[{itemId:999999,description:'Unknown',quantity:1,uom:'PC',unitPurchaseCost:10}]},
    {extraLines:[{itemId:4981,description:'Forged discount',quantity:1,uom:'PC',unitPurchaseCost:10}]},
    {lines:[{...review(d).lines[0],palletQty:-1}]},
    {extraLines:Array.from({length:101},()=>({itemId:9001,description:'Fee',quantity:1,uom:'',unitPurchaseCost:10}))}]) {
    await assert.rejects(()=>repo.prepareSpecialPurchaseOrder(d.id,{...review(d),...patch},context));
    assert.deepEqual((await repo.getSpecialStockCase(d.id)).purchaseOrderLines,d.purchaseOrderLines);
    assert.equal((await repo.getSpecialStockCase(d.id)).revision,d.revision);
  }
}));

function purchaseService({lostResponse=false}={}) {
  const state={posted:0,payload:null};
  state.service=createSpecialStockRequestService({
    resolveLocations:async()=>[{netsuiteLocationId:1}],
    resolveOrderUnits:async lines=>lines.map(line=>({...line,unitId:line.uom==='PLT'?2:line.uom?1:null})),
    findMarkerOrders:async()=>state.posted?[{id:8899603,entity_id:8899602,location_id:1}]:[],
    findLinkedPurchaseOrder:async()=>assert.fail('New PO must not inspect native SO links'),
    synchronizeSalesDescriptions:async()=>assert.fail('SO writes are forbidden'),
    createPurchaseOrder:async input=>{
      state.posted++;state.payload=input;
      await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,status_text,netsuite_active) VALUES(8899603,'TEST-PO-INDEP',8899602,1,'Pending Receipt',true)");
      for(const [index,line] of input.item.items.entries()) {
        await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES(8899603,$1,$2,'TEST',$3,$4,$5,true)",
          [910101+index,Number(line.item.id),line.description,line.quantity,line.units==='2'?'PLT':null]);
      }
      if(lostResponse)throw Error('Response lost after creation');
      return {id:8899603};
    },
    fetchPurchaseOrderReference:async()=>({tranid:'TEST-PO-INDEP',status_text:'Pending Receipt'}),
    recordPurchaseOrderCreation:async()=>{},sleep:async()=>{}
  });
  return state;
}

for(const lostResponse of [false,true]) test(`independent PO creation preserves the SO through ${lostResponse?'lost-response recovery':'the complete database workflow'}`,()=>fixture(async d=>{
  const before=await query('SELECT * FROM sales_order_lines WHERE sales_order_id=8899601');
  const saved=structuredClone(d.salesOrderLines);
  const state=purchaseService({lostResponse}),{service}=state;
  const result=await service.createPurchaseOrder(d.id,{...review(d),operationId:crypto.randomUUID()},context);
  const {posted,payload}=state;
  assert.equal(posted,1);assert.equal(result.purchaseOrderId,8899603);assert.equal(result.attention,false);
  assert.deepEqual(result.salesOrderLines,saved);assert.deepEqual((await query('SELECT * FROM sales_order_lines WHERE sales_order_id=8899601')).rows,before.rows);
  assert.deepEqual(payload.item.items.map(line=>[line.item.id,line.quantity,line.rate]),[['2055',2,50],['9001',1,25],['4981',1,-10]]);
  assert.equal(payload.item.items[0].custcol_pcs,30);assert.equal(payload.createdFrom,undefined);
  await assert.rejects(()=>service.createPurchaseOrder(d.id,{expectedRevision:result.revision,operationId:crypto.randomUUID()},context),{code:'SPECIAL_PO_ALREADY_LINKED'});
  assert.equal(state.posted,1);
}));

// SPREQ-000178: the issued SO was later edited in NetSuite, so its lines no
// longer equal the case's SO snapshot or the reviewed PO. PO creation is
// standalone and must neither compare nor rewrite the SO.
test('PO creation is not blocked when the NetSuite SO item differs from the SO snapshot and the PO',()=>fixture(async d=>{
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(9002,'TEST Stock Item','PC','{}',now()) ON CONFLICT DO NOTHING");
  await query("UPDATE sales_order_lines SET item_id=9002,item_name='TEST Stock Item',item_description='Edited in NetSuite',quantity=20 WHERE sales_order_id=8899601");
  const before=(await query('SELECT * FROM sales_order_lines WHERE sales_order_id=8899601 ORDER BY id')).rows;
  const saved=structuredClone(d.salesOrderLines);
  const state=purchaseService();
  const result=await state.service.createPurchaseOrder(d.id,{...review(d),operationId:crypto.randomUUID()},context);
  assert.equal(state.posted,1);
  assert.equal(result.purchaseOrderId,8899603);assert.equal(result.purchaseOrderRef,'TEST-PO-INDEP');
  assert.equal(result.purchaseOrderOperationStatus,'linked');
  // The SO's own reconciliation (NetSuite SO vs its issued snapshot) is separate
  // from PO creation: the edited SO is surfaced for review after the PO links.
  assert.equal(result.attention,true);
  assert.match(result.attentionReason,/^Sales Order does not contain/);
  assert.equal(state.payload.createdFrom,undefined);
  assert.deepEqual(state.payload.item.items.map(line=>[line.item.id,line.description]),[['2055','Vendor description'],['9001','Vendor delivery fee'],['4981',state.payload.item.items[2].description]]);
  assert.deepEqual(result.salesOrderLines,saved,'The case SO snapshot must not be adjusted to the PO or NetSuite');
  assert.deepEqual((await query('SELECT * FROM sales_order_lines WHERE sales_order_id=8899601 ORDER BY id')).rows,before,'The NetSuite SO mirror must not be rewritten');
}));

test('PO review keeps approval, stale-revision and already-submitted fences',()=>fixture(async d=>{
  await assert.rejects(()=>repo.prepareSpecialPurchaseOrder(d.id,{...review(d),expectedRevision:d.revision+1},context),{code:'SPECIAL_REVISION_CONFLICT'});
  await query('UPDATE sales_special_stock_cases SET sales_order_approved=false WHERE request_id=$1',[d.id]);
  await assert.rejects(()=>repo.prepareSpecialPurchaseOrder(d.id,review(d),context),{code:'SPECIAL_PO_SO_NOT_APPROVED'});
  await query('UPDATE sales_special_stock_cases SET sales_order_approved=true WHERE request_id=$1',[d.id]);
  let prepared=await repo.prepareSpecialPurchaseOrder(d.id,review(d),context);
  prepared=await repo.claimSpecialOrderOperation(d.id,{expectedRevision:prepared.revision,orderKind:'purchase_order',operationId:crypto.randomUUID()},context);
  await assert.rejects(()=>repo.prepareSpecialPurchaseOrder(d.id,review(prepared),context),{code:'SPECIAL_OPERATION_BUSY'});
}));

test('PO ancillary migration can be reapplied and rolled back without losing existing lines',()=>fixture(async d=>{
  const migration=await readFile('migrations/322_special_independent_po.sql','utf8');
  const previous=await readFile('migrations/246_special_po_pallet.sql','utf8');
  await query(migration);await query(migration);
  await query(previous.slice(0,previous.indexOf('CREATE UNIQUE INDEX')));
  assert.deepEqual((await repo.getSpecialStockCase(d.id,{audience:'scm'})).salesOrderLines,d.salesOrderLines);
  await query(migration);
  const prepared=await repo.prepareSpecialPurchaseOrder(d.id,review(d),context);
  await query(migration);
  assert.equal((await repo.getSpecialStockCase(d.id)).purchaseOrderLines.length,prepared.purchaseOrderLines.length);
}));
