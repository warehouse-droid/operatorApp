import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import * as repository from '../../../src/special-stock-request-repository.js';

after(closeDb);
const context = { operatorId: 'special-review-test', authorizedStoreLocationIds: [1] };
const input = { storeLocationId: 1, inquiryDate: '2099-01-01', customerId: 8899100,
  customerName: 'TEST Review', vendorId: 8899200, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
  lines: [{ productName: 'TEST product', quantity: 2, uom: 'PLT', rate: 144, requiredDate: '2099-02-01' }] };
async function fixture(run) {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES('special-review-test','special-review-test','TEST','hash','salt','admin',ARRAY['admin'],ARRAY[1]) ON CONFLICT DO NOTHING");
      await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','SQFT','{}',now()),(1784,'PALLET','EACH','{}',now()) ON CONFLICT DO NOTHING");
      await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(8899100,'TEST','TEST Review','TEST Review','CAD',true,now(),'test',repeat('d',64)) ON CONFLICT DO NOTHING");
      await run();
    });
  } finally { await rollback.rollback(); }
}
async function respond(detail, { supplyStatus = 'in_stock', availableDate = '2099-01-20' } = {}) {
  return repository.respondSpecialStockLine(detail.id, detail.lines[0].id, {
    expectedRevision: detail.revision, supplyStatus, availableDate,
    availabilityMode: availableDate ? 'dated' : 'no_projection',
    vendorId: 8899200, vendorName: 'TEST Vendor', vendorYard: 'TEST vendor yard'
  }, context);
}

test('enquiry retains initial fulfillment and SCM reply moves to customer confirmation', () => fixture(async () => {
  let detail = await repository.createSpecialStockCase(input, context);
  assert.equal(detail.fulfillmentMethod, 'yard_pickup');
  assert.equal(detail.operationalYardLocationId, 1);
  assert.equal(detail.stage, 'new_enquiry');
  detail = await respond(detail);
  assert.equal(detail.stage, 'await_customer_confirmation');
}));

test('accepted ETA needs no mapping and survives a revised SCM ETA', () => fixture(async () => {
  let detail = await repository.createSpecialStockCase(input, context);
  detail = await respond(detail, { supplyStatus: 'production' });
  detail = await repository.decideSpecialStockLine(detail.id, detail.lines[0].id, { expectedRevision: detail.revision, decision: 'accepted' }, context);
  assert.equal(detail.stage, 'wait_for_production');
  assert.equal(detail.lines[0].itemResolution, null);
  detail = await respond(detail, { supplyStatus: 'production', availableDate: '2099-01-27' });
  assert.equal(detail.lines[0].salesDecision, 'accepted');
  assert.equal(detail.stage, 'wait_for_production');
}));

test('SO draft resolves fixed product once and retains one pallet line across saves', () => fixture(async () => {
  let detail = await repository.createSpecialStockCase(input, context);
  detail = await respond(detail);
  detail = await repository.decideSpecialStockLine(detail.id, detail.lines[0].id, { expectedRevision: detail.revision, decision: 'accepted' }, context);
  const draft = { customerId: 8899100, operationalYardLocationId: 1, fulfillmentMethod: 'yard_pickup', palletTotal: 3, palletRate: 35,
    materialLines: [{ caseLineId: detail.lines[0].id, itemId: 2055, quantity: 24, packageQuantity: 2, conversionToPc: 12, uom: 'PC', rate: 144, description: 'TEST product in pieces' }] };
  detail = await repository.saveSpecialSalesOrderDraft(detail.id, { ...draft, expectedRevision: detail.revision }, context);
  detail = await repository.saveSpecialSalesOrderDraft(detail.id, { ...draft, expectedRevision: detail.revision }, context);
  assert.equal(detail.palletTotal, 3);
  assert.equal(detail.salesOrderLines.filter(line => line.itemId === 1784).length, 1);
  assert.equal(detail.lines[0].itemResolution.itemId, 2055);
  assert.equal(detail.lines[0].itemResolution.salesQuantity, 24);
  detail = await repository.saveSpecialSalesOrderDraft(detail.id, { ...draft, palletTotal: 0, expectedRevision: detail.revision }, context);
  assert.equal(detail.palletTotal, 0);
  assert.equal(detail.salesOrderLines.some(line => line.itemId === 1784), false);
}));

test('SCM can close a no-stock no-ETA request with a reason', () => fixture(async () => {
  let detail = await repository.createSpecialStockCase(input, context);
  detail = await respond(detail, { supplyStatus: 'no_stock', availableDate: null });
  await assert.rejects(() => repository.closeSpecialUnavailableCase(detail.id, { expectedRevision: detail.revision, reason: '' }, context));
  detail = await repository.closeSpecialUnavailableCase(detail.id, { expectedRevision: detail.revision, reason: 'Vendor cannot supply or project an ETA' }, context);
  assert.equal(detail.stage, 'closed');
}));

test('due reminder persists on postponement and clears only on explicit readiness', () => fixture(async () => {
  let detail = await repository.createSpecialStockCase(input, context);
  detail = await respond(detail, { supplyStatus: 'production', availableDate: '2020-01-10' });
  detail = await repository.decideSpecialStockLine(detail.id, detail.lines[0].id, { expectedRevision: detail.revision, decision: 'accepted' }, context);
  assert.equal(detail.readinessAlerts.length, 1);
  detail = await repository.checkSpecialStockReadiness(detail.id, detail.lines[0].id, { expectedRevision: detail.revision, ready: false, eta: '2099-01-27' }, context);
  assert.equal(detail.readinessAlerts.length, 1);
  assert.equal(detail.lines[0].reminderDueDate, '2020-01-07');
  detail = await repository.checkSpecialStockReadiness(detail.id, detail.lines[0].id, { expectedRevision: detail.revision, ready: true }, context);
  assert.equal(detail.readinessAlerts.length, 0);
  assert.equal(detail.lines[0].supplyStatus, 'in_stock');
}));

test('stage OR filter is applied before the requested page limit', () => fixture(async () => {
  let first = await repository.createSpecialStockCase(input, context);
  first = await respond(first);
  await repository.createSpecialStockCase(input, context);
  const rows = await repository.listSpecialStockCases({ stages: ['await_customer_confirmation', 'closed'], limit: 1, authorizedStoreLocationIds: [1] });
  assert.equal(rows[0].id, first.id);
}));


test('yard completion requires final customer collection evidence, independent of NetSuite fulfillment', () => fixture(async () => {
  let detail = await repository.createSpecialStockCase(input, context);
  const orderId = 8899800;
  await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=$2, sales_order_ref='TEST-YARD-PHYSICAL', sales_order_status='Fully Fulfilled', purchase_order_netsuite_id=$3, purchase_order_ref='TEST-YARD-PO' WHERE request_id=$1", [detail.id, orderId, orderId+1]);
  detail = await repository.getSpecialStockCase(detail.id);
  assert.notEqual(detail.stage, 'completed');
  await query("INSERT INTO operator_load_records(load_type,order_family,order_id,response) VALUES('sales_order_load','SO',$1,'{}'),('customer_pickup_load','SO',$1,'{\"pickupStatus\":\"partial_loaded\"}')", [orderId]);
  assert.notEqual((await repository.getSpecialStockCase(detail.id)).stage, 'completed');
  await query("INSERT INTO operator_load_records(load_type,order_family,order_id,response) VALUES('customer_pickup_load','SO',$1,'{\"pickupStatus\":\"loaded\"}')", [orderId]);
  detail = await repository.getSpecialStockCase(detail.id);
  assert.equal(detail.stage, 'completed');
  assert.equal(detail.operationalCompletionSource, 'yard_pickup');
  const filtered = await repository.listSpecialStockCases({ stages: ['completed'], limit: 1 });
  assert.equal(filtered[0].id, detail.id);
}));

test('real order service persists submission and recovers after SO patch success before PO creation', () => fixture(async () => {
  const { createSpecialStockRequestService } = await import('../../../src/special-stock-request-service.js');
  const { synchronizeSpecialDescriptions } = await import('../../../src/special-stock-netsuite-adapter.js');
  let detail = await repository.createSpecialStockCase({...input,lines:input.lines.map(line=>({...line,rate:4800})),fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST delivery',deliveryContactName:'TEST contact',deliveryContactPhone:'555-0100'}, context);
  detail = await respond(detail);
  detail = await repository.decideSpecialStockLine(detail.id,detail.lines[0].id,{expectedRevision:detail.revision,decision:'accepted'},context);
  detail = await repository.saveSpecialSalesOrderDraft(detail.id,{expectedRevision:detail.revision,customerId:8899100,operationalYardLocationId:1,fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST delivery',deliveryContactName:'TEST contact',deliveryContactPhone:'555-0100',palletTotal:0,
    materialLines:[{caseLineId:detail.lines[0].id,itemId:2055,description:'Original product',quantity:1200,packageQuantity:2,conversionToPc:600,uom:'PC',rate:4800}]},context);
  const orders=new Map(); let nextId=8899700,posts=0,patches=0,failSync=true;
  async function create(kind,payload) {
    posts++; const id=nextId++, sales=kind==='sales_order', ref=`TEST-${sales?'SO':'PO'}-${id}`;
    const items=payload.item.items.map((line,index)=>({...line,line:index+1,uniqueKey:id*100+index+1}));
    orders.set(kind,{id,ref,payload:{...payload,item:{items}}});
    if(sales) await query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,order_location_id,order_location,outbound_location_id,outbound_location,status_text,netsuite_active,sales_order_type,delivery_method_id,trandate) VALUES($1,$2,8899100,1,'3445',1,'3445','Pending Fulfillment',true,'Delivery',2,current_date)",[id,ref]);
    else await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,status_text,netsuite_active) VALUES($1,$2,8899200,1,'Pending Receipt',true)",[id,ref]);
    for(const line of items) await query(`INSERT INTO ${sales?'sales_order_lines':'purchase_order_lines'}(${sales?'sales_order_id':'purchase_order_id'},line_id,item_id,item_name,item_description,quantity,unit,netsuite_active)
      VALUES($1,$2,2055,'MBBS-Special Order',$3,$4,'PC',true)`,[id,line.uniqueKey,line.description,line.quantity]);
    return {id};
  }
  const service=createSpecialStockRequestService({
    resolveLocations:async()=>[{netsuiteLocationId:1}],resolveOrderUnits:async lines=>lines.map(line=>({...line,unitId:1})),
    config:{pickupMethodId:1,deliveryMethodId:2},createSalesOrder:payload=>create('sales_order',payload),createPurchaseOrder:payload=>create('purchase_order',payload),
    findMarkerOrders:async({orderKind})=>orders.has(orderKind)?[{id:orders.get(orderKind).id,entity_id:orderKind==='sales_order'?8899100:8899200,location_id:1}]:[],
    fetchSalesOrderReference:async()=>({tranid:orders.get('sales_order').ref,status_text:'Pending Fulfillment'}),
    fetchPurchaseOrderReference:async()=>({tranid:orders.get('purchase_order').ref,status_text:'Pending Receipt'}),
    synchronizeSalesDescriptions:async change=>{
      const payload=orders.get('sales_order').payload;
      await synchronizeSpecialDescriptions(change,{queryAll:async()=>payload.item.items.map(line=>({uniquekey:line.uniqueKey,rest_line_id:line.line,item:2055})),rest:async(_path,options={})=>{
        if(options.method==='PATCH'){patches++;for(const edit of options.body.item.items)payload.item.items.find(line=>line.line===edit.line).description=edit.description;}
        return {data:structuredClone(payload)};
      }});
      if(failSync){failSync=false;throw new Error('Lost acknowledgement after verified SO patch');}
    },sleep:async()=>{}
  });
  detail=await service.createSalesOrder(detail.id,{expectedRevision:detail.revision,operationId:'01911111-1111-7111-8111-111111111121'},context);
  assert.ok(detail.salesOrderSubmissionStartedAt);
  const operationId='01911111-1111-7111-8111-111111111122';
  await assert.rejects(()=>service.createPurchaseOrder(detail.id,{expectedRevision:detail.revision,operationId,lines:[{caseLineId:detail.lines[0].id,description:'SCM reviewed description',quantity:20,uom:'PC',unitPurchaseCost:3}]},context),/Lost acknowledgement/);
  detail=await repository.getSpecialStockCase(detail.id);
  assert.equal(detail.purchaseOrderOperationStatus,'attention');assert.equal(posts,1);
  detail=await service.createPurchaseOrder(detail.id,{expectedRevision:detail.revision,operationId},context);
  assert.equal(detail.stage,'dispatch_arrangement'); assert.equal(detail.attention,false); assert.equal(patches,1);assert.equal(posts,2);
  assert.ok(detail.purchaseOrderSubmissionStartedAt);
  assert.equal(detail.salesOrderLines[0].quantity,1200);assert.equal(detail.salesOrderLines[0].rate,8);
  assert.equal(detail.salesOrderLines[0].description,'SCM reviewed description');assert.equal(detail.purchaseOrderLines[0].quantity,20);
  const canonical=await query('SELECT item_description,quantity FROM sales_order_lines WHERE sales_order_id=$1',[detail.salesOrderId]);
  assert.equal(canonical.rows[0].item_description,'SCM reviewed description');assert.equal(Number(canonical.rows[0].quantity),1200);
  const { listDispatchOrders } = await import('../../../src/dispatch-repository.js');
  const dispatchOrders = await listDispatchOrders({exactOrderRefs:[detail.salesOrderRef],type:'SO'});
  const dispatchOrder = dispatchOrders.find(order=>order.id===detail.salesOrderRef);
  assert.ok(dispatchOrder, 'Special SO is visible in the real Dispatch query');
  assert.equal(dispatchOrder.specialPalletTotal,0); assert.equal(dispatchOrder.pallets,0);
  await assert.rejects(()=>service.createPurchaseOrder(detail.id,{expectedRevision:detail.revision,operationId},context));assert.equal(posts,2);
}));
