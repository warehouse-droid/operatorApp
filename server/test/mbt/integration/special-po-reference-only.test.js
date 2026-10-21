/* global structuredClone */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, {before, after} from 'node:test';
import {app} from '../../../src/server.js';
import {createOperator} from '../../../src/auth-repository.js';
import {query} from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import {createSpecialStockRequestService} from '../../../src/special-stock-request-service.js';
import {fixture as transportFixture} from '../../support/operator-suiteql-fixture.mjs';

const cases=[],soIds=[],poIds=[],users={},run=crypto.randomUUID();
let server,base,transport,gate,counter=0;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
  transport=await transportFixture();
  gate=(await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()),(1784,'PALLET','EACH','{}',now()) ON CONFLICT DO NOTHING");
  await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(88998599,'TEST-REF-PO','TEST','TEST','CAD',true,now(),'test',repeat('e',64)) ON CONFLICT DO NOTHING");
  server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;
  for(const role of ['sales','scm']){
    const username=`ref-po-${role}-${run}`,password=crypto.randomUUID();
    users[role]=await createOperator({username,displayName:'TEST '+role,password,role,roles:[role],yardLocationIds:role==='sales'?[1]:[]});
    const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
    assert.equal(response.status,200);users[role].token=(await response.json()).token;
  }
});
after(async()=>{
  try{
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[cases]);
    await query('DELETE FROM purchase_order_lines WHERE purchase_order_id=ANY($1::bigint[])',[poIds]);
    await query('DELETE FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[])',[poIds]);
    await query('DELETE FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[])',[soIds]);
    await query('DELETE FROM sales_orders WHERE netsuite_id=ANY($1::bigint[])',[soIds]);
    for(const user of Object.values(users)){
      await query('DELETE FROM delivery_audit_log WHERE actor_operator_id=$1',[user.id]);
      await query('DELETE FROM operators WHERE id=$1',[user.id]);
    }
    await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'",[gate]);
  }finally{await transport?.close();}
});
async function fixture({draft=false,unapproved=false,unreviewed=false,skipLink=false,foreign=false}={}){
  const n=++counter,soId=88998600+n*2,poId=soId+1,poRef=`TEST-REF-PO-${n}`;
  const context={operatorId:users.sales.id,authorizedStoreLocationIds:[1]};soIds.push(soId);poIds.push(poId);
  let d=await repo.createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerId:88998599,customerName:'TEST',vendorId:331,vendorName:'TEST Vendor',fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST Address',deliveryFeeRate:null,
    lines:[{productName:'Urban 100mm',quantity:697.44,uom:'SQFT',rate:10.53,requiredDate:'2099-02-01'}]},context);cases.push(d.id);
  d=await repo.respondSpecialStockLine(d.id,d.lines[0].id,{expectedRevision:d.revision,supplyStatus:'in_stock',availabilityMode:'no_projection',vendorId:331,vendorName:'TEST Vendor',vendorYard:'TEST Vendor Yard'},context);
  d=await repo.decideSpecialStockLine(d.id,d.lines[0].id,{expectedRevision:d.revision,decision:'accepted'},context);
  if(draft)d=await repo.saveSpecialSalesOrderDraft(d.id,{expectedRevision:d.revision,customerId:88998599,operationalYardLocationId:1,fulfillmentMethod:'mbt_delivery',deliveryAddress:'TEST Address',palletTotal:0,materialLines:[{caseLineId:d.lines[0].id,itemId:2055,description:'Old draft material',quantity:697.44,packageQuantity:697.44,conversionToPc:1,uom:'SQFT',rate:10.53}]},context);
  if(draft)await query("UPDATE sales_special_stock_order_lines SET quantity=3,uom='PC' WHERE request_id=$1",[d.id]);
  if(unreviewed)await query("UPDATE sales_special_stock_lines SET sales_decision='pending',supply_status='no_stock',response_vendor_id=NULL WHERE request_id=$1",[d.id]);
  await query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,order_location_id,order_location,outbound_location_id,outbound_location,status_text,netsuite_active,sales_order_type,delivery_method_id,trandate) VALUES($1,$2,88998599,1,'3445',1,'3445','Pending Fulfillment',true,'Delivery',2,current_date)",[soId,`TEST-REF-SO-${n}`]);
  await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES($1,90101,2055,'MBBS-Special Order','Existing SO description',100,'SQFT',true)",[soId]);
  if(unapproved)await query("UPDATE sales_orders SET status_text='Pending Approval',netsuite_active=false WHERE netsuite_id=$1",[soId]);
  if(foreign)await query("UPDATE sales_orders SET customer_id=12,order_location_id=28 WHERE netsuite_id=$1",[soId]);
  const savedDrafts=(await query('SELECT * FROM sales_special_stock_order_lines WHERE request_id=$1 ORDER BY id',[d.id])).rows;
  if(!skipLink)d=await repo.linkSpecialSalesOrder(d.id,{expectedRevision:d.revision,salesOrderRef:`TEST-REF-SO-${n}`},context);
  assert.deepEqual((await query('SELECT * FROM sales_special_stock_order_lines WHERE request_id=$1 ORDER BY id',[d.id])).rows,savedDrafts);
  if(!draft){assert.deepEqual(d.salesOrderLines,[]);assert.deepEqual(d.purchaseOrderLines,[]);assert.equal(d.lines[0].itemResolution,null);}
  const so={id:String(soId),tranId:d.salesOrderRef,orderStatus:{id:'B'},item:{items:[{line:1,lineUniqueKey:'90101',item:{id:'2055'},quantity:100,units:{id:'865'},rate:12,description:'Existing SO description'}]}};
  const po={id:String(poId),tranId:poRef,createdFrom:{id:String(soId)},entity:{id:'331'},location:{id:'1'},orderStatus:{id:'B'},memo:'Existing vendor PO',item:{items:[{line:1,item:{id:'2055'},quantity:100,units:'865',rate:7,description:'Existing vendor PO detail'}]}};
  const calls=[];let posted=false,lost=false,markerVisible=true;
  transport.state.handle=async request=>{
    calls.push(request);
    if(request.method==='GET'&&request.url.pathname.endsWith('/salesOrder/'+soId))return {data:so};
    if(request.method==='GET'&&request.url.pathname.endsWith('/purchaseOrder/'+poId))return {data:po};
    if(request.method==='POST'&&request.url.pathname.endsWith('/record/v1/purchaseOrder')){
      posted=true;return lost?{status:400,data:{error:'Response lost after commit'}}:{status:204,headers:{location:'/services/rest/record/v1/purchaseOrder/'+poId}};
    }
    throw Error('Unexpected remote operation '+request.method+' '+request.url.pathname);
  };
  const service=createSpecialStockRequestService({resolveOrderUnits:async lines=>lines.map(line=>({...line,unitId:865})),
    resolveLocations:async()=>[{netsuiteLocationId:1,subsidiaryId:2}],
    findMarkerOrders:async()=>posted&&markerVisible?[{id:poId,entity_id:331,location_id:1}]:[],
    fetchPurchaseOrderReference:async()=>({tranid:poRef,status_text:'Pending Receipt'}),
    recordPurchaseOrderCreation:async()=>{},sleep:async()=>{}});
  const input=()=>({expectedRevision:d.revision,operationId:crypto.randomUUID(),pallet:{quantity:0},lines:[{caseLineId:d.lines[0].id,description:'Reviewed purchase material',quantity:697.44,uom:'SQFT',unitPurchaseCost:6,vendorDiscountPercent:10}]});
  async function mirrorPo(){
    await query("INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,destination_location_id,status_text,netsuite_active) VALUES($1,$2,331,1,'Pending Receipt',true)",[poId,poRef]);
    await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES($1,90201,2055,'MBBS-Special Order','Independent vendor PO',100,'SQFT',true)",[poId]);
  }
  return {d,soId,poId,poRef,context,so,po,calls,service,input,mirrorPo,loseResponse:()=>{lost=true;},hideMarker:()=>{markerVisible=false;}};
}
async function snapshot(id){return (await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1 ORDER BY id',[id])).rows;}
test('reference-only manual PO HTTP linkage ignores absent mappings and drafts and remains arrangeable',async()=>{
  const f=await fixture();await f.mirrorPo();const before=await snapshot(f.d.id);
  const response=await fetch(`${base}/api/scm/special-stock-requests/${f.d.id}/purchase-order/link`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+users.scm.token},body:JSON.stringify({expectedRevision:f.d.revision,purchaseOrderRef:f.poRef,customLinkage:true})});
  const d=await response.json();assert.equal(response.status,200,JSON.stringify(d));assert.equal(d.purchaseOrderId,f.poId);
  assert.deepEqual(await snapshot(f.d.id),before);assert.deepEqual(d.salesOrderLines,[]);assert.deepEqual(d.purchaseOrderLines,[]);
  assert.ok(d.handoff);assert.equal(d.purchaseOrderCustomLinkage,true);assert.equal(f.calls.length,0);
  assert.equal((await repo.reconcileSpecialOrderWebhook({orderKind:'purchase_order',orderId:f.poId})).attention,false);
  const refreshed=await repo.getSpecialStockCase(d.id,{audience:'scm',dispatchPlans:[]});
  await assert.rejects(repo.chooseSpecialHandoffRoute(d.id,{expectedRevision:refreshed.revision,requestedRoute:'direct'},{operatorId:users.scm.id}),{code:'SPECIAL_CUSTOM_PO_DIRECT_ALLOCATION_REQUIRED'});
  const arranged=await repo.chooseSpecialHandoffRoute(d.id,{expectedRevision:refreshed.revision,requestedRoute:'via_yard'},{operatorId:users.scm.id});assert.equal(arranged.handoffRoute,'via_yard');
});
test('reference-only PO review inserts all purchase materials and retries without adding SO draft lines',async()=>{
  const f=await fixture(),input=f.input();let d=await repo.prepareSpecialPurchaseOrder(f.d.id,input,f.context);
  assert.equal(d.purchaseOrderLines.length,1);assert.deepEqual(d.salesOrderLines,[]);
  assert.deepEqual(d.purchaseOrderLines.map(l=>[l.caseLineId,l.itemId,l.quantity,l.uom,l.unitPurchaseCost]),[[f.d.lines[0].id,2055,697.44,'SQFT',6]]);
  assert.equal(d.purchaseOrderCustomLinkage,true);assert.equal(d.vendorDiscountReview.amount,418.46);
  d=await repo.prepareSpecialPurchaseOrder(d.id,{...input,expectedRevision:d.revision,lines:input.lines.map(l=>({...l,quantity:12,vendorDiscountPercent:0}))},f.context);
  assert.equal(d.purchaseOrderLines.length,1);assert.equal(d.purchaseOrderLines[0].quantity,12);assert.equal(d.vendorDiscountReview.amount,0);assert.deepEqual(d.salesOrderLines,[]);
});
test('incomplete, duplicate, foreign and invalid reference-only PO reviews preserve the original case',async()=>{
  const f=await fixture();const original=await snapshot(f.d.id);
  for(const patch of [{lines:[]},{lines:[...f.input().lines,...f.input().lines]},{lines:f.input().lines.map(l=>({...l,caseLineId:l.caseLineId+999}))},{expectedRevision:f.d.revision-1},{lines:f.input().lines.map(l=>({...l,vendorDiscountPercent:''}))},{lines:f.input().lines.map(l=>({...l,unitPurchaseCost:-1}))},{lines:f.input().lines.map(l=>({...l,quantity:'NaN'}))},{lines:f.input().lines.map(l=>({...l,uom:''}))},{lines:f.input().lines.map(l=>({...l,vendorDiscountPercent:101}))}]){
    await assert.rejects(repo.prepareSpecialPurchaseOrder(f.d.id,{...f.input(),...patch},f.context));
    assert.deepEqual(await snapshot(f.d.id),original);assert.deepEqual((await repo.getSpecialStockCase(f.d.id,{dispatchPlans:[]})).purchaseOrderLines,[]);
  }
});
for(const lost of [false,true])test('reference-only SO creates a reviewed standalone PO without SO writes'+(lost?' and recovers a lost response':''),async()=>{
  const f=await fixture();if(lost)f.loseResponse();const original=structuredClone(f.so);
  const d=await f.service.createPurchaseOrder(f.d.id,f.input(),{operatorId:users.scm.id});
  assert.equal(d.purchaseOrderId,f.poId);assert.equal(d.purchaseOrderCustomLinkage,true);assert.equal(d.attention,false);assert.deepEqual(d.salesOrderLines,[]);
  assert.deepEqual(f.so,original);assert.equal(f.calls.length,1,'manual SO creation must not read or update its order');const writes=f.calls.filter(c=>c.method!=='GET');assert.equal(writes.length,1);
  const payload=writes[0].body;assert.equal(payload.externalId,'MBBS-SPECIAL-PO:'+d.id);assert.equal(payload.custbody7,'for '+f.d.salesOrderRef);
  assert.deepEqual(payload.item.items.map(l=>[l.item.id,l.quantity,l.rate]),[['2055',697.44,6],['4981',1,-418.46]]);assert.equal(payload.item.items[0].units,'865');
  await f.mirrorPo();assert.equal((await repo.reconcileSpecialOrderWebhook({orderKind:'purchase_order',orderId:f.poId})).attention,false);
  assert.ok((await repo.getSpecialStockCase(d.id,{dispatchPlans:[]})).handoff);
});
test('manual SO native pointers do not replace the reviewed request PO creation',async()=>{
  const f=await fixture();f.so.item.items[0].createdPo={id:String(f.poId)};const before=structuredClone({so:f.so,po:f.po});await f.mirrorPo();
  const d=await f.service.createPurchaseOrder(f.d.id,f.input(),{operatorId:users.scm.id});
  assert.equal(d.purchaseOrderId,f.poId);assert.equal(d.purchaseOrderCustomLinkage,true);assert.equal(d.attention,false);
  assert.ok(d.purchaseOrderSubmissionStartedAt);assert.deepEqual({so:f.so,po:f.po},before);assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'POST');
});

test('manual SO HTTP linking skips customer, yard, activity, approval, stock and decision comparisons',async()=>{
  const f=await fixture({skipLink:true,foreign:true,unapproved:true,unreviewed:true});
  assert.ok((await repo.searchSpecialOrderLinks({kind:'sales_order',search:`TEST-REF-SO-${counter}`})).some(order=>order.id===f.soId));
  const before=await snapshot(f.d.id),order=(await query('SELECT * FROM sales_orders WHERE netsuite_id=$1',[f.soId])).rows;
  const response=await fetch(`${base}/api/sales/special-stock-requests/${f.d.id}/sales-order/link`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+users.sales.token},body:JSON.stringify({expectedRevision:f.d.revision,salesOrderRef:`TEST-REF-SO-${counter}`})});
  const d=await response.json();assert.equal(response.status,200,JSON.stringify(d));assert.equal(d.salesOrderId,f.soId);assert.equal(d.salesOrderApproved,false);
  assert.deepEqual(await snapshot(f.d.id),before);assert.deepEqual((await query('SELECT * FROM sales_orders WHERE netsuite_id=$1',[f.soId])).rows,order);assert.deepEqual(d.salesOrderLines,[]);assert.equal(f.calls.length,0);
});
test('manual PO links without an SO, accepted decisions, stock, vendor, yard, active order or cargo lines',async()=>{
  const f=await fixture({skipLink:true,unreviewed:true});await f.mirrorPo();
  await query("UPDATE purchase_orders SET vendor_id=12,destination_location_id=28,netsuite_active=false,status_text='Closed' WHERE netsuite_id=$1",[f.poId]);
  assert.ok((await repo.searchSpecialOrderLinks({kind:'purchase_order',search:f.poRef})).some(order=>order.id===f.poId));
  await query('DELETE FROM purchase_order_lines WHERE purchase_order_id=$1',[f.poId]);const before=await snapshot(f.d.id);
  const d=await repo.linkSpecialPurchaseOrder(f.d.id,{expectedRevision:f.d.revision,purchaseOrderRef:f.poRef,customLinkage:true},{operatorId:users.scm.id});
  assert.equal(d.purchaseOrderId,f.poId);assert.equal(d.salesOrderId,null);assert.equal(d.purchaseOrderCustomLinkage,true);assert.deepEqual(await snapshot(f.d.id),before);assert.equal(f.calls.length,0);
});
test('manual SO with an old draft and pending approval creates only the SCM-reviewed request PO',async()=>{
  const f=await fixture({draft:true,unapproved:true});const saved=(await query("SELECT * FROM sales_special_stock_order_lines WHERE request_id=$1 AND order_kind='sales_order' ORDER BY id",[f.d.id])).rows;
  const order=(await query('SELECT * FROM sales_order_lines WHERE sales_order_id=$1',[f.soId])).rows;
  const d=await f.service.createPurchaseOrder(f.d.id,f.input(),{operatorId:users.scm.id});
  assert.equal(d.purchaseOrderId,f.poId);assert.equal(d.purchaseOrderCustomLinkage,true);assert.equal(d.purchaseOrderLines[0].quantity,697.44);
  assert.deepEqual((await query("SELECT * FROM sales_special_stock_order_lines WHERE request_id=$1 AND order_kind='sales_order' ORDER BY id",[f.d.id])).rows,saved);
  assert.deepEqual((await query('SELECT * FROM sales_order_lines WHERE sales_order_id=$1',[f.soId])).rows,order);assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'POST');
});

test('manual PO linkage cannot overwrite an unresolved submitted operation even if its status was reset',async()=>{
  const f=await fixture();await f.mirrorPo();await query("UPDATE sales_special_stock_cases SET purchase_order_submission_started_at=now(),purchase_order_operation_status='idle' WHERE request_id=$1",[f.d.id]);
  const before=(await query('SELECT * FROM sales_special_stock_cases WHERE request_id=$1',[f.d.id])).rows;
  await assert.rejects(repo.linkSpecialPurchaseOrder(f.d.id,{expectedRevision:f.d.revision,purchaseOrderRef:f.poRef,customLinkage:true},{operatorId:users.scm.id}),{code:'SPECIAL_OPERATION_BUSY'});
  assert.deepEqual((await query('SELECT * FROM sales_special_stock_cases WHERE request_id=$1',[f.d.id])).rows,before);assert.equal(f.calls.length,0);
});

test('concurrent manual-SO purchase creation produces one PO submission and one revision conflict',async()=>{
  const f=await fixture();const results=await Promise.allSettled([f.service.createPurchaseOrder(f.d.id,f.input(),{operatorId:users.scm.id}),f.service.createPurchaseOrder(f.d.id,f.input(),{operatorId:users.scm.id})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.filter(result=>result.status==='rejected'&&result.reason.code==='SPECIAL_REVISION_CONFLICT').length,1);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'POST');
  assert.equal((await repo.getSpecialStockCase(f.d.id,{dispatchPlans:[]})).purchaseOrderId,f.poId);
});
test('manual-SO PO submission with an invisible marker can recover without automatic resubmission',async()=>{
  const f=await fixture();f.loseResponse();f.hideMarker();const input=f.input();
  await assert.rejects(f.service.createPurchaseOrder(f.d.id,input,{operatorId:users.scm.id}),{code:'SPECIAL_REMOTE_OUTCOME_UNCERTAIN'});
  const failed=await repo.getSpecialStockCase(f.d.id,{dispatchPlans:[]});assert.ok(failed.purchaseOrderSubmissionStartedAt);assert.equal(failed.purchaseOrderOperationStatus,'attention');
  await assert.rejects(f.service.createPurchaseOrder(f.d.id,{...input,expectedRevision:failed.revision},{operatorId:users.scm.id}),{code:'SPECIAL_REMOTE_OUTCOME_UNCERTAIN'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'POST');
});

test('manual PO can be linked before the SO and the ready pair becomes arrangeable after SO linking',async()=>{
  const f=await fixture({skipLink:true});await f.mirrorPo();
  const purchase=await repo.linkSpecialPurchaseOrder(f.d.id,{expectedRevision:f.d.revision,purchaseOrderRef:f.poRef,customLinkage:true},{operatorId:users.scm.id});
  assert.equal(purchase.salesOrderId,null);assert.equal(purchase.handoff,null);
  const linked=await repo.linkSpecialSalesOrder(f.d.id,{expectedRevision:purchase.revision,salesOrderRef:`TEST-REF-SO-${counter}`},f.context);
  assert.ok(linked.handoff,'Both existing synced orders should be ready for arrangement in either link order');
  const arranged=await repo.chooseSpecialHandoffRoute(f.d.id,{expectedRevision:linked.revision,requestedRoute:'via_yard'},{operatorId:users.scm.id});
  assert.equal(arranged.handoffRoute,'via_yard');assert.equal(f.calls.length,0);
});
