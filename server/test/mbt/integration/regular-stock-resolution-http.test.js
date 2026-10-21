import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {app} from '../../../src/server.js';
import {query,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import {submitRegularStockRequest,acknowledgeRegularStockDecisions} from '../../../src/regular-stock-request-service.js';
import {reconcilePurchaseStockAllocations} from '../../../src/regular-stock-purchase-repository.js';

const run=randomUUID(),actors={},tokens={},nativeFetch=globalThis.fetch;
const fixturePassword=randomUUID()+'-Resolve-A1!';
const itemId=9800000000101,poId=9800000000101,poRef=`RESOLVE-${run.slice(0,8)}`;
const dependencies={refreshAvailability:async()=>{},loadPolicies:async()=>[],loadPurchaseStock:async()=>({onHand:1000,available:1000,preferredStock:1000})};
let server,base,outbound=0;
async function http(path,role,body,method=body===undefined?'GET':'POST'){
  const response=await nativeFetch(base+path,{method,headers:{...(role?{Authorization:`Bearer ${tokens[role]}`} : {}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data={error:text};}
  return {status:response.status,body:data};
}
async function request(stockingType='transfer',deliveryMethod='stocking'){
  return submitRegularStockRequest({destinationLocationId:28,deliveryMethod,stockingType,
    ...(deliveryMethod==='delivery'?{arrivalDate:'2099-10-15',arrivalTime:'15:00'}:{}),
    lines:[{itemId,...(stockingType==='purchase'?{}:{sourceLocationId:1}),pieces:20}]},
  {operatorId:actors.sales.id,authorizedDestinationLocationIds:[28],allowOverAvailability:true},dependencies);
}
const reply=record=>({expectedRevision:record.revision,purchaseOrderRef:poRef,eta:'2026-10-15'});
const resolve=(record,body=reply(record),role='scm')=>http(`/api/scm/stock-requests/${record.id}/resolve`,role,body);
async function snapshot(id){return (await query(`SELECT r.*,COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM sales_stock_request_lines l WHERE l.request_id=r.id),'[]') AS lines,
  COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM sales_stock_request_events e WHERE e.request_id=r.id),'[]') AS events FROM sales_stock_requests r WHERE r.id=$1`,[id])).rows[0];}
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');assert.match(new URL(process.env.DATABASE_URL).pathname,/^\/mbt_test(?:_file_[a-f0-9]{12}_[a-z0-9]+)?$/);
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,'Resolve HTTP material','EA',1,100) ON CONFLICT DO NOTHING",[itemId]);
  await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,1,'3445',1000,1000,now()) ON CONFLICT DO NOTHING",[itemId]);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,netsuite_active,destination_location_id,memo,status_text,foreign_total,expected_delivery_date) VALUES($1,$2,true,28,'Must stay unchanged','Pending Receipt',321,'2026-12-01') ON CONFLICT(netsuite_id) DO UPDATE SET tranid=EXCLUDED.tranid,netsuite_active=true",[poId,poRef]);
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  for(const [key,role,yards] of [['sales','sales',[28]],['peer','sales',[28]],['other','sales',[1]],['scm','scm',[]],['driver','dispatcher',[]]]){
    const username=`resolve-${key}-${run}`;await createOperator({username,displayName:username,password:fixturePassword,role,roles:[role],yardLocationIds:yards});
    actors[key]=(await query('SELECT id FROM operators WHERE username=$1',[username])).rows[0];
    const login=await http('/api/auth/login',null,{username,password:fixturePassword});assert.equal(login.status,200);tokens[key]=login.body.token;
  }
  globalThis.fetch=async(...args)=>{outbound++;throw new Error('Resolve must not call external services: '+String(args[0]).slice(0,100));};
});
after(async()=>{globalThis.fetch=nativeFetch;if(server)await new Promise(resolve=>server.close(resolve));await closeDb();});

test('SCM resolves Transfer and Purchase Stocking requests with canonical PO/ETA, closes both queues, and leaves the PO unchanged',async()=>{
  const poBefore=(await query('SELECT * FROM purchase_orders WHERE netsuite_id=$1',[poId])).rows[0];
  for(const type of ['transfer','purchase']){
    const record=await request(type),beforeLines=record.lines.map(line=>({id:line.id,quantity:line.salesQty,unit:line.salesUom}));
    const result=await resolve(record,{...reply(record),purchaseOrderRef:`  ${poRef.toLowerCase()}  `});assert.equal(result.status,200);
    const closed=result.body;assert.equal(closed.status,'completed');assert.equal(closed.bucket,'completed');assert.equal(closed.revision,record.revision+1);
    assert.equal(closed.regular.resolution.purchaseOrderId,poId);assert.equal(closed.regular.resolution.purchaseOrderRef,poRef);assert.equal(closed.regular.resolution.eta,'2026-10-15');
    assert.equal(closed.regular.resolution.resolvedBy,actors.scm.id);assert.ok(Number.isFinite(Date.parse(closed.regular.resolution.resolvedAt)));
    assert.ok(closed.lines.every(line=>line.status==='closed'));assert.deepEqual(closed.lines.map(line=>({id:line.id,quantity:line.salesQty,unit:line.salesUom})),beforeLines);
    assert.equal(closed.transfers.length,0);assert.ok(closed.manualDecisionEventId>0);
    const sales=(await http('/api/sales/stock-requests?bucket=completed','sales')).body.requests;assert.ok(sales.some(row=>row.id===record.id));
    const closedQueue=(await http('/api/scm/stock-requests?queue=closed','scm')).body.requests;assert.ok(closedQueue.some(row=>row.id===record.id));
    const pending=(await http('/api/scm/stock-requests?queue=request','scm')).body.requests;assert.ok(!pending.some(row=>row.id===record.id));
    await reconcilePurchaseStockAllocations();assert.equal((await snapshot(record.id)).status,'completed');
  }
  assert.deepEqual((await query('SELECT * FROM purchase_orders WHERE netsuite_id=$1',[poId])).rows[0],poBefore);assert.equal(outbound,0);
});

test('required fields, calendar errors, nonexistent/deleted/ambiguous POs and stale revisions make no writes',async()=>{
  const record=await request(),before=await snapshot(record.id);
  for(const change of [{purchaseOrderRef:''},{eta:''},{eta:'2026-02-30'},{expectedRevision:null},{expectedRevision:1.5},{purchaseOrderRef:'x'.repeat(81)}]){
    assert.equal((await resolve(record,{...reply(record),...change})).status,400);assert.deepEqual(await snapshot(record.id),before);
  }
  assert.equal((await resolve(record,{...reply(record),purchaseOrderRef:'NO-SUCH-PO'})).status,404);
  assert.equal((await resolve(record,{...reply(record),expectedRevision:record.revision+1})).status,409);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,netsuite_active) VALUES($1,$2,false) ON CONFLICT(netsuite_id) DO UPDATE SET tranid=EXCLUDED.tranid,netsuite_active=false",[poId+1,poRef+'-DELETED']);
  assert.equal((await resolve(record,{...reply(record),purchaseOrderRef:poRef+'-DELETED'})).status,404);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,netsuite_active) VALUES($1,$2,true) ON CONFLICT(netsuite_id) DO UPDATE SET tranid=EXCLUDED.tranid,netsuite_active=true",[poId+2,poRef.toLowerCase()]);
  try{assert.equal((await resolve(record)).status,409);}finally{await query('DELETE FROM purchase_orders WHERE netsuite_id=$1',[poId+2]);}
  assert.deepEqual(await snapshot(record.id),before);
});

test('closure and the single Sales notice are private, persistent and dismissed permanently after read',async()=>{
  const record=await request();assert.equal((await resolve(record,reply(record),null)).status,401);
  for(const role of ['sales','peer','driver'])assert.equal((await resolve(record,reply(record),role)).status,403);
  const resolved=await resolve(record);assert.equal(resolved.status,200);
  for(let i=0;i<2;i++)assert.equal((await http('/api/sales/stock-requests/alerts','sales')).body.requests.filter(row=>row.id===record.id).length,1);
  for(const role of ['peer','other']){
    assert.ok(!(await http('/api/sales/stock-requests/alerts',role)).body.requests.some(row=>row.id===record.id));
    assert.equal((await http(`/api/sales/stock-requests/${record.id}/decisions/read`,role,{eventId:resolved.body.manualDecisionEventId})).status,403);
  }
  assert.equal((await http(`/api/sales/stock-requests/${record.id}`,'other')).status,403);
  const read={eventId:resolved.body.manualDecisionEventId};assert.equal((await http(`/api/sales/stock-requests/${record.id}/decisions/read`,'sales',read)).status,200);
  await acknowledgeRegularStockDecisions(record.id,read,{operatorId:actors.sales.id,authorizedDestinationLocationIds:[28]});
  assert.equal((await resolve(record)).status,200);
  for(let i=0;i<2;i++)assert.ok(!(await http('/api/sales/stock-requests/alerts','sales')).body.requests.some(row=>row.id===record.id));
});

test('concurrent retries produce one event and revision; a different saved reply cannot overwrite the closure',async()=>{
  const record=await request(),body=reply(record),results=await Promise.all(Array.from({length:6},()=>resolve(record,body)));
  assert.ok(results.every(result=>result.status===200));assert.ok(results.every(result=>result.body.revision===record.revision+1));
  const row=await snapshot(record.id);assert.equal(row.events.filter(event=>event.event_type==='regular_manual_decision'&&event.details.decision==='resolve').length,1);
  assert.equal(row.revision,record.revision+1);assert.equal((await resolve(record,{...body,eta:'2026-10-16'})).status,409);assert.deepEqual(await snapshot(record.id),row);
});

test('Resolve cannot close other methods, cancelled/special cases, a transfer, SO/TO execution, or accepted Purchase demand',async()=>{
  for(const method of ['pickup','delivery']){const record=await request('transfer',method);assert.equal((await resolve(record)).status,409);}
  for(const changes of [{status:'cancelled'},{request_type:'special'},{regular_details:{deliveryMethod:'stocking',pickupTransfer:{status:'executing'}}},
    {regular_details:{deliveryMethod:'stocking',handoffStatus:'executing'}}]){
    const record=await request();for(const [key,value] of Object.entries(changes))await query(`UPDATE sales_stock_requests SET ${key}=$2 WHERE id=$1`,[record.id,key==='regular_details'?JSON.stringify(value):value]);
    const before=await snapshot(record.id);assert.ok([404,409].includes((await resolve(record)).status));assert.deepEqual(await snapshot(record.id),before);
  }
  const transfer=await request();await query('INSERT INTO sales_stock_transfers(request_id,source_location_id,source_name,destination_location_id,destination_name,created_by) VALUES($1,1,\'3445\',28,\'Carson\',$2)',[transfer.id,actors.scm.id]);
  assert.equal((await resolve(transfer)).status,409);
  const purchase=await request('purchase');const demand=(await query(`INSERT INTO regular_stock_purchase_demands(request_line_id,vendor_yard_id,vendor_id,policy_snapshot,requested_quantity,reviewed_quantity,approved_quantity,to_plt,accepted_by)
    VALUES($1,1,1,'{}',20,20,100,100,$2) RETURNING id`,[purchase.lines[0].id,actors.scm.id])).rows[0];
  try{const before=await snapshot(purchase.id);assert.equal((await resolve(purchase)).status,409);assert.deepEqual(await snapshot(purchase.id),before);}
  finally{await query('DELETE FROM regular_stock_purchase_demands WHERE id=$1',[demand.id]);}
});

test('a failed line update rolls back the closure and notification event together',async()=>{
  const record=await request(),before=await snapshot(record.id),name='resolve_failure_'+run.slice(0,8).replaceAll('-','');
  await query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected Resolve transaction failure'; END $$`);
  await query(`CREATE TRIGGER ${name} AFTER UPDATE ON sales_stock_request_lines FOR EACH ROW WHEN (NEW.request_id=${record.id} AND NEW.status='closed') EXECUTE FUNCTION ${name}()`);
  try{assert.equal((await resolve(record)).status,500);assert.deepEqual(await snapshot(record.id),before);}
  finally{await query(`DROP TRIGGER ${name} ON sales_stock_request_lines`);await query(`DROP FUNCTION ${name}()`);}
});
