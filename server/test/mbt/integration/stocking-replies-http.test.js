import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {app} from '../../../src/server.js';
import {query,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import {submitRegularStockRequest} from '../../../src/regular-stock-request-service.js';
import {getSalesStockRequest,getScmStockRequest} from '../../../src/stock-request-repository.js';
import {addPurchaseStockProposals} from '../../../src/regular-stock-purchase-service.js';
import {createSpecialOrderDocumentService} from '../../../src/special-stock-documents.js';

const run=randomUUID(),actors={},tokens={},nativeFetch=globalThis.fetch,password=run+'-Reply-A1!',itemId=9800000000191,poId=itemId;
const dependencies={refreshAvailability:async()=>{},loadPolicies:async()=>[],loadPurchaseStock:async()=>({available:1000,onHand:1000}),
  loadPurchasePolicy:async()=>({item_id:itemId,item_name:'Reply material',stock_unit:'EA',to_plt:100,pallet_weight_lbs:1000,vendor_id:910191,vendor:'Reply vendor',vendor_yard_id:910191,vendor_yard:'Reply source',plant:'Reply source'})};
let server,base,outbound=0;
async function http(path,role,body,method=body===undefined?'GET':'POST'){
  const response=await nativeFetch(base+path,{method,headers:{...(role?{Authorization:`Bearer ${tokens[role]}`} : {}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data={error:text};}
  return {status:response.status,body:data};
}
const request=(type='transfer',destination=26)=>submitRegularStockRequest({deliveryMethod:'stocking',stockingType:type,destinationLocationId:destination,
  requestingLocationId:15,lines:[{itemId,...(type==='transfer'?{sourceLocationId:destination===1?28:1}:{}),pieces:20}]},
  {operatorId:actors.sales.id,authorizedDestinationLocationIds:[26],allowOverAvailability:true},dependencies);
const send=(r,role='scm',extra={})=>http(`/api/${role==='sales'||role==='peer'||role==='other'?'sales':'scm'}/stock-requests/${r.id}/reply`,role,{lineId:r.lines[0].id,message:'Use the next load.',expectedRevision:r.revision,...extra});
const snapshot=async id=>(await query('SELECT r.*, (SELECT jsonb_agg(e ORDER BY e.id) FROM sales_stock_request_events e WHERE e.request_id=r.id) AS events FROM sales_stock_requests r WHERE r.id=$1',[id])).rows[0];
before(async()=>{
  const db=new URL(process.env.DATABASE_URL);assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(db.hostname,'db');assert.match(db.pathname,/^\/mbt_test(?:_file_[a-f0-9]{12}_[a-z0-9]+)?$/);
  await query("INSERT INTO dispatch_vendor_yards(id,vendor,yard) VALUES(910191,'Reply vendor','Reply source') ON CONFLICT DO NOTHING");
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt,item_weight,vendor_id,vendor) VALUES($1,'Reply material','EA',1,100,10,910191,'Reply vendor') ON CONFLICT DO NOTHING",[itemId]);
  for(const yard of [1,28,15,26])await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,$2,$3,1000,1000,now()) ON CONFLICT DO NOTHING",[itemId,yard,String(yard)]);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,netsuite_active) VALUES($1,$2,true) ON CONFLICT DO NOTHING",[poId,'REPLY-PO-'+run]);
  server=app.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));base=`http://127.0.0.1:${server.address().port}`;
  for(const [key,role,yards] of [['sales','sales',[26]],['peer','sales',[26]],['destination','sales',[1]],['other','sales',[15]],['scm','scm',[]],['driver','dispatcher',[]],['yard','yard_manager',[]]]){
    const username=`reply-${key}-${run}`;await createOperator({username,displayName:username,password,role,roles:[role],yardLocationIds:yards});
    actors[key]=(await query('SELECT id FROM operators WHERE username=$1',[username])).rows[0];const login=await http('/api/auth/login',null,{username,password});assert.equal(login.status,200);tokens[key]=login.body.token;
  }
  globalThis.fetch=async()=>{outbound++;throw new Error('Reply must not call external services');};
});
after(async()=>{globalThis.fetch=nativeFetch;if(server)await new Promise(done=>server.close(done));await closeDb();});

test('150 Sales can request other yards, retain origin visibility and alerts, and cannot spoof origin',async()=>{
  for(const type of ['transfer','purchase']){
    const r=await request(type,1);assert.equal(r.destinationLocationId,1);assert.equal(r.regular.requestingLocationId,26);
    assert.equal((await http(`/api/sales/stock-requests/${r.id}`,'sales')).status,200);
    assert.equal((await http(`/api/sales/stock-requests/${r.id}`,'destination')).status,200);
    assert.equal((await http(`/api/sales/stock-requests/${r.id}`,'other')).status,403);
    assert.ok((await http('/api/sales/stock-requests?bucket=pending','sales')).body.requests.some(row=>row.id===r.id));
    const reply=await send(r);assert.equal(reply.status,200);
    assert.ok((await http('/api/sales/stock-requests/alerts','sales')).body.requests.some(row=>row.id===r.id));
    assert.ok(!(await http('/api/sales/stock-requests/alerts','peer')).body.requests.some(row=>row.id===r.id));
  }
});
test('SCM instructions with no ETA set Pending update, preserve quantities and append audited history',async()=>{
  const r=await request();const lines=JSON.parse(JSON.stringify(r.lines));const reply=await send(r,'scm',{message:'Call Sales first.\nUse the next load.'});assert.equal(reply.status,200);
  assert.equal(reply.body.displayStatus,'pending_update');assert.equal(reply.body.status,'submitted');assert.equal(reply.body.revision,r.revision+1);
  assert.deepEqual(reply.body.lines,lines.map(line=>({...line,reply:reply.body.regular.reply,replyStatus:'pending_update'})));assert.equal(reply.body.transfers.length,0);assert.equal(reply.body.regular.reply.eta,null);
  assert.equal(reply.body.lines[0].reply.lineId,r.lines[0].id);
  const event=reply.body.events.find(e=>e.eventType==='regular_scm_reply');assert.equal(event.actorId,actors.scm.id);assert.equal(event.details.message,'Call Sales first.\nUse the next load.');
  assert.equal(reply.body.manualDecisionEventId,event.id);assert.equal(outbound,0);
});
test('Sales can reply to instructions, optionally reference an SO, and return the conversation to SCM',async()=>{
  const r=await request();assert.equal((await send(r,'sales')).status,409);
  const instruction=(await send(r,'scm',{eta:'2026-10-15'})).body;
  for(const role of ['peer','other'])assert.equal((await send(instruction,role)).status,403);
  const response=await send(instruction,'sales',{message:'Customer confirmed.',salesOrderRef:' SO-123 '});assert.equal(response.status,200);
  assert.equal(response.body.displayStatus,'pending_scm');assert.equal(response.body.regular.reply.salesOrderRef,'SO-123');assert.equal(response.body.regular.salesOrderRef,undefined);
  assert.equal(response.body.events.filter(e=>['regular_scm_reply','regular_sales_reply'].includes(e.eventType)).length,2);
  assert.deepEqual(response.body.lines,JSON.parse(JSON.stringify(r.lines)).map(line=>({...line,reply:response.body.regular.reply,replyStatus:'pending_scm'})));assert.equal(response.body.transfers.length,0);assert.equal(outbound,0);
  assert.equal(response.body.lines[0].reply.lineId,r.lines[0].id);
  const again=(await send(response.body,'scm')).body;const blank=await send(again,'sales');assert.equal(blank.status,200);assert.equal(blank.body.regular.reply.salesOrderRef,null);
});
test('reply authorization and invalid inputs cause no writes',async()=>{
  const r=await request(),old=await snapshot(r.id);assert.equal((await send(r,null)).status,401);
  for(const role of ['driver','yard'])assert.equal((await send(r,role)).status,403);
  for(const change of [{message:''},{message:'x'.repeat(2001)},{eta:'2026-02-30'},{expectedRevision:null},{expectedRevision:1.5}])assert.equal((await send(r,'scm',change)).status,400);
  assert.equal((await send(r,'scm',{expectedRevision:r.revision+1})).status,409);assert.deepEqual(await snapshot(r.id),old);
});
test('reply API rejects invalid IDs, missing cases and Special requests without changing their records',async()=>{
  const body={message:'Instructions',expectedRevision:1};
  assert.equal((await http('/api/scm/stock-requests/not-an-id/reply','scm',body)).status,400);
  assert.equal((await http('/api/scm/stock-requests/99999999999/reply','scm',body)).status,404);
  const r=await request();const before=await snapshot(r.id);
  assert.equal((await http(`/api/scm/stock-requests/${r.id}/reply`,'sales',body)).status,403);assert.deepEqual(await snapshot(r.id),before);
  await query("UPDATE sales_stock_requests SET request_type='special' WHERE id=$1",[r.id]);const special=await snapshot(r.id);
  assert.equal((await send(r)).status,404);assert.deepEqual(await snapshot(r.id),special);
});
test('Purchase availability refresh rejects unsupported Stocking destinations before inventory synchronisation',async()=>{
  const refresh=await http(`/api/sales/stock-request-items/${itemId}/availability/refresh`,'sales',{stockingType:'purchase',destinationLocationId:999});
  assert.equal(refresh.status,400);assert.equal(refresh.body.code,'STOCK_REQUEST_INVALID');assert.equal(outbound,0);
});
test('replying on an open Stocking TO requests a Sales update without editing or reissuing the TO',async()=>{
  const r=await request();
  await query("UPDATE sales_stock_requests SET status='active',regular_details=regular_details||'{\"pickupTransfer\":{\"status\":\"complete\"}}'::jsonb WHERE id=$1",[r.id]);
  await query("UPDATE sales_stock_request_lines SET status='converted' WHERE request_id=$1",[r.id]);
  await query("INSERT INTO sales_stock_transfers(request_id,source_location_id,source_name,destination_location_id,destination_name,created_by,status,netsuite_transfer_order_id,netsuite_transfer_order_ref) VALUES($1,1,'3445',26,'150',$2,'pending_receipt',9800000000291,'TO-REPLY-FIXTURE')",[r.id,actors.scm.id]);
  const before=(await query('SELECT * FROM sales_stock_transfers WHERE request_id=$1',[r.id])).rows;
  const result=await send(r);assert.equal(result.status,200);assert.equal(result.body.displayStatus,'pending_update');
  assert.equal(result.body.lines[0].status,'converted');assert.deepEqual((await query('SELECT * FROM sales_stock_transfers WHERE request_id=$1',[r.id])).rows,before);assert.equal(outbound,0);
});
test('concurrent replies with the same revision have one winner and one durable event',async()=>{
  const r=await request();const replies=await Promise.all(Array.from({length:5},(_,i)=>send(r,'scm',{message:`Instructions ${i}`})));
  assert.equal(replies.filter(x=>x.status===200).length,1);assert.equal(replies.filter(x=>x.status===409).length,4);
  const row=await snapshot(r.id);assert.equal(row.revision,r.revision+1);assert.equal(row.events.filter(e=>e.event_type==='regular_scm_reply').length,1);
});
test('a failed transaction leaves neither a message nor an alert',async()=>{
  const r=await request(),old=await snapshot(r.id),name='reply_fail_'+run.replaceAll('-','').slice(0,8);
  await query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected reply save failure'; END $$`);
  await query(`CREATE TRIGGER ${name} AFTER UPDATE ON sales_stock_requests FOR EACH ROW WHEN (NEW.id=${r.id}) EXECUTE FUNCTION ${name}()`);
  try{assert.equal((await send(r)).status,500);assert.deepEqual(await snapshot(r.id),old);}finally{await query(`DROP TRIGGER ${name} ON sales_stock_requests`);await query(`DROP FUNCTION ${name}()`);}
});
test('Resolve produces a new unread Sales alert after a previously read SCM reply',async()=>{
  const r=await request(),instruction=(await send(r)).body;
  assert.equal((await http(`/api/sales/stock-requests/${r.id}/decisions/read`,'sales',{eventId:instruction.manualDecisionEventId})).status,200);
  assert.ok(!(await http('/api/sales/stock-requests/alerts','sales')).body.requests.some(row=>row.id===r.id));
  const resolved=await http(`/api/scm/stock-requests/${r.id}/resolve`,'scm',{expectedRevision:instruction.revision,purchaseOrderRef:'REPLY-PO-'+run,eta:'2026-11-01'});assert.equal(resolved.status,200);
  assert.equal(resolved.body.displayStatus,'resolved');assert.equal((await send(resolved.body)).status,409);
  const alert=(await http('/api/sales/stock-requests/alerts','sales')).body.requests.find(row=>row.id===r.id);assert.equal(alert.eventId,resolved.body.manualDecisionEventId);assert.equal(alert.action,'resolve');
});
test('adding to PO/TO proposals supersedes Pending update and labels partial versus fully proposed',async()=>{
  const r=await request('purchase');const instruction=(await send(r)).body;
  const added=await addPurchaseStockProposals(r.id,{expectedRevision:instruction.revision,lines:[{lineId:r.lines[0].id,reviewedSalesQty:20}]},{operatorId:actors.scm.id},dependencies);
  assert.equal(added.displayStatus,'proposed');assert.equal(added.regular.replyStatus,null);assert.equal(added.lines[0].purchase.approvedQuantity,100);
  assert.ok((await getSalesStockRequest(r.id,{authorizedDestinationLocationIds:[26]})).displayStatus==='proposed');
  const partial=await submitRegularStockRequest({deliveryMethod:'stocking',stockingType:'purchase',destinationLocationId:1,lines:[{itemId,pieces:20},{itemId,pieces:30}]},
    {operatorId:actors.sales.id,authorizedDestinationLocationIds:[26]},dependencies);
  const instruction2=(await send(partial)).body;
  const added2=await addPurchaseStockProposals(partial.id,{expectedRevision:instruction2.revision,lines:[{lineId:partial.lines[0].id,reviewedSalesQty:20}]},{operatorId:actors.scm.id},dependencies);
  assert.equal(added2.displayStatus,'partially_proposed');assert.equal(added2.lines[1].status,'submitted');
  const beforeCount=(await http('/api/scm/stock-requests/alerts','scm')).body.manualReview;
  const salesReply=await send(added,'sales');assert.equal(salesReply.status,200);
  assert.equal((await http('/api/scm/stock-requests/alerts','scm')).body.manualReview,beforeCount+1);
  assert.ok((await http('/api/scm/stock-requests?queue=request','scm')).body.requests.some(row=>row.id===added.id));
});
test('the real Sales submission API accepts supported Stocking yards and ignores spoofed origin metadata',async()=>{
  const choices=await http('/api/sales/stock-requests','sales');assert.deepEqual(choices.body.yards.map(y=>y.locationId),[26]);
  assert.deepEqual(choices.body.stockingYards.map(y=>y.locationId).sort((a,b)=>a-b),[1,15,26,28]);
  const created=await http('/api/sales/stock-requests','sales',{deliveryMethod:'stocking',stockingType:'purchase',requestingLocationId:15,destinationLocationId:1,lines:[{itemId,pieces:20}]});
  assert.equal(created.status,201);assert.equal(created.body.destinationLocationId,1);assert.equal(created.body.regular.requestingLocationId,26);
  assert.equal((await http(`/api/sales/stock-requests/${created.body.id}`,'other')).status,403);
  const edited=await http(`/api/sales/stock-requests/${created.body.id}`,'sales',{deliveryMethod:'stocking',stockingType:'purchase',requestingLocationId:15,destinationLocationId:28,expectedRevision:created.body.revision,lines:[{id:created.body.lines[0].id,itemId,pieces:25}]},'PATCH');
  assert.equal(edited.status,200);assert.equal(edited.body.destinationLocationId,28);assert.equal(edited.body.regular.requestingLocationId,26);
  assert.equal((await http(`/api/sales/stock-requests/${created.body.id}`,'sales',{deliveryMethod:'pickup',stockingType:'transfer',destinationLocationId:28,expectedRevision:edited.body.revision,lines:[{itemId,sourceLocationId:1,pieces:25}]},'PATCH')).status,403);
});
test('other request methods and closed/cancelled requests cannot use replies or cross-yard Stocking access',async()=>{
  for(const status of ['cancelled','completed']){const r=await request();await query('UPDATE sales_stock_requests SET status=$2 WHERE id=$1',[r.id,status]);assert.equal((await send(r)).status,409);}
  for(const method of ['pickup','waitlist']){
    const r=await request();await query("UPDATE sales_stock_requests SET regular_details=regular_details||jsonb_build_object('deliveryMethod',$2::text) WHERE id=$1",[r.id,method]);assert.equal((await send(r)).status,409);
    await assert.rejects(()=>submitRegularStockRequest({deliveryMethod:method,destinationLocationId:1,lines:[{itemId,sourceLocationId:28,pieces:20}]},{operatorId:actors.sales.id,authorizedDestinationLocationIds:[26]},dependencies),e=>[400,403].includes(e.status));
  }
});
test('a real manually linked Special case with no draft lines retrieves and caches the exact native SO PDF under yard access checks',async()=>{
  const r=(await query("INSERT INTO sales_stock_requests(destination_location_id,destination_name,requested_by,request_type) VALUES(26,'150',$1,'special') RETURNING id",[actors.sales.id])).rows[0];
  await query("INSERT INTO sales_special_stock_cases(request_id,inquiry_date,customer_name,vendor_name,operational_yard_location_id,sales_order_source,sales_order_netsuite_id,sales_order_ref) VALUES($1,current_date,'Manual preview customer','Preview vendor',26,'manual_link',1041475,'SOB122110')",[r.id]);
  const bytes=Buffer.from('%PDF-native-manual-SO-preview'),calls=[];
  const documents=createSpecialOrderDocumentService({fetchPdf:async(kind,id)=>{calls.push({kind,id});return {buffer:bytes,filename:'SOB122110.pdf'};}});
  const options={audience:'sales',authorizedStoreLocationIds:[26]};
  const first=await documents.preview(r.id,'sales_order',options),cached=await documents.preview(r.id,'sales_order',options);
  assert.deepEqual(first.buffer,bytes);assert.deepEqual(cached.buffer,bytes);assert.equal(first.cached,false);assert.equal(cached.cached,true);
  assert.deepEqual(calls,[{kind:'sales_order',id:1041475}]);
  await assert.rejects(()=>documents.preview(r.id,'sales_order',{audience:'sales',authorizedStoreLocationIds:[15]}),e=>e.status===403);
  await assert.rejects(()=>documents.preview(r.id,'purchase_order',options),e=>e.status===403);
  assert.equal((await query("SELECT count(*)::int AS n FROM sales_special_stock_order_lines WHERE request_id=$1",[r.id])).rows[0].n,0);
});
