import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import {createSpecialStockCase,requestSpecialStockInformation,getSpecialStockCase,listSpecialStockCases} from '../../../src/special-stock-request-repository.js';
import {listSalesStockRequests,listScmStockRequests} from '../../../src/stock-request-repository.js';
import {listStockRequestConversation,sendStockRequestConversation,listStockRequestConversationAlerts,readStockRequestConversation} from '../../../src/stock-request-conversation.js';
import {withBackorderWorkflow} from '../../../src/stock-case-workflow.js';
import {app} from '../../../src/server.js';
let server,base;const sessions={},suffix=randomUUID();
const ctx=audience=>({audience:['other','peer'].includes(audience)?'sales':audience,operatorId:sessions[audience].operator.id,authorizedDestinationLocationIds:audience==='other'?[28]:audience==='scm'?[]:[1]});
async function http(path,role,body) {
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{...(role?{Authorization:'Bearer '+sessions[role].token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,body:await response.text().then(text=>{try{return JSON.parse(text);}catch{return {text};}})};
}
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  await query("INSERT INTO inventory_items(item_id,item_name,display_name,stock_unit,raw,synced_at) VALUES(101,'TEST-CONVERSATION','Stone','PCS','{}',now()) ON CONFLICT DO NOTHING");
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  for(const [name,role,yards] of [['sales','sales',[1]],['other','sales',[28]],['peer','sales',[1]],['scm','scm',[]],['admin','admin',[]],['dispatch','dispatcher',[]]]) {
    const username=`conversation-${name}-${suffix}`,password=randomUUID();
    await createOperator({username,displayName:`TEST ${name}`,password,role,roles:[role],yardLocationIds:yards});
    sessions[name]=(await http('/api/auth/login',null,{username,password})).body;
  }
});
after(async()=>{server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));await closeDb();});
async function request(kind,yard=1) {
  if(['special','backorder'].includes(kind)) {
    const create=()=>createSpecialStockCase({storeLocationId:yard,inquiryDate:'2099-01-01',customerName:'TEST',vendorName:'TEST',fulfillmentMethod:'yard_pickup',lines:[{regularItemId:101,regularItemCode:'STONE',productName:'Stone',quantity:2,uom:'PCS',rate:10,requiredDate:'2099-02-01'}]},
      {operatorId:ctx('sales').operatorId,authorizedStoreLocationIds:[yard]});
    const detail=await (kind==='backorder'?withBackorderWorkflow(create):create());
    return detail.id;
  }
  return Number((await query(`INSERT INTO sales_stock_requests(destination_location_id,destination_name,requested_by,workflow_version,regular_details)
    VALUES(1,'3445',$1,2,$2::jsonb) RETURNING id`,[ctx('sales').operatorId,JSON.stringify({deliveryMethod:kind,stockingType:'transfer',requestingLocationId:1})])).rows[0].id);
}

for(const kind of ['special','backorder','stocking','delivery'])test(`conversation supports ${kind} without changing orders or decisions`,async()=>{
  const id=await request(kind),before=(await query('SELECT status,revision,updated_at,regular_details FROM sales_stock_requests WHERE id=$1',[id])).rows[0];
  const payload={operationId:randomUUID(),message:'Can we use blue instead?'};
  const sent=await sendStockRequestConversation(id,payload,ctx('sales'));
  assert.equal(sent.messages.at(-1).message,payload.message);assert.equal(sent.messages.at(-1).actorName,'TEST sales');
  await sendStockRequestConversation(id,{operationId:randomUUID(),message:'Yes, blue is available.'},ctx('scm'));
  const received=await listStockRequestConversation(id,ctx('sales'));
  assert.deepEqual(received.messages.map(message=>message.message),[payload.message,'Yes, blue is available.']);
  assert.deepEqual((await query('SELECT status,revision,updated_at,regular_details FROM sales_stock_requests WHERE id=$1',[id])).rows[0],before);
  await assert.rejects(listStockRequestConversation(id,ctx('other')),{status:403});
  await assert.rejects(sendStockRequestConversation(id,payload,ctx('other')),{status:403});
});

for(const kind of ['special','backorder'])test(`conversation SCM HTTP access has no Sales yard restriction for ${kind}`,async()=>{
  for(const yard of [1,28,15,26]) {
    const id=await request(kind,yard),path=`/api/scm/stock-requests/${id}/conversation`;
    await sendStockRequestConversation(id,{operationId:randomUUID(),message:'Sales question'}, {...ctx('sales'),authorizedDestinationLocationIds:[yard]});
    for(const role of ['scm','admin']) {
      const read=await http(path,role);assert.equal(read.status,200);assert.equal(read.body.messages[0].message,'Sales question');
      const sent=await http(path,role,{operationId:randomUUID(),message:`Reply from ${role}`});assert.equal(sent.status,200);
      assert.equal((await http(path+'/read',role,{eventId:sent.body.latestEventId})).status,200);
    }
    if(yard!==1)assert.equal((await http(`/api/sales/stock-requests/${id}/conversation`,'sales')).status,403);
  }
});

for(const kind of ['special','backorder','stocking','delivery'])test(`conversation ${kind} queue sorts messages before pagination and keeps retries stable`,async()=>{
  const ids=[await request(kind),await request(kind)],search='CHAT-'+randomUUID();
  await query('UPDATE sales_stock_requests SET request_ref=$2||id::text WHERE id=ANY($1::bigint[])',[ids,search]);
  await query("UPDATE sales_stock_requests SET updated_at=now()+interval '1 day' WHERE id=$1",[ids[1]]);
  const lists=kind==='special' ? ['sales','scm'].map(audience=>options=>listSpecialStockCases({audience,authorizedStoreLocationIds:audience==='sales'?[1]:undefined,search,...options}))
    : [options=>listSalesStockRequests({authorizedDestinationLocationIds:[1],search,...options}),options=>listScmStockRequests({search,allStatuses:true,...options})];
  const first={operationId:randomUUID(),message:'Please review older request'};
  await sendStockRequestConversation(ids[0],first,ctx('sales'));
  for(const list of lists) {
    const rows=await list({limit:1});assert.deepEqual(rows.map(row=>row.id),[ids[0]]);assert.ok(rows[0].conversationEventId>0);
    assert.deepEqual((await list({limit:1,offset:1})).map(row=>row.id),[ids[1]]);
  }
  if(kind==='backorder')assert.deepEqual((await listSalesStockRequests({authorizedDestinationLocationIds:[1],search,status:'new_enquiry',limit:1})).map(row=>row.id),[ids[0]]);
  await sendStockRequestConversation(ids[1],{operationId:randomUUID(),message:'Newer message'},ctx('scm'));
  await sendStockRequestConversation(ids[0],first,ctx('sales'));
  await query("INSERT INTO sales_stock_request_events(request_id,event_type,details) VALUES($1,'automatic_update','{}')",[ids[0]]);
  for(const list of lists)assert.deepEqual((await list({limit:1})).map(row=>row.id),[ids[1]]);
});
test('conversation concurrent retries append once and reject changed content',async()=>{
  const id=await request('stocking'),payload={operationId:randomUUID(),message:'One message'};
  const results=await Promise.all(Array.from({length:5},()=>sendStockRequestConversation(id,payload,ctx('scm'))));
  assert.ok(results.every(result=>result.messages.length===1));
  await assert.rejects(sendStockRequestConversation(id,{...payload,message:'Changed'},ctx('scm')),{status:409});
  await Promise.all(['First','Second'].map(message=>sendStockRequestConversation(id,{operationId:randomUUID(),message},ctx('sales'))));
  assert.equal((await listStockRequestConversation(id,ctx('sales'))).messages.length,3);
});
test('conversation preserves legacy messages, omits automatic and private events, and releases pending information',async()=>{
  const id=await request('special'),detail=await getSpecialStockCase(id);
  await requestSpecialStockInformation(id,{expectedRevision:detail.revision,question:'Which color?'},{operatorId:ctx('scm').operatorId});
  await query("INSERT INTO sales_special_stock_events(request_id,event_type,audience,details) VALUES($1,'special_supply_cost_recorded','scm','{\"message\":\"Private costs\"}'),($1,'special_stock_checked','all','{\"message\":\"Automatic stock result\"}')",[id]);
  const reply=await sendStockRequestConversation(id,{operationId:randomUUID(),message:'Blue.'},ctx('sales'));
  assert.deepEqual(reply.messages.map(message=>message.message),['Which color?','Blue.']);
  assert.equal(reply.workflowUpdated,true);
  assert.equal((await getSpecialStockCase(id)).informationRequest.status,'answered');
  assert.equal((await listStockRequestConversation(id,ctx('scm'))).messages.length,2);
});
test('conversation history survives many automatic events and closed requests become read-only',async()=>{
  const id=await request('delivery');await sendStockRequestConversation(id,{operationId:randomUUID(),message:'Keep this message'},ctx('sales'));
  await query("INSERT INTO sales_stock_request_events(request_id,event_type,details) SELECT $1,'automatic_update','{\"message\":\"Automatic\"}' FROM generate_series(1,250)",[id]);
  await query("UPDATE sales_stock_requests SET status='cancelled' WHERE id=$1",[id]);
  const result=await listStockRequestConversation(id,ctx('sales'));assert.equal(result.canSend,false);assert.deepEqual(result.messages.map(message=>message.message),['Keep this message']);
  await assert.rejects(sendStockRequestConversation(id,{operationId:randomUUID(),message:'Too late'},ctx('sales')),{status:409});
});
test('conversation HTTP routes enforce authentication, role, yard and feature flag',async()=>{
  const id=await request('special'),path=`/api/sales/stock-requests/${id}/conversation`,body={operationId:randomUUID(),message:'HTTP message',audience:'scm',actorId:'forged'};
  assert.equal((await http(path,null)).status,401);assert.equal((await http(path,'dispatch',body)).status,403);
  assert.equal((await http(path,'other')).status,403);assert.equal((await http(path,'other',body)).status,403);
  assert.equal((await http(`/api/scm/stock-requests/${id}/conversation`,'sales',body)).status,403);
  assert.equal((await http(path,'sales',{...body,message:''})).status,400);
  const sent=await http(path,'sales',body);assert.equal(sent.status,200);assert.equal(sent.body.messages[0].audience,'sales');assert.equal(sent.body.messages[0].actorName,'TEST sales');
  await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='special_stock_request_workflow'");
  try{assert.equal((await http(path,'sales')).status,404);assert.equal((await http(path,'sales',{...body,operationId:randomUUID()})).status,404);}
  finally{await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");}
});

test('conversation notifications are scoped, receiver-only, per-user and acknowledge only seen messages',async()=>{
  const id=await request('stocking');
  await sendStockRequestConversation(id,{operationId:randomUUID(),message:'First notification'},ctx('scm'));
  const alerts=await listStockRequestConversationAlerts(ctx('sales'));
  const alert=alerts.requests.find(row=>row.id===id);assert.equal(alert.unreadCount,1);assert.equal(alert.message,'First notification');
  assert.equal((await listStockRequestConversationAlerts(ctx('other'))).requests.some(row=>row.id===id),false);
  assert.equal((await listStockRequestConversationAlerts(ctx('scm'))).requests.some(row=>row.id===id),false);
  await assert.rejects(readStockRequestConversation(id,{eventId:alert.latestEventId},ctx('other')),{status:403});
  await assert.rejects(readStockRequestConversation(id,{eventId:alert.latestEventId+999999},ctx('sales')),{status:400});
  await sendStockRequestConversation(id,{operationId:randomUUID(),message:'Second notification'},ctx('scm'));
  await readStockRequestConversation(id,{eventId:alert.latestEventId},ctx('sales'));
  const next=(await listStockRequestConversationAlerts(ctx('sales'))).requests.find(row=>row.id===id);assert.equal(next.unreadCount,1);assert.equal(next.message,'Second notification');
  await readStockRequestConversation(id,{eventId:next.latestEventId},ctx('sales'));
  await readStockRequestConversation(id,{eventId:alert.latestEventId},ctx('sales'));
  assert.equal((await listStockRequestConversationAlerts(ctx('sales'))).requests.some(row=>row.id===id),false);
  assert.equal((await listStockRequestConversationAlerts(ctx('peer'))).requests.find(row=>row.id===id).unreadCount,2);
  await sendStockRequestConversation(id,{operationId:randomUUID(),message:'Sales response'},ctx('sales'));
  assert.equal((await listStockRequestConversationAlerts(ctx('scm'))).requests.find(row=>row.id===id).unreadCount,1);
  assert.equal((await http('/api/sales/stock-request-conversation-alerts','sales')).status,200);
  assert.equal((await http(`/api/scm/stock-requests/${id}/conversation/read`,'sales',{eventId:next.latestEventId})).status,403);
});
test('conversation releases legacy Stocking reply markers without changing approval decisions',async()=>{
  const id=await request('stocking');
  await query(`UPDATE sales_stock_requests SET regular_details=regular_details||'{"replyStatus":"pending_update","stockingLines":{"99":{"replyStatus":"pending_update","decision":"kept"}}}'::jsonb WHERE id=$1`,[id]);
  const result=await sendStockRequestConversation(id,{operationId:randomUUID(),message:'Confirmed the specifications'},ctx('sales'));
  assert.equal(result.workflowUpdated,true);
  const row=(await query('SELECT regular_details FROM sales_stock_requests WHERE id=$1',[id])).rows[0];
  assert.equal(row.regular_details.stockingLines['99'].replyStatus,'pending_scm');assert.equal(row.regular_details.stockingLines['99'].decision,'kept');
});
