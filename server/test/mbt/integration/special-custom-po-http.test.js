import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import crypto from 'node:crypto';
import {app} from '../../../src/server.js';
import {createOperator} from '../../../src/auth-repository.js';
import {query,closeDb} from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';

const run=crypto.randomUUID(),users={},cases=[],soIds=[],poIds=[],fetchOriginal=globalThis.fetch;
let server,base,flag,counter=0,remoteCalls=0;
const idBase=88997000;
async function call(id,body,role='scm') {
  const response=await fetchOriginal(`${base}/api/scm/special-stock-requests/${id}/purchase-order/link`,{method:'POST',headers:{'content-type':'application/json',...(users[role]?{authorization:'Bearer '+users[role].token}:{})},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
}
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
  flag=(await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()),(1784,'PALLET','EACH','{}',now()) ON CONFLICT DO NOTHING");
  await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(88996999,'TEST-CUSTOM-PO','TEST','TEST','CAD',true,now(),'test',repeat('e',64)) ON CONFLICT DO NOTHING");
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;
  for(const role of ['sales','scm']) {
    const username=`custom-po-${role}-${run}`,password=crypto.randomUUID();
    users[role]=await createOperator({username,displayName:'TEST '+role,password,role,roles:[role],yardLocationIds:role==='sales'?[1]:[]});
    const response=await fetchOriginal(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});assert.equal(response.status,200);users[role].token=(await response.json()).token;
  }
  globalThis.fetch=()=>{remoteCalls++;throw Error('Custom linkage must stay local and must never update NetSuite SO descriptions');};
});
after(async()=>{
  try {
    globalThis.fetch=fetchOriginal;if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[cases]);
    await query('DELETE FROM purchase_order_lines WHERE purchase_order_id=ANY($1::bigint[])',[poIds]);await query('DELETE FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[])',[poIds]);
    await query('DELETE FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[])',[soIds]);await query('DELETE FROM sales_orders WHERE netsuite_id=ANY($1::bigint[])',[soIds]);
    for(const user of Object.values(users)){await query('DELETE FROM delivery_audit_log WHERE actor_operator_id=$1',[user.id]);await query('DELETE FROM operators WHERE id=$1',[user.id]);}
    await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'",[flag]);
  }finally{await closeDb();}
});
async function fixture(fulfillmentMethod='yard_pickup') {
  const n=++counter,soId=idBase+n*2,poId=soId+1,poRef=`TEST-CUSTOM-PO-${n}`,context={operatorId:users.sales.id,authorizedStoreLocationIds:[1]};soIds.push(soId);poIds.push(poId);
  let d=await repo.createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerId:88996999,customerName:'TEST',vendorId:8899200,vendorName:'TEST',fulfillmentMethod,deliveryAddress:'TEST Address',deliveryFeeRate:null,lines:[{productName:'SO stone',quantity:144,uom:'Pcs',rate:17.95,requiredDate:'2099-02-01'}]},context);cases.push(d.id);
  d=await repo.respondSpecialStockLine(d.id,d.lines[0].id,{expectedRevision:d.revision,supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:8899200,vendorName:'TEST',vendorYard:'TEST Vendor Yard'},context);
  d=await repo.decideSpecialStockLine(d.id,d.lines[0].id,{expectedRevision:d.revision,decision:'accepted'},context);
  d=await repo.saveSpecialSalesOrderDraft(d.id,{expectedRevision:d.revision,customerId:88996999,operationalYardLocationId:1,fulfillmentMethod,deliveryAddress:'TEST Address',palletTotal:0,materialLines:[{caseLineId:d.lines[0].id,itemId:2055,description:'SO stone',quantity:144,packageQuantity:144,conversionToPc:1,uom:'PC',rate:17.95}]},context);
  await query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,order_location_id,order_location,outbound_location_id,outbound_location,status_text,netsuite_active,sales_order_type,delivery_method_id,trandate) VALUES($1,$2,88996999,1,'3445',1,'3445','Pending Fulfillment',true,'Customer Pickup',1,current_date)",[soId,`TEST-CUSTOM-SO-${n}`]);
  await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES($1,90101,2055,'MBBS-Special Order','SO stone',144,'PC',true)",[soId]);
  d=await repo.linkSpecialSalesOrder(d.id,{expectedRevision:d.revision,source:'standalone',salesOrderId:soId,salesOrderRef:`TEST-CUSTOM-SO-${n}`},context);
  // PO review and actual PO both differ from SO, and from each other in every detail.
  await query("UPDATE sales_special_stock_order_lines SET description='PO draft',quantity=12,uom='SQFT' WHERE request_id=$1 AND order_kind='purchase_order'",[d.id]);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,status_text,netsuite_active) VALUES($1,$2,8899200,1,'Pending Receipt',true)",[poId,poRef]);
  await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES($1,90201,1784,'PALLET','Existing independent PO',3,'EACH',true)",[poId]);
  return {d,soId,poId,poRef,context};
}
test('custom PO number links independently and survives PO webhook without changing SO or saved draft lines',async()=>{
  const {d,soId,poId,poRef}=await fixture();
  const saved=(await query('SELECT * FROM sales_special_stock_order_lines WHERE request_id=$1 ORDER BY id',[d.id])).rows;
  const so=(await query('SELECT * FROM sales_order_lines WHERE sales_order_id=$1',[soId])).rows;
  assert.equal((await call(d.id,{expectedRevision:d.revision,purchaseOrderId:poId,purchaseOrderRef:poRef})).status,409,'Standard linking remains strict');
  const response=await call(d.id,{expectedRevision:d.revision,purchaseOrderRef:'  '+poRef.toLowerCase()+'  ',customLinkage:true,verifiedRemote:true});
  assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.purchaseOrderId,poId);assert.equal(response.body.purchaseOrderRef,poRef);assert.equal(response.body.purchaseOrderCustomLinkage,true);
  assert.deepEqual((await query('SELECT * FROM sales_special_stock_order_lines WHERE request_id=$1 ORDER BY id',[d.id])).rows,saved);
  assert.deepEqual((await query('SELECT * FROM sales_order_lines WHERE sales_order_id=$1',[soId])).rows,so);
  const event=response.body.events.find(event=>event.eventType==='special_purchase_order_linked');assert.equal(event.details.customLinkage,true);
  await query("UPDATE sales_order_lines SET item_description='Later SO edit' WHERE sales_order_id=$1",[soId]);
  assert.equal((await repo.reconcileSpecialOrderWebhook({orderKind:'purchase_order',orderId:poId})).attention,false,'PO webhook must not inspect SO detail');
  assert.equal((await repo.getSpecialStockCase(d.id,{audience:'scm',dispatchPlans:[]})).purchaseOrderCustomLinkage,true);
  assert.equal((await repo.reconcileSpecialOrderWebhook({orderKind:'sales_order',orderId:soId})).attention,true,'SO still validates its own details');
  assert.equal((await repo.reconcileSpecialOrderWebhook({orderKind:'purchase_order',orderId:poId})).attention,true);
  const current=await repo.getSpecialStockCase(d.id,{audience:'scm',dispatchPlans:[]});
  assert.equal(current.attention,true,'PO webhook preserves an independent SO error');
  const again=await call(d.id,{expectedRevision:current.revision,purchaseOrderRef:poRef,customLinkage:true});assert.equal(again.status,200,JSON.stringify(again.body));assert.equal(again.body.attention,true,'Custom linking preserves unrelated SO Attention');assert.equal(remoteCalls,0);
});
test('custom linkage preserves revision, authorization and identity and allows PO sharing while skipping business comparisons',async()=>{
  const {d,poId,poRef}=await fixture();const body={expectedRevision:d.revision,purchaseOrderRef:poRef,customLinkage:true};
  for(const [role,status] of [['none',401],['sales',403]])assert.equal((await call(d.id,body,role)).status,status);
  for(const patch of [{expectedRevision:1},{purchaseOrderRef:''},{purchaseOrderRef:'UNKNOWN'},{purchaseOrderId:poId+100}])assert.ok((await call(d.id,{...body,...patch})).status>=400);
  const unchanged=await repo.getSpecialStockCase(d.id,{audience:'scm',dispatchPlans:[]});assert.equal(unchanged.purchaseOrderId,null);assert.equal(unchanged.purchaseOrderCustomLinkage,false);assert.equal(unchanged.revision,d.revision);
  await query('UPDATE purchase_order_lines SET netsuite_active=false WHERE purchase_order_id=$1',[poId]);
  await query("UPDATE purchase_orders SET vendor_id=12,destination_location_id=28,netsuite_active=false,status_text='Closed' WHERE netsuite_id=$1",[poId]);
  const duplicate=poId+1000;poIds.push(duplicate);await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,status_text,netsuite_active) VALUES($1,$2,8899200,1,'Pending Receipt',true)",[duplicate,poRef.toLowerCase()]);
  assert.equal((await call(d.id,body)).status,409);await query('DELETE FROM purchase_orders WHERE netsuite_id=$1',[duplicate]);
  assert.equal((await call(d.id,body)).status,200);
  const other=await fixture(),shared=await call(other.d.id,{...body,expectedRevision:other.d.revision});
  assert.equal(shared.status,200,JSON.stringify(shared.body));assert.equal(shared.body.purchaseOrderId,poId);
  assert.equal((await repo.getSpecialStockCase(d.id,{audience:'scm',dispatchPlans:[]})).purchaseOrderId,poId);assert.equal(remoteCalls,0);
});
test('custom PO supports vendor-to-yard arrangement without inventing direct line allocation',async()=>{
  const {d,poRef}=await fixture('mbt_delivery');const response=await call(d.id,{expectedRevision:d.revision,purchaseOrderRef:poRef,customLinkage:true});assert.equal(response.status,200,JSON.stringify(response.body));
  const context={operatorId:users.scm.id};let detail=response.body;assert.ok(detail.handoff,'Handoff waits for a route');
  await assert.rejects(repo.chooseSpecialHandoffRoute(d.id,{expectedRevision:detail.revision,requestedRoute:'direct'},context),{code:'SPECIAL_CUSTOM_PO_DIRECT_ALLOCATION_REQUIRED'});
  detail=await repo.chooseSpecialHandoffRoute(d.id,{expectedRevision:detail.revision,requestedRoute:'via_yard'},context);assert.equal(detail.handoffRoute,'via_yard');assert.equal(remoteCalls,0);
});
test('standard linking still requires reviewed matching SO and PO lines and keeps custom mode off',async()=>{
  const {d,poId,poRef}=await fixture();
  const reviewed=await repo.prepareSpecialPurchaseOrder(d.id,{expectedRevision:d.revision,lines:[{caseLineId:d.lines[0].id,description:'SO stone',quantity:144,uom:'PC',unitPurchaseCost:5,vendorDiscountPercent:0}]},{operatorId:users.scm.id});
  await query("UPDATE purchase_order_lines SET item_id=2055,item_name='MBBS-Special Order',item_description='SO stone',quantity=144,unit='PC' WHERE purchase_order_id=$1",[poId]);
  const result=await call(d.id,{expectedRevision:reviewed.revision,purchaseOrderId:poId,purchaseOrderRef:poRef});assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.purchaseOrderCustomLinkage,false);assert.equal(result.body.purchaseOrderLines[0].remoteLineId,90201);assert.equal(result.body.salesOrderLines[0].description,'SO stone');assert.equal(remoteCalls,0);
});

