import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {TextDecoder} from 'node:util';
import {app} from '../../../src/server.js';
import {createOperator} from '../../../src/auth-repository.js';
import {query,closeDb} from '../../../src/db.js';
import {createDeliveryRequestService} from '../../../src/delivery-request-repository.js';
import {pricing,window} from '../support/delivery-request-fixtures.js';
import {seedDeliveryRates} from '../support/delivery-request-database.js';
let server,base,service;
const users={};
async function api(path,name='sales',method='GET',body) {
  const response=await fetch(`${base}${path}`,{method,headers:{...(name?{Authorization:`Bearer ${users[name].token}`} : {}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,headers:response.headers,data:await response.json()};
}
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  await seedDeliveryRates();
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  for(const [name,role,yards] of [['sales','sales',[1]],['colleague','sales',[1]],['other','sales',[28]],['dispatch','dispatcher',[]]]) {
    const username=`delivery-http-${name}-${crypto.randomUUID()}`;
    const actor=await createOperator({username,displayName:name,password:'delivery-http-test',role,yardLocationIds:yards});
    const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password:'delivery-http-test'})});
    assert.equal(login.status,200);users[name]={actor,...await login.json()};
  }
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,trandate,customer,status,status_text,order_location_id,sales_order_type,netsuite_active,synced_at)
    VALUES(98700099,'SOHTTP123',current_date,'HTTP Delivery','Pending Fulfillment','Pending Fulfillment',1,'Delivery',true,now()),
    (98700098,'SOHTTP124',current_date,'HTTP Delivery','Pending Fulfillment','Pending Fulfillment',1,'Delivery',true,now())`);
  service=createDeliveryRequestService({resolveDistance:async()=>({providerMetres:20000,routeHash:'http-fixture',originSnapshot:{},destinationSnapshot:{},routeSnapshot:{provider:'test'}})});
});
after(async()=>{server?.closeAllConnections();if(server) {await new Promise(resolve=>server.close(resolve));}await closeDb();});
async function submit() {
  const quote=await service.quote(pricing(),users.sales.actor);
  const body={...pricing(),requestedWindow:window(),quoteId:quote.id,operationId:crypto.randomUUID(),totalAmountMinor:1};
  const result=await api('/api/sales/delivery-requests','sales','POST',body);
  assert.equal(result.status,201,JSON.stringify(result.data));return {row:result.data,body};
}
test('time change: HTTP proposal, withdrawal, decline, acceptance and cancellation enforce roles and revisions',async()=>{
  const {row}=await submit();
  const action=async(current,name,audience='sales',extra={})=>api(`/api/${audience}/delivery-requests/${row.id}/actions/${name}`,audience,'POST',
    {expectedRevision:current.revision,operationId:crypto.randomUUID(),...extra});
  let result=await action(row,'confirm','dispatch');assert.equal(result.status,200);let current=result.data;
  result=await action(current,'secure','sales',{salesOrderRefs:['SOHTTP123']});assert.equal(result.status,200);current=result.data;
  const approved=current.confirmedWindow,quote=current.quote;
  assert.equal((await action(current,'request-time-change','dispatch',{window:window()})).status,403);
  assert.equal((await api(`/api/sales/delivery-requests/${row.id}/actions/request-time-change`,'other','POST',
    {expectedRevision:current.revision,operationId:crypto.randomUUID(),window:window()})).status,403);
  assert.equal((await action(current,'request-time-change','sales',{window:window({end:'10:59'})})).status,400);
  for(const decision of ['withdraw-time-change','decline-time-change','accept-time-change']) {
    result=await action(current,'request-time-change','sales',{window:window({date:'2028-10-12',start:'13:00',end:'15:00'})});
    assert.equal(result.status,200,JSON.stringify(result.data));current=result.data;
    assert.deepEqual(current.confirmedWindow,approved);assert.equal(current.status,'confirmed');
    assert.equal((await action(current,'accept-time-change','sales')).status,403);
    const audience=decision==='withdraw-time-change'?'sales':'dispatch';
    result=await action(current,decision,audience);assert.equal(result.status,200,JSON.stringify(result.data));current=result.data;
    assert.equal(current.pendingWindow,null);assert.deepEqual(current.quote,quote);assert.deepEqual(current.salesOrderRefs,['SOHTTP123']);
  }
  assert.equal(current.confirmedWindow.start,'13:00');assert.equal(current.confirmedWindow.end,'15:00');
  assert.equal((await action(current,'accept-time-change','dispatch')).status,409);
  const cancelled=await action(current,'cancel','dispatch');assert.equal(cancelled.status,200);
  assert.deepEqual(cancelled.data.salesOrderRefs,[]);
  assert.equal((await query('SELECT * FROM delivery_request_sales_orders WHERE request_id=$1',[row.id])).rowCount,0);
});
test('linkage: real HTTP exchange enforces audience and revision and retains legacy approved times',async()=>{
  const {row}=await submit();
  const path=`/api/sales/delivery-requests/${row.id}/actions/relink`;
  const approved=await service.act(row.id,'confirm',{expectedRevision:row.revision,operationId:crypto.randomUUID()},users.dispatch.actor,'dispatch');
  let secured=await service.act(row.id,'secure',{expectedRevision:approved.revision,operationId:crypto.randomUUID(),salesOrderRefs:['SOHTTP123']},users.sales.actor,'sales');
  const legacy={date:'2028-10-10',start:'08:00',end:'09:00',timeZone:'America/Toronto'};
  await query("UPDATE delivery_requests SET data=jsonb_set(data,'{confirmedWindow}',$2) WHERE id=$1",[row.id,JSON.stringify(legacy)]);
  const input={expectedRevision:secured.revision,operationId:crypto.randomUUID(),salesOrderRefs:['SOHTTP124']};
  assert.equal((await api(path,'other','POST',input)).status,403);
  assert.equal((await api(path.replace('/sales/','/dispatch/'),'dispatch','POST',input)).status,403);
  const result=await api(path,'sales','POST',input);assert.equal(result.status,200,JSON.stringify(result.data));secured=result.data;
  assert.deepEqual(secured.salesOrderRefs,['SOHTTP124']);assert.deepEqual(secured.confirmedWindow,legacy);
  assert.equal((await api(path,'sales','POST',input)).data.revision,secured.revision);
  assert.equal((await api(path,'sales','POST',{...input,operationId:crypto.randomUUID()})).data.code,'DELIVERY_STALE_REVISION');
});
test('real HTTP routes require private Sales/Dispatch roles and requesting-yard access',async()=>{
  assert.equal((await api('/api/sales/delivery-requests/meta','')).status,401);
  assert.equal((await api('/api/dispatch/delivery-requests','sales')).status,403);
  assert.equal((await api('/api/sales/delivery-requests','dispatch')).status,403);
  const {row}=await submit();
  assert.equal((await api(`/api/sales/delivery-requests/${row.id}`,'colleague')).status,200);
  assert.equal((await api(`/api/sales/delivery-requests/${row.id}`,'other')).status,403);
  assert.equal((await api(`/api/dispatch/delivery-requests/${row.id}`,'dispatch')).status,200);
});
test('HTTP submission ignores client prices, requires quote evidence, and is idempotent',async()=>{
  const {row,body}=await submit();assert.ok(row.quote.totalAmountMinor>1);
  const replay=await api('/api/sales/delivery-requests','sales','POST',body);
  assert.equal(replay.data.id,row.id);assert.equal(replay.data.revision,row.revision);
  assert.equal((await api('/api/sales/delivery-requests','sales','POST',{...body,totalUnits:2})).status,409);
  assert.equal((await api('/api/sales/delivery-requests','sales','POST',{...pricing(),requestedWindow:window(),operationId:crypto.randomUUID()})).data.code,'DELIVERY_QUOTE_REQUIRED');
  assert.match(replay.headers.get('cache-control'),/no-store/);
});
test('Dispatch HTTP preapproval then Sales SO entry secures delivery and exposes same-page instructions',async()=>{
  const {row}=await submit();
  const approved=await api(`/api/dispatch/delivery-requests/${row.id}/actions/confirm`,'dispatch','POST',{expectedRevision:row.revision,operationId:crypto.randomUUID()});
  assert.equal(approved.status,200);assert.equal(approved.data.status,'preapproved');
  assert.ok(approved.data.approvalExpiresAt);
  const secured=await api(`/api/sales/delivery-requests/${row.id}/actions/secure`,'colleague','POST',{expectedRevision:approved.data.revision,operationId:crypto.randomUUID(),salesOrderRefs:['SOHTTP123']});
  assert.equal(secured.status,200,JSON.stringify(secured.data));assert.equal(secured.data.status,'confirmed');assert.equal(secured.data.approvalExpiresAt,null);
  const detail=await api('/api/sales/delivery-instructions/orders/SOHTTP123');
  const saved=await api('/api/sales/delivery-instructions/orders/SOHTTP123','sales','PUT',{expectedRevision:detail.data.revision,additionalText:'Use the back entrance.'});
  assert.equal(saved.status,200);assert.equal(saved.data.additionalText,'Use the back entrance.');
  const changed=await api(`/api/dispatch/delivery-requests/${row.id}`,'dispatch');
  assert.equal(changed.data.revision,secured.data.revision+1);assert.equal(changed.data.history[0].action,'instructions');
});
test('late HTTP SO entry commits expiry and revision-bounded reads retain newer updates',async()=>{
  const {row}=await submit();
  const approved=await api(`/api/dispatch/delivery-requests/${row.id}/actions/confirm`,'dispatch','POST',{expectedRevision:row.revision,operationId:crypto.randomUUID()});
  await query('UPDATE delivery_requests SET approval_expires_at=now()-interval \'1 second\' WHERE id=$1',[row.id]);
  const expired=await api(`/api/sales/delivery-requests/${row.id}/actions/secure`,'sales','POST',{expectedRevision:approved.data.revision,operationId:crypto.randomUUID(),salesOrderRefs:['SOHTTP123']});
  assert.equal(expired.status,409);assert.equal(expired.data.code,'DELIVERY_APPROVAL_EXPIRED');
  assert.equal((await api(`/api/sales/delivery-requests/${row.id}`)).data.status,'expired');
  await api(`/api/sales/delivery-requests/${row.id}/read`,'sales','POST',{revision:approved.data.revision});
  const unread=await api('/api/sales/delivery-requests/alerts');
  assert.ok(unread.data.requests.some(item=>item.id===row.id && item.revision>approved.data.revision));
});
test('UI: HTTP multiple statuses return their union with search and yard access preserved',async()=>{
  const submitted=await submit(),preapproved=await submit(),cancelled=await submit();
  await api(`/api/dispatch/delivery-requests/${preapproved.row.id}/actions/confirm`,'dispatch','POST',{expectedRevision:1,operationId:crypto.randomUUID()});
  await api(`/api/sales/delivery-requests/${cancelled.row.id}/actions/cancel`,'sales','POST',{expectedRevision:1,operationId:crypto.randomUUID()});
  const marker=`Pelican-${crypto.randomUUID()}`;
  await query('UPDATE delivery_requests SET data=jsonb_set(data,\'{customerName}\',to_jsonb($1::text)) WHERE id=ANY($2::bigint[])',[marker,[submitted.row.id,preapproved.row.id,cancelled.row.id]]);
  for(const audience of ['sales','dispatch']) {
    const name=audience==='sales'?'sales':'dispatch';
    const result=await api(`/api/${audience}/delivery-requests?status=submitted&status=preapproved&search=${marker}`,name);
    assert.equal(result.status,200,JSON.stringify(result.data));
    assert.deepEqual(result.data.requests.map(item=>item.id).sort((a,b)=>a-b),[submitted.row.id,preapproved.row.id].sort((a,b)=>a-b));
    assert.ok(result.data.requests.every(item=>['submitted','preapproved'].includes(item.status)));
  }
  const hidden=await api(`/api/sales/delivery-requests?status=submitted&status=preapproved&search=${marker}`,'other');
  assert.equal(hidden.status,200);assert.deepEqual(hidden.data.requests,[]);
});
test('UI: HTTP legacy status, repeated duplicates and clearing status retain filter semantics',async()=>{
  const {row}=await submit();
  const search=encodeURIComponent(row.requestRef);
  for(const suffix of ['status=submitted','status=submitted&status=submitted','status=&status=submitted','status=','']) {
    const result=await api(`/api/sales/delivery-requests?search=${search}&${suffix}`);
    assert.equal(result.status,200,JSON.stringify(result.data));assert.deepEqual(result.data.requests.map(item=>item.id),[row.id]);
  }
  const excluded=await api(`/api/sales/delivery-requests?search=${search}&status=cancelled`);
  assert.deepEqual(excluded.data.requests,[]);
});
test('UI: HTTP hostile multi-status values cannot widen access or inject SQL',async()=>{
  const {row}=await submit(),search=encodeURIComponent(row.requestRef);
  const injection=encodeURIComponent("x') OR true --");
  const invalid=await api(`/api/sales/delivery-requests?status=${injection}&status=unknown&search=${search}`);
  assert.equal(invalid.status,200,JSON.stringify(invalid.data));assert.deepEqual(invalid.data.requests,[]);
  const tooLong=await api(`/api/sales/delivery-requests?status=submitted&status=${'x'.repeat(31)}`);
  assert.equal(tooLong.status,400);assert.equal(tooLong.data.code,'DELIVERY_REQUEST_INVALID');
  const object=await api('/api/sales/delivery-requests?status[bad]=submitted');
  assert.equal(object.status,400);assert.equal(object.data.code,'DELIVERY_REQUEST_INVALID');
});
test('UI: HTTP proposed times and preapproval retain unread revisions until Sales reviews them',async()=>{
  const {row}=await submit();
  const proposed=await api(`/api/dispatch/delivery-requests/${row.id}/actions/propose`,'dispatch','POST',{expectedRevision:row.revision,operationId:crypto.randomUUID(),window:window({start:'13:00',end:'15:00'})});
  assert.equal(proposed.status,200,JSON.stringify(proposed.data));
  let unread=await api('/api/sales/delivery-requests/alerts');
  assert.ok(unread.data.requests.some(item=>item.id===row.id && item.action==='propose' && item.revision===proposed.data.revision));
  await api(`/api/sales/delivery-requests/${row.id}/read`,'sales','POST',{revision:proposed.data.revision});
  const approved=await api(`/api/dispatch/delivery-requests/${row.id}/actions/confirm`,'dispatch','POST',{expectedRevision:proposed.data.revision,operationId:crypto.randomUUID()});
  assert.equal(approved.status,200,JSON.stringify(approved.data));
  unread=await api('/api/sales/delivery-requests/alerts');
  assert.ok(unread.data.requests.some(item=>item.id===row.id && item.action==='confirm' && item.revision===approved.data.revision));
  await api(`/api/sales/delivery-requests/${row.id}/read`,'sales','POST',{revision:approved.data.revision});
  unread=await api('/api/sales/delivery-requests/alerts');
  assert.ok(!unread.data.requests.some(item=>item.id===row.id));
});

test('updates: HTTP rejects short slots for requests, edits, proposals and counters without consuming the quote',async()=>{
  const quoted=await service.quote(pricing(),users.sales.actor);
  const body={...pricing(),requestedWindow:window({end:'10:59'}),quoteId:quoted.id,operationId:crypto.randomUUID()};
  const invalid=await api('/api/sales/delivery-requests','sales','POST',body);
  assert.equal(invalid.status,400);assert.match(invalid.data.error,/at least 2 hours/);
  const created=await api('/api/sales/delivery-requests','sales','POST',{...body,requestedWindow:window({end:'11:00'})});
  assert.equal(created.status,201,JSON.stringify(created.data));
  let row=created.data;
  const editedQuote=await service.quote(pricing(),users.sales.actor);
  const edit={...pricing(),expectedRevision:row.revision,requestedWindow:window({end:'10:59'}),quoteId:editedQuote.id,operationId:crypto.randomUUID()};
  const invalidEdit=await api(`/api/sales/delivery-requests/${row.id}/actions/edit`,'sales','POST',edit);
  assert.equal(invalidEdit.status,400);
  const edited=await api(`/api/sales/delivery-requests/${row.id}/actions/edit`,'sales','POST',{...edit,requestedWindow:window({end:'11:00'})});
  assert.equal(edited.status,200,JSON.stringify(edited.data));row=edited.data;
  for(const [audience,actor,action] of [['dispatch','dispatch','propose'],['sales','sales','counter']]) {
    const path=`/api/${audience}/delivery-requests/${row.id}/actions/${action}`;
    const command={expectedRevision:row.revision,operationId:crypto.randomUUID(),window:window({end:'10:59'})};
    const bad=await api(path,actor,'POST',command);assert.equal(bad.status,400);assert.match(bad.data.error,/at least 2 hours/);
    const good=await api(path,actor,'POST',{...command,window:window({end:'11:00'})});
    assert.equal(good.status,200,JSON.stringify(good.data));row=good.data;
  }
});
test('updates: a Sales submission emits a live event and remains unread for Dispatch',async()=>{
  const abort=new AbortController(),timeout=setTimeout(()=>abort.abort(),10000);
  let reader;
  try {
    const events=await fetch(`${base}/api/events?client=delivery-regression`,{signal:abort.signal});
    assert.equal(events.status,200);reader=events.body.getReader();
    const {row}=await submit();let received='';
    while(!received.includes('delivery.requests.updated')) {
      const chunk=await reader.read();assert.equal(chunk.done,false);received+=new TextDecoder().decode(chunk.value);
    }
    const unread=await api('/api/dispatch/delivery-requests/alerts','dispatch');
    assert.equal(unread.status,200);
    assert.equal(unread.data.requests.find(item=>item.id===row.id)?.action,'submit');
    const afterRead=await api(`/api/dispatch/delivery-requests/${row.id}/read`,'dispatch','POST',{revision:row.revision});
    assert.equal(afterRead.status,200);
    assert.equal((await api('/api/dispatch/delivery-requests/alerts','dispatch')).data.requests.some(item=>item.id===row.id),false);
  } finally {clearTimeout(timeout);await reader?.cancel();abort.abort();}
});
