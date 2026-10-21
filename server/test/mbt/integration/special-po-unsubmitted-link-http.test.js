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
test('custom PO link resolves an unsubmitted failed PO operation without a stranded lock or draft changes',async()=>{
  const {d,poId,poRef}=await fixture();const operation=crypto.randomUUID(),message='The corresponding reviewed SO line is ambiguous.';
  await query("UPDATE sales_special_stock_cases SET purchase_order_operation_status='attention',purchase_order_operation_id=$2,purchase_order_operation_error=$3,attention=true,attention_reason=$3 WHERE request_id=$1",[d.id,operation,message]);
  const before=(await query('SELECT * FROM sales_special_stock_order_lines WHERE request_id=$1 ORDER BY id',[d.id])).rows;
  const response=await call(d.id,{expectedRevision:d.revision,purchaseOrderRef:poRef,customLinkage:true});
  assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.purchaseOrderId,poId);
  assert.equal(response.body.purchaseOrderOperationStatus,'linked');assert.equal(response.body.purchaseOrderOperationError,'');
  assert.equal(response.body.attention,false);assert.equal(response.body.revision,d.revision+1);
  assert.deepEqual((await query('SELECT * FROM sales_special_stock_order_lines WHERE request_id=$1 ORDER BY id',[d.id])).rows,before);
  const event=response.body.events.find(event=>event.eventType==='special_purchase_order_linked');
  assert.deepEqual(event.details.recoveredUnsubmittedOperation,{operationId:operation,error:message});assert.equal(remoteCalls,0);
});

test('failed custom PO linkage preserves pending-submission, revision and other operation guards atomically',async()=>{
  const {d,poId,poRef}=await fixture(),operation=crypto.randomUUID(),message='Read-only PO recovery failed';
  await query("UPDATE sales_special_stock_cases SET purchase_order_operation_status='attention',purchase_order_operation_id=$2,purchase_order_operation_error=$3,attention=true,attention_reason=$3 WHERE request_id=$1",[d.id,operation,message]);
  const body={expectedRevision:d.revision,purchaseOrderRef:poRef,customLinkage:true};
  const snapshot=async()=>({state:(await query('SELECT * FROM sales_special_stock_cases WHERE request_id=$1',[d.id])).rows,
    events:(await query('SELECT * FROM sales_special_stock_events WHERE request_id=$1 ORDER BY id',[d.id])).rows});
  for(const patch of [{expectedRevision:d.revision-1},{purchaseOrderRef:'UNKNOWN'},{purchaseOrderId:poId+1}]) {
    const before=await snapshot();assert.ok((await call(d.id,{...body,...patch})).status>=400);assert.deepEqual(await snapshot(),before);
  }
  for(const [assignment,undo] of [
    ["purchase_order_submission_started_at=now()","purchase_order_submission_started_at=NULL"],
    ["purchase_order_operation_status='creating'","purchase_order_operation_status='attention'"],
    ["sales_order_operation_status='attention'","sales_order_operation_status='linked'"],
    ["fulfillment_change='{\"status\":\"attention\"}'::jsonb","fulfillment_change='{}'::jsonb"]
  ]) {
    await query(`UPDATE sales_special_stock_cases SET ${assignment} WHERE request_id=$1`,[d.id]);
    const before=await snapshot();assert.equal((await call(d.id,body)).status,409);assert.deepEqual(await snapshot(),before);
    await query(`UPDATE sales_special_stock_cases SET ${undo} WHERE request_id=$1`,[d.id]);
  }
  await query("UPDATE purchase_orders SET vendor_id=12 WHERE netsuite_id=$1",[poId]);
  assert.equal((await call(d.id,body)).status,200,'Manual linkage skips the vendor comparison');
  assert.equal(remoteCalls,0);
});

test('resolving a PO preflight failure preserves unrelated Sales Order attention',async()=>{
  const {d,poRef}=await fixture();
  await query("UPDATE sales_special_stock_cases SET purchase_order_operation_status='attention',purchase_order_operation_id=$2,purchase_order_operation_error='PO preflight failed',attention=true,attention_reason='Sales Order line changed' WHERE request_id=$1",[d.id,crypto.randomUUID()]);
  const response=await call(d.id,{expectedRevision:d.revision,purchaseOrderRef:poRef,customLinkage:true});
  assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.purchaseOrderOperationStatus,'linked');
  assert.equal(response.body.attention,true);assert.equal(response.body.attentionReason,'Sales Order line changed');assert.equal(remoteCalls,0);
});
