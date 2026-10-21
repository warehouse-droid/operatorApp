import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import {query,closeDb,withTransaction} from '../../../src/db.js';
import {createDeliveryRequestService,prioritizeDeliveryOrders} from '../../../src/delivery-request-repository.js';
import {createDeliveryRequestRouter} from '../../../src/delivery-request-router.js';
import {upsertDispatchOrderCatalog,listDispatchOrderPool} from '../../../src/dispatch-order-catalog-repository.js';
import {seedDeliveryRates} from '../support/delivery-request-database.js';
import {pricing,window,sales,dispatcher,clock} from '../support/delivery-request-fixtures.js';

let service,server,base;
const events=[];
const other={...sales,id:'delivery-transfer-other',yardLocationIds:[28]};
const command=(row,fields={})=>({expectedRevision:row.revision,operationId:crypto.randomUUID(),...fields});
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');await seedDeliveryRates();
  for(const actor of [sales,dispatcher,other]) {
    await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active)
      VALUES($1,$1,$1,'test','test',$2,ARRAY[$2]::text[],true) ON CONFLICT(id) DO NOTHING`,[actor.id,actor.role]);
  }
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,order_location_id,sales_order_type,netsuite_active,status,status_text)
    VALUES(98950001,'SOTRANSFER',1,'Delivery',true,'B','Pending Fulfillment')`);
  for(const [id,ref,from,to,status,active] of [
    [98950101,'TODRFROM',1,28,'B',true],[98950102,'TODRTO',28,1,'B',true],
    [98950103,'TODROTHER',15,26,'B',true],[98950104,'TODRCLOSED',1,28,'H',true],
    [98950105,'TODRINACTIVE',1,28,'B',false],[98950106,'TODRSECOND',1,28,'B',true],
    [98950107,'TODRPREVIEW',1,28,'B',true],[98950108,'TODRREJECTED',1,28,'C',true]
  ]) {
    await query(`INSERT INTO transfer_orders(netsuite_id,tranid,trandate,from_location_id,to_location_id,from_location,to_location,
      status,status_text,netsuite_active,memo,dispatch_address,synced_at)
      VALUES($1,$2,'2026-10-15',$3,$4,'Sending yard','Receiving yard',$5,$6,$7,'Call before unloading','Destination road',now())`,
    [id,ref,from,to,status,status==='H'?'Closed':status==='C'?'Rejected':'Pending Fulfillment',active]);
  }
  await query(`INSERT INTO transfer_order_lines(line_stage,transfer_order_id,line_id,item_name,item_description,quantity,unit,
    pallet_qty,layer_qty,section_qty,piece_qty,netsuite_active)
    VALUES('outbound',98950107,1,'Stone','Original stone',126,'PCS',1.25,2,0,8,true),
      ('receiving',98950107,1,'Stone','Receiving duplicate',126,'PCS',1.25,2,0,8,true),
      ('outbound',98950107,2,'Old','Retired line',99,'PCS',9,9,9,9,false),
      ('outbound',98950107,3,'Note','No packing',0,'PCS',null,null,null,null,true)`);
  service=createDeliveryRequestService({now:()=>new Date(clock.now),emit:event=>events.push(event),
    resolveDistance:async()=>({providerMetres:20000,originSnapshot:{},destinationSnapshot:{},routeHash:'transfer-fixture'})});
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.operator={sales,dispatch:dispatcher,other,public:{...sales,publicSales:true}}[req.headers['x-test-actor']];next();});
  for(const audience of ['sales','dispatch']) {app.use(`/api/${audience}/delivery-requests`,createDeliveryRequestRouter({service,audience}));}
  app.use((error,_req,res,_next)=>res.status(error.status || 500).json({code:error.code,error:error.message}));
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{server?.closeAllConnections();if(server){await new Promise(resolve=>server.close(resolve));}await closeDb();});
async function approved() {
  const input=pricing(),quote=await service.quote(input,sales);
  const row=await service.create({...input,requestedWindow:window(),quoteId:quote.id,operationId:crypto.randomUUID()},sales);
  return service.act(row.id,'confirm',command(row),dispatcher,'dispatch');
}
async function api(path,actor='sales',method='GET',body) {
  const res=await fetch(base+path,{method,headers:{'x-test-actor':actor,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:res.status,headers:res.headers,data:res.headers.get('content-type')?.includes('json')?await res.json():await res.text()};
}
async function links(id) {return (await query('SELECT order_ref FROM delivery_request_sales_orders WHERE request_id=$1 ORDER BY order_ref',[id])).rows.map(row=>row.order_ref);}

test('TO linking: either endpoint yard secures approval and mixed SO/TO links keep quote and timing',async()=>{
  for(const refs of [['TODRFROM'],['TODRTO'],['SOTRANSFER','TODRFROM','TODRTO']]) {
    const row=await approved(),input=command(row,{salesOrderRefs:refs});
    const result=await api(`/api/sales/delivery-requests/${row.id}/actions/secure`,'sales','POST',input);
    assert.equal(result.status,200,JSON.stringify(result.data));const saved=result.data;
    assert.equal(saved.status,'confirmed');assert.equal(saved.approvalExpiresAt,null);
    assert.deepEqual(saved.salesOrderRefs,refs);assert.deepEqual(saved.quote,row.quote);assert.deepEqual(saved.confirmedWindow,row.confirmedWindow);
    assert.deepEqual(await links(row.id),[...refs].sort());
    const replay=await api(`/api/sales/delivery-requests/${row.id}/actions/secure`,'sales','POST',input);
    assert.equal(replay.data.revision,saved.revision);
  }
});
test('TO linking: missing, inactive, closed, rejected and unrelated-yard transfers leave existing links and events intact',async()=>{
  const row=await approved(),saved=await service.act(row.id,'secure',command(row,{salesOrderRefs:['SOTRANSFER']}),sales,'sales');
  const count=events.length;
  for(const [ref,status] of [['TOMISSING',404],['TODRCLOSED',404],['TODRREJECTED',404],['TODRINACTIVE',404],['TODROTHER',403]]) {
    const result=await api(`/api/sales/delivery-requests/${row.id}/actions/relink`,'sales','POST',command(saved,{salesOrderRefs:['TODRFROM',ref]}));
    assert.equal(result.status,status,JSON.stringify(result.data));assert.deepEqual(await links(row.id),['SOTRANSFER']);
    assert.deepEqual(await service.get(row.id,sales,'sales'),saved);assert.equal(events.length,count);
  }
});
test('TO linking: request yard, private audience and approval deadline remain authoritative',async()=>{
  const row=await approved(),body=command(row,{salesOrderRefs:['TODRFROM']});
  for(const actor of ['other','public','dispatch']) {
    const result=await api(`/api/${actor==='dispatch'?'dispatch':'sales'}/delivery-requests/${row.id}/actions/secure`,actor,'POST',body);
    assert.equal(result.status,403);
  }
  await query("UPDATE delivery_requests SET approval_expires_at='2028-10-01T11:00Z' WHERE id=$1",[row.id]);
  const result=await api(`/api/sales/delivery-requests/${row.id}/actions/secure`,'sales','POST',body);
  assert.equal(result.status,409);assert.equal(result.data.code,'DELIVERY_APPROVAL_EXPIRED');assert.deepEqual(await links(row.id),[]);
});
test('TO linking: mixed replacements roll back, race once, replay once and cancellation releases all references',async()=>{
  const row=await approved(),saved=await service.act(row.id,'secure',command(row,{salesOrderRefs:['TODRFROM']}),sales,'sales');
  const count=events.length;
  await withTransaction(()=>service.act(row.id,'relink',command(saved,{salesOrderRefs:['SOTRANSFER','TODRTO']}),sales,'sales'),{rollback:true});
  assert.deepEqual(await links(row.id),['TODRFROM']);assert.equal(events.length,count);
  const inputs=[command(saved,{salesOrderRefs:['SOTRANSFER','TODRTO']}),command(saved,{salesOrderRefs:['TODRSECOND']})];
  const outcomes=await Promise.allSettled(inputs.map(input=>service.act(row.id,'relink',input,sales,'sales')));
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(outcomes.find(result=>result.status==='rejected').reason.code,'DELIVERY_STALE_REVISION');
  const winner=outcomes.findIndex(result=>result.status==='fulfilled'),changed=outcomes[winner].value;
  assert.deepEqual(await service.act(row.id,'relink',inputs[winner],sales,'sales'),changed);assert.equal(events.length,count+1);
  assert.deepEqual(changed.confirmedWindow,saved.confirmedWindow);assert.deepEqual(changed.quote,saved.quote);
  assert.deepEqual(await links(row.id),[...changed.salesOrderRefs].sort());
  const pending=await service.act(row.id,'request-time-change',command(changed,{window:window({start:'13:00',end:'15:00'})}),sales,'sales');
  const accepted=await service.act(row.id,'accept-time-change',command(pending),dispatcher,'dispatch');
  assert.equal(accepted.confirmedWindow.start,'13:00');assert.deepEqual(accepted.salesOrderRefs,changed.salesOrderRefs);
  const cancelled=await service.act(row.id,'cancel',command(accepted),sales,'sales');
  assert.deepEqual(cancelled.salesOrderRefs,[]);assert.deepEqual(await links(row.id),[]);assert.match(cancelled.history[0].message,/Released/);
});
test('TO planning: normal and paged feeds inherit approved window and cancellation restores original timing',async()=>{
  const row=await approved(),saved=await service.act(row.id,'secure',command(row,{salesOrderRefs:['TODRSECOND']}),sales,'sales');
  const orders=[{id:'TODRSECOND',type:'TO',firstSeenAt:'2020-01-01T00:00:00Z',expectedDeliveryDate:'2028-10-01',windowStart:'07:00',windowEnd:'22:00'},
    {id:'TODRNORMAL',type:'TO',firstSeenAt:'2028-10-01T00:00:00Z'}];
  const decorated=await prioritizeDeliveryOrders(orders);
  assert.equal(decorated[0].id,'TODRSECOND');assert.equal(decorated[0].windowStart,'09:00');assert.equal(decorated[0].windowEnd,'12:00');
  await upsertDispatchOrderCatalog({source:'delivery-transfer-test',orders:decorated});
  const first=await listDispatchOrderPool({type:'TO',limit:1});assert.equal(first.orders[0].id,'TODRSECOND');assert.equal(first.orders[0].deliveryApprovalPriority,true);
  assert.equal(first.orders[0].expectedDeliveryDate,'2028-10-10');
  const second=await listDispatchOrderPool({type:'TO',limit:1,cursor:first.nextCursor});assert.equal(second.orders[0].id,'TODRNORMAL');
  await service.act(row.id,'cancel',command(saved),sales,'sales');
  const restored=(await prioritizeDeliveryOrders(decorated)).find(order=>order.id==='TODRSECOND');
  assert.equal(restored.windowStart,'07:00');assert.equal(restored.windowEnd,'22:00');assert.equal(restored.expectedDeliveryDate,'2028-10-01');assert.notEqual(restored.deliveryApprovalPriority,true);
});
test('TO preview: both teams see retained quantities and endpoint yards without prices or duplicate receiving rows',async()=>{
  const row=await approved(),saved=await service.act(row.id,'secure',command(row,{salesOrderRefs:['TODRPREVIEW']}),sales,'sales');
  for(const audience of ['sales','dispatch']) {
    const result=await api(`/api/${audience}/delivery-requests/${row.id}/transfer-orders/TODRPREVIEW/preview`,audience);
    assert.equal(result.status,200,JSON.stringify(result.data));assert.match(result.headers.get('cache-control'),/private, no-store/);
    assert.equal(result.data.reference,'TODRPREVIEW');assert.equal(result.data.fromYard,'Sending yard');assert.equal(result.data.toYard,'Receiving yard');
    assert.equal(result.data.memo,'Call before unloading');assert.equal(result.data.lines.length,2);
    assert.deepEqual(result.data.lines[0],{description:'Original stone',quantity:'126',unit:'PCS',pallets:'1.25',layers:'2',sections:'0',pieces:'8'});
    assert.deepEqual(result.data.lines[1],{description:'No packing',quantity:'0',unit:'PCS',pallets:null,layers:null,sections:null,pieces:null});
    assert.equal(result.data.total,undefined);assert.equal(result.data.lines[0].rate,undefined);
  }
  for(const actor of ['other','public']) {
    assert.equal((await api(`/api/sales/delivery-requests/${row.id}/transfer-orders/TODRPREVIEW/preview`,actor)).status,403);
  }
  assert.equal((await api(`/api/sales/delivery-requests/${row.id}/transfer-orders/TODRFROM/preview`)).status,403);
  assert.equal((await api(`/api/sales/delivery-requests/${row.id}/sales-orders/TODRPREVIEW/preview`)).status,403);
  await service.act(row.id,'relink',command(saved,{salesOrderRefs:['SOTRANSFER']}),sales,'sales');
  assert.equal((await api(`/api/sales/delivery-requests/${row.id}/transfer-orders/TODRPREVIEW/preview`)).status,403);
  assert.equal((await api(`/api/sales/delivery-requests/${row.id}/transfer-orders/SOTRANSFER/preview`)).status,403);
});
test('TO lookup: closed split families, ambiguous identities and malformed references fail closed',async()=>{
  const {getDeliveryRequestTransferOrder}=await import('../../../src/delivery-request-orders.js');
  for(const ref of ['',123,'SO123',"TO1' OR 1=1"]) {
    await assert.rejects(getDeliveryRequestTransferOrder(ref,1),{code:'DELIVERY_REQUEST_INVALID'});
  }
  await assert.rejects(getDeliveryRequestTransferOrder('TO1/../../SECRET',1),{code:'DELIVERY_ORDER_NOT_FOUND'});
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,from_location_id,to_location_id,netsuite_active,status,status_text)
    VALUES(-98950104,'TODRCLOSEDSPLIT',1,28,true,'B','Pending Fulfillment'),
      (98950201,'TODRDUPLICATE',1,28,true,'B','Pending Fulfillment'),(98950202,'TODRDUPLICATE',1,28,true,'B','Pending Fulfillment')`);
  await query(`INSERT INTO dispatch_scm_to_splits(source_to_id,source_to_ref,split_to_id,split_to_ref)
    VALUES(98950104,'TODRCLOSED',-98950104,'TODRCLOSEDSPLIT')`);
  const row=await approved();
  for(const [ref,status] of [['TODRCLOSEDSPLIT',404],['TODRDUPLICATE',409]]) {
    const result=await api(`/api/sales/delivery-requests/${row.id}/actions/secure`,'sales','POST',command(row,{salesOrderRefs:[ref]}));
    assert.equal(result.status,status,JSON.stringify(result.data));assert.deepEqual(await links(row.id),[]);
  }
});
test('TO preview: unlink during document loading cannot disclose a stale preview',async()=>{
  const row=await approved(),saved=await service.act(row.id,'secure',command(row,{salesOrderRefs:['TODRPREVIEW']}),sales,'sales');
  const changed=createDeliveryRequestService({now:()=>new Date(clock.now),documents:{transferOrder:async()=>{
    await service.act(row.id,'relink',command(saved,{salesOrderRefs:['SOTRANSFER']}),sales,'sales');
    return {reference:'TODRPREVIEW',lines:[]};
  }}});
  await assert.rejects(changed.previewTransferOrder(row.id,'TODRPREVIEW',sales,'sales'),{code:'DELIVERY_ACCESS_DENIED',status:403});
});
