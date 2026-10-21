import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import {query,closeDb,withTransaction} from '../../../src/db.js';
import {createDeliveryRequestService} from '../../../src/delivery-request-repository.js';
import {createDeliveryRequestRouter} from '../../../src/delivery-request-router.js';
import {createDeliveryRequestDocuments} from '../../../src/delivery-request-documents.js';
import {seedDeliveryRates} from '../support/delivery-request-database.js';
import {pricing,window,sales,dispatcher,clock} from '../support/delivery-request-fixtures.js';

let service,server,base;
const events=[],reads=[];
const other={...sales,id:'delivery-other',yardLocationIds:[28]};
const documents=createDeliveryRequestDocuments({
  findEstimate:async ref=>ref==='ESTMISSING'?null:{id:51,tranid:ref,location:ref==='ESTOTHER'?28:1},
  readEstimate:async()=>({id:'51',tranId:'ESTB123',location:{id:'1'},entity:{refName:'Customer'},total:67.8,item:{items:[]}}),
  fetchSalesOrderPdf:async id=>{reads.push(id);return {buffer:Buffer.from('%PDF-1.4 original'),filename:'SO123.pdf'};}
});
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  await seedDeliveryRates();
  for(const actor of [sales,dispatcher,other]) {
    await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active)
      VALUES($1,$1,$1,'test','test',$2,ARRAY[$2]::text[],true) ON CONFLICT(id) DO NOTHING`,[actor.id,actor.role]);
  }
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,trandate,customer,status,status_text,order_location_id,sales_order_type,netsuite_active,synced_at)
    VALUES(98708001,'SOENHANCE1',current_date,'Enhancement','Pending Fulfillment','Pending Fulfillment',1,'Delivery',true,now()),
    (98708002,'SOENHANCE2',current_date,'Enhancement','Pending Fulfillment','Pending Fulfillment',1,'Delivery',true,now())`);
  service=createDeliveryRequestService({documents,now:()=>new Date(clock.now),emit:event=>events.push(event),
    resolveDistance:async()=>({providerMetres:20000,routeHash:'fixture',originSnapshot:{},destinationSnapshot:{}})});
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.operator={sales,dispatch:dispatcher,other,public:{...sales,publicSales:true}}[req.headers['x-test-actor']];next();});
  for(const audience of ['sales','dispatch']) {app.use(`/api/${audience}/delivery-requests`,createDeliveryRequestRouter({service,audience}));}
  app.use((error,_req,res,_next)=>res.status(error.status || 500).json({code:error.code,error:error.message}));
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{server?.closeAllConnections();if(server){await new Promise(resolve=>server.close(resolve));}await closeDb();});
const command=(row,fields={})=>({expectedRevision:row.revision,operationId:crypto.randomUUID(),...fields});
async function submit(fields={}) {
  const input={...pricing(),...fields},quote=await service.quote(input,sales);
  return service.create({...input,requestedWindow:window(),quoteId:quote.id,operationId:crypto.randomUUID()},sales);
}
async function api(path,actor='sales',method='GET',body) {
  const res=await fetch(base+path,{method,headers:{'x-test-actor':actor,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:res.status,headers:res.headers,data:res.headers.get('content-type')?.includes('application/pdf')?await res.text():await res.json()};
}
test('reply records team and author, notifies both sides, replays once and preserves secured workflow',async()=>{
  const row=await submit(),approved=await service.act(row.id,'confirm',command(row),dispatcher,'dispatch');
  let current=await service.act(row.id,'secure',command(approved,{salesOrderRefs:['SOENHANCE1']}),sales,'sales');
  const stable={status:current.status,quote:current.quote,confirmedWindow:current.confirmedWindow,salesOrderRefs:current.salesOrderRefs,securedAt:current.securedAt};
  const count=events.length,input=command(current,{message:'  Please call before arrival.  '});
  const path=`/api/dispatch/delivery-requests/${row.id}/actions/reply`;
  const reply=await api(path,'dispatch','POST',input);assert.equal(reply.status,200,JSON.stringify(reply.data));current=reply.data;
  for(const [key,value] of Object.entries(stable)){assert.deepEqual(current[key],value);}
  assert.equal(current.history[0].action,'reply');assert.equal(current.conversation.at(-1).audience,'dispatch');
  assert.equal(current.conversation.at(-1).actorName,dispatcher.id);assert.equal(current.conversation.at(-1).message,'Please call before arrival.');
  assert.equal((await service.alerts(sales,'sales')).requests.find(item=>item.id===row.id).action,'reply');
  assert.equal((await api(path,'dispatch','POST',input)).data.revision,current.revision);assert.equal(events.length,count+1);
  const salesReply=await api(`/api/sales/delivery-requests/${row.id}/actions/reply`,'sales','POST',command(current,{message:'Confirmed, I will tell the customer.'}));
  assert.equal(salesReply.status,200);assert.equal(salesReply.data.status,'confirmed');
  assert.equal(salesReply.data.conversation.at(-1).audience,'sales');
  assert.equal((await service.alerts(dispatcher,'dispatch')).requests.find(item=>item.id===row.id).action,'reply');
  await service.markRead(row.id,current.revision,dispatcher,'dispatch');
  assert.ok((await service.alerts(dispatcher,'dispatch')).requests.some(item=>item.id===row.id));
});
test('invalid replies, rollback and competing replies cannot partially write messages or emit duplicate events',async()=>{
  const row=await submit(),count=events.length;
  for(const [actor,message,status] of [['other','Hi',403],['public','Hi',403],['sales',' ',400],['sales','x'.repeat(2001),400]]) {
    const result=await api(`/api/sales/delivery-requests/${row.id}/actions/reply`,actor,'POST',command(row,{message}));
    assert.equal(result.status,status,JSON.stringify(result.data));
  }
  assert.equal((await service.get(row.id,sales,'sales')).revision,row.revision);assert.equal(events.length,count);
  await withTransaction(()=>service.act(row.id,'reply',command(row,{message:'Rolled back'}),sales,'sales'),{rollback:true});
  assert.equal((await service.get(row.id,sales,'sales')).conversation.length,0);assert.equal(events.length,count);
  const outcomes=await Promise.allSettled([
    service.act(row.id,'reply',command(row,{message:'Sales reply'}),sales,'sales'),
    service.act(row.id,'reply',command(row,{message:'Dispatch reply'}),dispatcher,'dispatch')]);
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(outcomes.find(result=>result.status==='rejected').reason.code,'DELIVERY_STALE_REVISION');
  const saved=await service.get(row.id,sales,'sales');assert.equal(saved.conversation.length,1);assert.equal(saved.revision,row.revision+1);assert.equal(events.length,count+1);
});
test('legacy proposal messages remain visible on the conversation board',async()=>{
  const row=await submit(),proposed=await service.act(row.id,'propose',command(row,{window:window(),message:'Would afternoon work?'}),dispatcher,'dispatch');
  await query("UPDATE delivery_request_events SET snapshot=snapshot-'eventAudience' WHERE request_id=$1",[row.id]);
  const saved=await service.get(row.id,sales,'sales');
  assert.equal(saved.conversation.at(-1).message,'Would afternoon work?');assert.equal(saved.conversation.at(-1).audience,'dispatch');
  assert.equal(saved.revision,proposed.revision);
});
test('system instructions, reminders and expiry stay in history without crowding human conversation',async()=>{
  const row=await submit(),approved=await service.act(row.id,'confirm',command(row),dispatcher,'dispatch');
  let saved=await service.act(row.id,'secure',command(approved,{salesOrderRefs:['SOENHANCE1']}),sales,'sales');
  saved=await service.act(row.id,'reply',command(saved,{message:'Please keep the customer informed.'}),sales,'sales');
  await service.instructionChanged('SOENHANCE1',sales.id);
  for(const audience of ['sales','dispatch']) {
    const response=await api(`/api/${audience}/delivery-requests/${row.id}`,audience);
    assert.equal(response.status,200);
    assert.deepEqual(response.data.conversation.map(event=>event.message),['Please keep the customer informed.']);
    assert.equal(response.data.history[0].action,'instructions');
    assert.match(response.data.history[0].message,/Delivery instructions updated/);
    saved=response.data;
  }
  const auditCount=await query('SELECT count(*)::int AS count FROM delivery_request_events WHERE request_id=$1',[row.id]);
  await query(`INSERT INTO delivery_request_events(request_id,revision,action,actor_name,message,snapshot,created_at)
    SELECT $1,$2+sequence,CASE WHEN sequence=1 THEN 'reply' ELSE 'instructions' END,'System','Delivery instructions updated for SOENHANCE1.',$3,now()
    FROM generate_series(1,201) AS sequence`,[row.id,saved.revision,{eventAudience:'system'}]);
  await query('UPDATE delivery_requests SET revision=revision+201 WHERE id=$1',[row.id]);
  const crowded=await service.get(row.id,sales,'sales');
  assert.deepEqual(crowded.conversation.map(event=>event.message),['Please keep the customer informed.']);
  assert.equal(crowded.history.length,200);
  assert.equal((await query('SELECT count(*)::int AS count FROM delivery_request_events WHERE request_id=$1',[row.id])).rows[0].count,auditCount.rows[0].count+201);
  const pending=await submit(),preapproved=await service.act(pending.id,'confirm',command(pending),dispatcher,'dispatch');
  await service.act(pending.id,'reply',command(preapproved,{message:'Waiting for the SO number.'}),sales,'sales');
  let instant=new Date(new Date(preapproved.reminderAt).getTime()+60000);
  const background=createDeliveryRequestService({now:()=>instant});await background.tick();
  const reminded=await service.get(pending.id,sales,'sales');
  assert.ok(reminded.history.some(event=>event.action==='remind'));
  assert.deepEqual(reminded.conversation.map(event=>event.message),['Waiting for the SO number.']);
  instant=new Date(new Date(preapproved.approvalExpiresAt).getTime()+60000);await background.tick();
  const expired=await service.get(pending.id,sales,'sales');
  assert.equal(expired.status,'expired');assert.equal(expired.history[0].action,'expire');
  assert.deepEqual(expired.conversation.map(event=>event.message),['Waiting for the SO number.']);
});
test('workflow comments contain only human text, with existing generated audit summaries preserved',async()=>{
  const row=await submit(),approved=await service.act(row.id,'confirm',command(row),dispatcher,'dispatch');
  let saved=await service.act(row.id,'secure',command(approved,{salesOrderRefs:['SOENHANCE1']}),sales,'sales');
  const notes=[],later=window({start:'13:00',end:'15:00'});
  const steps=[
    ['request-time-change',sales,'sales',{window:later,message:'Customer needs the afternoon.'}],
    ['accept-time-change',dispatcher,'dispatch',{message:'That works for the route.'}],
    ['request-time-change',sales,'sales',{window:window()}],
    ['decline-time-change',dispatcher,'dispatch',{message:'The morning route is full.'}],
    ['request-time-change',sales,'sales',{window:window(),message:'Can we try the morning again?'}],
    ['withdraw-time-change',sales,'sales',{message:'Keep the afternoon, please.'}],
    ['relink',sales,'sales',{salesOrderRefs:['SOENHANCE2'],message:'Please use the revised SO.'}],
    ['relink',sales,'sales',{salesOrderRefs:['SOENHANCE1']}],
    ['cancel',sales,'sales',{message:'Cancelled. Customer will collect instead.'}]
  ];
  for(const [action,actor,audience,fields] of steps) {
    saved=await service.act(row.id,action,command(saved,fields),actor,audience);
    if(fields.message){notes.push(fields.message);}
    assert.deepEqual(saved.conversation.map(event=>event.message),notes);
    assert.equal(saved.history[0].action,action);
  }
  assert.match(saved.history[0].message,/Cancelled\. Released Sales Orders: SOENHANCE1\./);
  const history=saved.history;
  await query("UPDATE delivery_request_events SET snapshot=snapshot-'conversationMessage' WHERE request_id=$1",[row.id]);
  const legacy=await service.get(row.id,sales,'sales');
  assert.deepEqual(legacy.conversation.map(event=>event.message),notes);
  assert.deepEqual(legacy.history,history);
});
test('retrying an older cached reply cleans its conversation without including later messages or writing another event',async()=>{
  const row=await submit(),input=command(row,{message:'First note.'});
  const first=await service.act(row.id,'reply',input,sales,'sales');
  await service.act(row.id,'reply',command(first,{message:'Later note.'}),dispatcher,'dispatch');
  await query(`UPDATE delivery_request_operations SET response=jsonb_set(response,'{conversation}',$3)
    WHERE operator_id=$1 AND operation_id=$2`,[sales.id,input.operationId,JSON.stringify([...first.conversation,
    {revision:1,action:'instructions',audience:'system',actorName:'System',message:'Delivery instructions updated.'}])]);
  const count=events.length;
  const replay=await service.act(row.id,'reply',input,sales,'sales');
  assert.deepEqual(replay,first);
  assert.deepEqual(replay.conversation.map(event=>event.message),['First note.']);
  assert.equal(events.length,count);
  assert.equal((await query('SELECT count(*)::int AS count FROM delivery_request_events WHERE request_id=$1',[row.id])).rows[0].count,3);
});
test('more than one batch of legacy automatic workflow updates cannot hide an earlier human message',async()=>{
  const row=await submit(),approved=await service.act(row.id,'confirm',command(row),dispatcher,'dispatch');
  let saved=await service.act(row.id,'secure',command(approved,{salesOrderRefs:['SOENHANCE1']}),sales,'sales');
  saved=await service.act(row.id,'reply',command(saved,{message:'Please call the customer first.'}),sales,'sales');
  const snapshot={...saved,eventAudience:'sales'};delete snapshot.history;delete snapshot.conversation;
  await query(`INSERT INTO delivery_request_events(request_id,revision,action,actor_id,actor_name,message,snapshot,created_at)
    SELECT $1,$2+sequence,'relink',$3,$3,'Sales Order links changed: SOENHANCE1 → SOENHANCE1.',
      jsonb_set($4::jsonb,'{revision}',to_jsonb($2+sequence)),now() FROM generate_series(1,201) AS sequence`,
  [row.id,saved.revision,sales.id,snapshot]);
  await query('UPDATE delivery_requests SET revision=revision+201 WHERE id=$1',[row.id]);
  const legacy=await service.get(row.id,sales,'sales');
  assert.deepEqual(legacy.conversation.map(event=>event.message),['Please call the customer first.']);
  assert.equal(legacy.history.length,200);
  assert.ok(legacy.history.every(event=>event.action==='relink'));
  assert.equal((await query('SELECT count(*)::int AS count FROM delivery_request_events WHERE request_id=$1',[row.id])).rows[0].count,205);
});
test('POS splits and BIN yard quantities persist and BIN capacity ignores forged client claims',async()=>{
  const input=pricing({outbounds:[{originYardCode:'3445',fullPosQty:25,loosePosQty:2,totalUnits:27}]});
  const row=await submit(input);assert.deepEqual(row.outbounds,input.outbounds);assert.equal(row.quote.trips,2);
  const bin=pricing({loadType:'bin',totalUnits:14.01,binTypeCode:'14YD',aggregate:'HPE',quantityUnit:'yard',binCapacityYards:10000});
  const binRow=await submit(bin);assert.equal(binRow.binCapacityYards,14);assert.equal(binRow.quote.trips,2);assert.equal(binRow.aggregate,'HPE');
  const quote=await service.quote(bin,sales);
  await assert.rejects(service.create({...bin,aggregate:'Gravel',requestedWindow:window(),quoteId:quote.id,operationId:crypto.randomUUID()},sales),{code:'DELIVERY_QUOTE_CHANGED'});
  assert.equal((await query('SELECT consumed_at FROM delivery_request_quotes WHERE id=$1',[quote.id])).rows[0].consumed_at,null);
  await query("UPDATE mbt_bin_types SET nominal_yards=15 WHERE type_code='14YD'");
  try {await assert.rejects(service.create({...bin,requestedWindow:window(),quoteId:quote.id,operationId:crypto.randomUUID()},sales),{code:'DELIVERY_QUOTE_CHANGED'});}
  finally {await query("UPDATE mbt_bin_types SET nominal_yards=14 WHERE type_code='14YD'");}
});
test('changing BIN to POS removes obsolete aggregate, Yard unit and BIN capacity from the saved request',async()=>{
  const bin=await submit(pricing({loadType:'bin',totalUnits:14,binTypeCode:'14YD',aggregate:'Gravel',quantityUnit:'yard'}));
  const input=pricing({outbounds:[{originYardCode:'3445',fullPosQty:1,loosePosQty:0,totalUnits:1}]}),quote=await service.quote(input,sales);
  const updated=await service.act(bin.id,'edit',command(bin,{...input,requestedWindow:window(),quoteId:quote.id}),sales,'sales');
  assert.equal(updated.loadType,'pos');assert.equal(updated.binTypeCode,null);
  assert.equal(updated.quantityUnit,undefined);assert.equal(updated.aggregate,undefined);assert.equal(updated.binCapacityYards,undefined);
});
test('optional EST attachment persists through edit and preview endpoints enforce role and yard',async()=>{
  const row=await submit({estimateRef:' estb123 '});assert.equal(row.estimateRef,'ESTB123');assert.equal(row.estimateId,51);
  const quoted=await service.quote(pricing(),sales);
  const edited=await service.act(row.id,'edit',command(row,{...pricing(),requestedWindow:window(),quoteId:quoted.id,estimateRef:'ESTB123'}),sales,'sales');
  assert.equal(edited.estimateRef,'ESTB123');
  const preview=await api(`/api/sales/delivery-requests/estimates/ESTB123/preview?yard=1`);assert.equal(preview.status,200,JSON.stringify(preview.data));assert.equal(preview.data.total,67.8);
  const savedPath=`/api/dispatch/delivery-requests/${row.id}/estimate/preview`;
  assert.equal((await api(savedPath,'dispatch')).status,200);assert.match(preview.headers.get('cache-control'),/no-store/);
  assert.equal((await api(savedPath,'sales')).status,403);
  assert.equal((await api(`/api/sales/delivery-requests/${row.id}/estimate/preview`,'other')).status,403);
  assert.equal((await api('/api/sales/delivery-requests/estimates/ESTB123/preview?yard=1','public')).status,403);
  await assert.rejects(submit({estimateRef:'ESTOTHER'}),{status:403});
  await assert.rejects(submit({estimateRef:'ESTMISSING'}),{status:404});
});
test('native SO preview is available to both teams only while the SO remains linked',async()=>{
  const row=await submit(),approved=await service.act(row.id,'confirm',command(row),dispatcher,'dispatch');
  let current=await service.act(row.id,'secure',command(approved,{salesOrderRefs:['SOENHANCE1']}),sales,'sales');
  for(const audience of ['sales','dispatch']) {
    const result=await api(`/api/${audience}/delivery-requests/${row.id}/sales-orders/SOENHANCE1/preview`,audience);
    assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data,'%PDF-1.4 original');assert.match(result.headers.get('content-disposition'),/inline/);
  }
  const count=reads.length;
  assert.equal((await api(`/api/sales/delivery-requests/${row.id}/sales-orders/SOENHANCE2/preview`)).status,403);
  assert.equal((await api(`/api/sales/delivery-requests/${row.id}/sales-orders/SOENHANCE1/preview`,'other')).status,403);assert.equal(reads.length,count);
  current=await service.act(row.id,'relink',command(current,{salesOrderRefs:['SOENHANCE2']}),sales,'sales');
  assert.equal((await api(`/api/dispatch/delivery-requests/${row.id}/sales-orders/SOENHANCE1/preview`,'dispatch')).status,403);
  assert.equal((await service.get(row.id,sales,'sales')).revision,current.revision);assert.equal(reads.length,count);
});
