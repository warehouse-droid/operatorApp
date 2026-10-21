import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {app} from '../../../src/server.js';
import {query,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import {submitRegularStockRequest} from '../../../src/regular-stock-request-service.js';
import {moveStockingLineToWaitlist} from '../../../src/regular-stock-waitlist-transition.js';
import {getSalesStockRequest,listSalesStockRequests} from '../../../src/stock-request-repository.js';
import {getWaitlistRequest,closeWaitlistRequest,submitWaitlistRequest} from '../../../src/regular-waitlist-repository.js';

const run=randomUUID(),actors={},tokens={},customerId=98361006001,itemId=98361006002,nativeFetch=globalThis.fetch;
const dependencies={refreshAvailability:async()=>{},loadPolicies:async()=>[],loadPurchaseStock:async()=>({available:1000,onHand:1000})};
let server,base,external=0;
async function http(path,role,body,method=body===undefined?'GET':'POST'){
  const response=await nativeFetch(base+path,{method,headers:{...(role?{Authorization:`Bearer ${tokens[role]}`} : {}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
}
const context=()=>({operatorId:actors.scm.id});
const source=(type='transfer',count=2)=>submitRegularStockRequest({deliveryMethod:'stocking',stockingType:type,destinationLocationId:1,customerName:'Stocking customer',
  lines:Array.from({length:count},(_,index)=>({itemId,sourceLocationId:28,pieces:21.123456+index}))},
  {operatorId:actors.sales.id,authorizedDestinationLocationIds:[26],allowOverAvailability:true},dependencies);
const input=request=>({expectedRevision:request.revision,customerId,operationKey:randomUUID()});
const children=async id=>(await query("SELECT id FROM sales_stock_requests WHERE regular_details#>>'{stockingSource,requestId}'=$1",[String(id)])).rows;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
  await query("INSERT INTO inventory_items(item_id,item_name,item_type,stock_unit,to_plt,to_pcs,item_weight) VALUES($1,'UNI-Stock actions','InvtPart','EA',100,1,10)",[itemId]);
  for(const yard of [1,28,15,26])await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,$2,$3,1000,1000,now())",[itemId,yard,String(yard)]);
  await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,display_name,legal_name,currency,active,source_modified_at,source_version,payload_hash) VALUES($1,'STOCK-ACTIONS','Stock actions customer','Stock actions customer','CAD',true,now(),'test',repeat('a',64))",[customerId]);
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  for(const [name,role,yards] of [['sales','sales',[26]],['scm','scm',[]],['other','sales',[15]],['destination','sales',[1]],['viewer','yard_manager',[]]]){
    const username=`actions-${name}-${run}`,password='Actions-A1!'+run;await createOperator({username,displayName:username,password,role,roles:[role],yardLocationIds:yards});
    actors[name]=(await query('SELECT id FROM operators WHERE username=$1',[username])).rows[0];const login=await http('/api/auth/login',null,{username,password});assert.equal(login.status,200);tokens[name]=login.body.token;
  }
  globalThis.fetch=async()=>{external++;throw new Error('Transition must not call external services');};
});
after(async()=>{globalThis.fetch=nativeFetch;if(server)await new Promise(resolve=>server.close(resolve));await closeDb();});

test('SCM moves one saved Stocking line into Waiting with exact quantity, owner and yard; other lines stay active',async()=>{
  for(const type of ['transfer','purchase']){
    const request=await source(type),line=request.lines[0],result=await moveStockingLineToWaitlist(request.id,line.id,input(request),context());
    assert.equal(result.waitlistRequest.requestedBy,actors.sales.id);assert.equal(result.waitlistRequest.destinationLocationId,1);assert.equal(result.waitlistRequest.regular.customerId,customerId);
    assert.equal(result.waitlistRequest.lines.length,1);assert.equal(result.waitlistRequest.lines[0].salesQty,line.salesQty);assert.equal(result.waitlistRequest.lines[0].salesUom,line.salesUom);assert.equal(result.waitlistRequest.lines[0].itemId,itemId);
    assert.equal(result.waitlistRequest.waitlist.state,'waiting');assert.equal(result.request.lines[0].status,'cancelled');assert.equal(result.request.lines[1].status,request.lines[1].status);assert.equal(result.request.status,'active');assert.equal(result.request.revision,request.revision+1);
    const audit=result.request.events.find(e=>e.eventType==='stocking_line_waitlisted');assert.equal(audit.actorId,actors.scm.id);assert.equal(audit.details.waitlistRequestId,result.waitlistRequest.id);assert.equal(audit.details.lineId,line.id);
    assert.equal(external,0);
  }
});
test('moving the last line completes its source while the linked Waitlist stays open',async()=>{
  const request=await source('transfer',1),result=await moveStockingLineToWaitlist(request.id,request.lines[0].id,input(request),context());
  assert.equal(result.request.status,'completed');assert.equal(result.waitlistRequest.status,'submitted');assert.equal(result.waitlistRequest.waitlist.requestedQty,request.lines[0].salesQty);
});
test('cross-yard converted Waitlist remains readable and closable for origin Sales, while unrelated Sales is denied',async()=>{
  const request=await source(),result=await moveStockingLineToWaitlist(request.id,request.lines[0].id,input(request),context()),id=result.waitlistRequest.id;
  const sales={operatorId:actors.sales.id,authorizedDestinationLocationIds:[26]};
  assert.equal((await getSalesStockRequest(id,sales)).id,id);assert.equal((await getWaitlistRequest(id,sales)).id,id);
  assert.ok((await listSalesStockRequests({requestType:'regular',deliveryMethod:'waitlist',authorizedDestinationLocationIds:[26]})).some(r=>r.id===id));
  await assert.rejects(()=>getWaitlistRequest(id,{operatorId:actors.other.id,authorizedDestinationLocationIds:[15]}),e=>e.status===403);
  const closed=await closeWaitlistRequest(id,{expectedRevision:result.waitlistRequest.revision,operationKey:randomUUID(),reason:'Customer cancelled.'},sales);assert.equal(closed.waitlist.state,'closed');
  await assert.rejects(()=>submitWaitlistRequest({destinationLocationId:1,customerId,operationKey:randomUUID(),requestingLocationId:26,stockingSource:{requestId:request.id,lineId:request.lines[0].id},lines:[{itemId,salesQty:5}]},sales),e=>e.status===403);
});
test('operation replay returns the same Waitlist and conflicting operation details fail',async()=>{
  const request=await source(),body=input(request),first=await moveStockingLineToWaitlist(request.id,request.lines[0].id,body,context()),replay=await moveStockingLineToWaitlist(request.id,request.lines[0].id,body,context());
  assert.equal(replay.waitlistRequest.id,first.waitlistRequest.id);assert.equal((await children(request.id)).length,1);
  await assert.rejects(()=>moveStockingLineToWaitlist(request.id,request.lines[0].id,{...body,customerId:customerId+1},context()),e=>e.code==='WAITLIST_IDEMPOTENCY_CONFLICT');
});
test('simultaneous moves with one revision create exactly one Waitlist child',async()=>{
  const request=await source(),results=await Promise.allSettled(Array.from({length:5},()=>moveStockingLineToWaitlist(request.id,request.lines[0].id,input(request),context())));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===409).length,4);assert.equal((await children(request.id)).length,1);
});
test('closed, resolved, ordered or linked lines cannot move and create no child or command',async()=>{
  for(const change of ["status='completed'","regular_details=regular_details||'{\"resolution\":{\"decision\":\"resolve\"}}'::jsonb","regular_details=regular_details||'{\"pickupTransfer\":{\"status\":\"complete\"}}'::jsonb","regular_details=regular_details||'{\"deliveryMethod\":\"pickup\"}'::jsonb"]){
    const request=await source();await query(`UPDATE sales_stock_requests SET ${change} WHERE id=$1`,[request.id]);const body=input(request);
    await assert.rejects(()=>moveStockingLineToWaitlist(request.id,request.lines[0].id,body,context()),e=>e.status===409);assert.equal((await children(request.id)).length,0);assert.equal((await query('SELECT 1 FROM regular_waitlist_commands WHERE operation_key=$1',[body.operationKey])).rowCount,0);
  }
});
test('invalid customer, foreign line and stale revision fail without changing the source',async()=>{
  const request=await source(),other=await source();
  for(const [line,body] of [[request.lines[0].id,{...input(request),customerId:customerId+1}],[other.lines[0].id,input(request)],[request.lines[0].id,{...input(request),expectedRevision:request.revision+1}]]){
    await assert.rejects(()=>moveStockingLineToWaitlist(request.id,line,body,context()),e=>[400,404,409].includes(e.status));
  }
  assert.equal((await getSalesStockRequest(request.id,{authorizedDestinationLocationIds:[26]})).revision,request.revision);assert.equal((await children(request.id)).length,0);
});
test('an existing Purchase demand blocks moving even a still-submitted line',async()=>{
  const request=await source('purchase'),line=request.lines[0];
  await query("INSERT INTO regular_stock_purchase_demands(request_line_id,vendor_yard_id,vendor_id,policy_snapshot,requested_quantity,reviewed_quantity,approved_quantity,to_plt,accepted_by) VALUES($1,99,99,'{}',20,20,100,100,$2)",[line.id,actors.scm.id]);
  await assert.rejects(()=>moveStockingLineToWaitlist(request.id,line.id,input(request),context()),e=>e.code==='STOCKING_WAITLIST_LOCKED');assert.equal((await children(request.id)).length,0);
  assert.equal((await query('SELECT approved_quantity FROM regular_stock_purchase_demands WHERE request_line_id=$1',[line.id])).rows[0].approved_quantity,'100');
});
test('existing TO lines and Sales order ownership prevent duplicate demand',async()=>{
  for(const kind of ['transfer','sales-order']){
    const request=await source(),line=request.lines[0],body=input(request);
    if(kind==='transfer'){
      const transfer=(await query("INSERT INTO sales_stock_transfers(request_id,source_location_id,source_name,destination_location_id,destination_name,created_by) VALUES($1,28,'2967',1,'3445',$2) RETURNING id",[request.id,actors.scm.id])).rows[0];
      await query("INSERT INTO sales_stock_transfer_lines(transfer_id,request_line_id,item_id,item_name,sales_qty,sales_uom,quantity_mode) VALUES($1,$2,$3,$4,$5,$6,'sales')",[transfer.id,line.id,itemId,line.itemName,line.salesQty,line.salesUom]);
    }else await query('INSERT INTO regular_stock_so_line_owners(sales_order_id,remote_line_id,request_id) VALUES($1,1,$2)',[900000+request.id,request.id]);
    await assert.rejects(()=>moveStockingLineToWaitlist(request.id,line.id,body,context()),e=>e.code==='STOCKING_WAITLIST_LOCKED');
    assert.equal((await children(request.id)).length,0);assert.equal((await query('SELECT 1 FROM regular_waitlist_commands WHERE operation_key=$1',[body.operationKey])).rowCount,0);
  }
});
test('failure while retiring the source line rolls back child, event, revision and idempotency receipt',async()=>{
  const request=await source(),body=input(request),line=request.lines[0];
  await query(`CREATE FUNCTION stock_actions_fail_move() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${line.id} AND NEW.status='cancelled' THEN RAISE EXCEPTION 'injected transition failure'; END IF; RETURN NEW; END $$`);
  await query('CREATE TRIGGER stock_actions_fail_move BEFORE UPDATE ON sales_stock_request_lines FOR EACH ROW EXECUTE FUNCTION stock_actions_fail_move()');
  try{await assert.rejects(()=>moveStockingLineToWaitlist(request.id,line.id,body,context()),/injected transition failure/);}finally{await query('DROP TRIGGER stock_actions_fail_move ON sales_stock_request_lines');await query('DROP FUNCTION stock_actions_fail_move()');}
  assert.equal((await children(request.id)).length,0);assert.equal((await getSalesStockRequest(request.id,{authorizedDestinationLocationIds:[26]})).revision,request.revision);
  assert.equal((await query("SELECT 1 FROM sales_stock_request_events WHERE request_id=$1 AND event_type='stocking_line_waitlisted'",[request.id])).rowCount,0);
  assert.equal((await query('SELECT 1 FROM regular_waitlist_commands WHERE operation_key=$1',[body.operationKey])).rowCount,0);
});
test('HTTP roles protect the transition and customer lookup; SCM receives linked source and Waitlist',async()=>{
  const request=await source(),path=`/api/scm/waitlist/stocking-requests/${request.id}/lines/${request.lines[0].id}`,body=input(request);
  for(const role of [null,'sales','viewer'])assert.equal((await http(path,role,body)).status,role?403:401);
  assert.equal((await http('/api/scm/waitlist/customers?search=STOCK-ACTIONS','scm')).body.customers[0].id,customerId);
  const converted=await http(path,'scm',body);assert.equal(converted.status,201);assert.equal(converted.body.waitlistRequest.waitlist.state,'waiting');
  const alerts=await http('/api/sales/stock-requests/alerts','sales');assert.ok(alerts.body.requests.some(row=>row.id===request.id&&row.waitlistRequestId===converted.body.waitlistRequest.id));
  assert.equal((await http(`/api/sales/stock-requests/${converted.body.waitlistRequest.id}`,'sales')).status,200);
});
