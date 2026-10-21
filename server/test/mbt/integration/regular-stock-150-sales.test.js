import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {app} from '../../../src/server.js';
import {query,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import {submitDeliveryStockRequest,previewDeliveryStockRequest,retryDeliveryStockRequest} from '../../../src/regular-stock-delivery.js';
import {getSalesStockRequest,listSalesStockRequests,listStockRequestFilterOptions,createSalesStockRequest} from '../../../src/stock-request-repository.js';
import {enqueueDeliveryOperation,getDeliveryOperation,runDeliveryOperation} from '../../../src/regular-stock-delivery-operations.js';

const run=randomUUID(),actors={},tokens={},itemId=9800000000281,vendor='150-DELIVERY-'+run;
const password=randomUUID()+'-Access-A1!';
let server,base,sequence=parseInt(run.replaceAll('-','').slice(0,10),16);
const context=()=>({operatorId:actors.sales.id,audience:'sales',authorizedDestinationLocationIds:[26]});
async function http(path,role,body,method=body===undefined?'GET':'POST') {
  const response=await fetch(base+path,{method,headers:{...(role?{Authorization:`Bearer ${tokens[role]}`} : {}),
    ...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
}
function fixture(source=1,destination=28) {
  const id=++sequence,order={id,ref:'SO-150-'+id,locationId:26,
    lines:[{remoteLineId:1,itemId,quantity:100,backorderedQuantity:10,uom:'EA',locationId:destination,open:true}]};
  const calls={reads:0,confirm:0};
  const dependencies={readOrder:async()=>{calls.reads++;return structuredClone(order);},refreshAvailability:async()=>{},
    liveExecutionEnabled:true,hydrateOrder:async()=>{},linkTransferDependency:async()=>{},
    confirmTransfer:async transfer=>{calls.confirm++;await query("UPDATE sales_stock_transfers SET netsuite_transfer_order_id=$2,netsuite_transfer_order_ref=$3,confirmation_status='complete',status='pending_fulfillment' WHERE id=$1",
      [transfer.id,1700000000+transfer.id,'TO-150-'+transfer.id]);}};
  return {input:{deliveryMethod:'delivery',sourceLocationId:source,destinationLocationId:destination,salesOrderRef:order.ref},order,dependencies,calls};
}
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  for (const [name,role,yards] of [['sales','sales',[26]],['other','sales',[15]],['driver','dispatcher',[]]]) {
    const username='sales150-'+name+'-'+run;
    actors[name]=await createOperator({username,displayName:username,password,role,roles:[role],yardLocationIds:yards});
  }
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt,vendor) VALUES($1,'150 Delivery material','EA',1,100,$2) ON CONFLICT(item_id) DO UPDATE SET vendor=EXCLUDED.vendor",[itemId,vendor]);
  for (const id of [1,28,15,26]) {
    await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,$2,$3,1000000,1000000,now()) ON CONFLICT(item_id,location_id) DO UPDATE SET quantity_available=1000000,quantity_on_hand=1000000",[itemId,id,String(id)]);
  }
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  for (const name of Object.keys(actors)) {
    const login=await http('/api/auth/login',null,{username:actors[name].username,password});
    assert.equal(login.status,200);tokens[name]=login.body.token;
  }
});
after(async()=>{if (server) {await new Promise(resolve=>server.close(resolve));}await closeDb();});

test('150-only Sales previews each SO Base Yard before selecting the supplying yard', async()=>{
  for (const [source,destination] of [[1,28],[28,1]]) {
    const f=fixture(source,destination);
    const basePreview=await previewDeliveryStockRequest({salesOrderRef:f.input.salesOrderRef},context(),f.dependencies);
    assert.equal(basePreview.baseLocationId,destination);
    const calculated=await previewDeliveryStockRequest(f.input,context(),f.dependencies);
    assert.equal(calculated.lines[0].salesQty,100);assert.equal(calculated.palletQuantity,1);
  }
});
test('150-only Sales submits both routes, reads and lists them, and duplicates and retries reuse the TO', async()=>{
  for (const [source,destination] of [[1,28],[28,1]]) {
    const f=fixture(source,destination),saved=await submitDeliveryStockRequest(f.input,context(),f.dependencies);
    assert.equal(saved.regular.approval.automatic,true);assert.equal(saved.regular.handoffStatus,'complete');
    assert.equal(saved.transfers.length,1);assert.equal(saved.transfers[0].sourceLocationId,source);assert.equal(saved.transfers[0].destinationLocationId,destination);
    assert.equal((await getSalesStockRequest(saved.id,context())).id,saved.id);
    assert((await listSalesStockRequests({...context(),search:saved.requestRef})).some(row=>row.id===saved.id));
    assert((await listStockRequestFilterOptions(context())).vendors.includes(vendor));
    const duplicate=await submitDeliveryStockRequest(f.input,context(),f.dependencies);
    const retry=await retryDeliveryStockRequest(saved.id,context(),f.dependencies);
    assert.equal(duplicate.id,saved.id);assert.equal(retry.transfers[0].id,saved.transfers[0].id);assert.equal(f.calls.confirm,1);
    const detail=await http('/api/sales/stock-requests/'+saved.id,'sales');assert.equal(detail.status,200);
    const listed=await http('/api/sales/stock-requests?bucket=accepted','sales');assert.equal(listed.status,200);
    assert(listed.body.requests.some(row=>row.id===saved.id));assert.deepEqual(listed.body.yards.map(yard=>yard.locationId),[26]);
    assert.equal((await http('/api/sales/stock-requests/'+saved.id,'other')).status,200);
  }
});
test('150 delivery exception rejects every unassigned route outside the pair before reading or writing orders', async()=>{
  for (const source of [1,28,15,26]) {
    for (const destination of [1,28,15]) {
      if (source===destination || source===1 && destination===28 || source===28 && destination===1) {continue;}
      const f=fixture(source,destination);
      await assert.rejects(()=>submitDeliveryStockRequest(f.input,context(),f.dependencies),{status:403});
      assert.equal(f.calls.reads,0);assert.equal(f.calls.confirm,0);
      await assert.rejects(()=>previewDeliveryStockRequest(f.input,context(),f.dependencies),{status:403});
    }
  }
  const existing=fixture(1,26),saved=await submitDeliveryStockRequest(existing.input,context(),existing.dependencies);
  assert.equal(saved.regular.deliveryApproval,'pending');assert.equal(saved.transfers.length,0);
});
test('SQL and detail scope expose only current regular Delivery requests on the two new routes', async()=>{
  const cases=[
    ['regular',2,'delivery',1,1,28,true],['regular',2,'delivery',1,28,1,true],
    ['regular',1,'delivery',1,1,28,false],['regular',2,'delivery',2,1,28,false],
    ['special',2,'delivery',1,1,28,false],['regular',2,'pickup',1,1,28,false],
    ['regular',2,'stocking',1,1,28,false],['regular',2,'waitlist',1,1,28,false],
    ['regular',2,'delivery',1,15,28,false],['regular',2,'delivery',1,26,1,false],
    ['regular',2,'delivery',1,1,15,false],['regular',2,'delivery',1,1,1,false],
    ['regular',2,'pickup',null,1,26,true]
  ];
  for (const [type,workflow,method,version,source,destination,expected] of cases) {
    const ref='150-MATRIX-'+run+'-'+(++sequence);
    const row=(await query(`INSERT INTO sales_stock_requests(request_ref,request_type,workflow_version,regular_details,destination_location_id,destination_name,requested_by)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING id`,[ref,type,workflow,JSON.stringify({deliveryMethod:method,deliveryVersion:version,sourceLocationId:source}),destination,String(destination),actors.other.id])).rows[0];
    const listed=await listSalesStockRequests({...context(),search:ref});
    assert.equal(listed.some(record=>record.id===Number(row.id)),expected,ref);
    if (expected) {assert.equal((await getSalesStockRequest(row.id,context())).id,Number(row.id));}
    else {await assert.rejects(()=>getSalesStockRequest(row.id,context()),{status:403});}
    const paired=type==='regular'&&workflow===2&&method==='delivery'&&version===1&&((source===1&&destination===28)||(source===28&&destination===1));
    assert.equal((await listSalesStockRequests({authorizedDestinationLocationIds:[],search:ref})).length,paired?1:0);
  }
});
test('Other methods retain yard restrictions while every Sales account shares paired Delivery', async()=>{
  const f=fixture();
  await assert.rejects(()=>createSalesStockRequest({destinationLocationId:28,lines:[{itemId,pieces:1,sourceLocationId:1}]},context()),{status:403});
  await assert.rejects(()=>submitDeliveryStockRequest({...f.input,destinationLocationId:26},{operatorId:actors.other.id,authorizedDestinationLocationIds:[15]},f.dependencies),{status:403});
  assert.equal(f.calls.reads,0);
  const path='/api/sales/stock-requests';
  for (const method of ['pickup','waitlist']) {
    assert.equal((await http(path,'sales',{deliveryMethod:method,destinationLocationId:28,lines:[{itemId,pieces:1,sourceLocationId:1}]})).status,403);
  }
  const stocking=await http(path,'sales',{deliveryMethod:'stocking',destinationLocationId:28,lines:[{itemId,pieces:1,sourceLocationId:1}]});
  assert.equal(stocking.status,201);assert.equal(stocking.body.regular.requestingLocationId,26);assert.equal(stocking.body.destinationLocationId,28);
  assert.equal((await http(path,'sales',{...f.input,salesOrderRef:''})).status,400);
  assert.equal((await http(path,'other',{...f.input,salesOrderRef:''})).status,400);
  assert.equal((await http(path,'driver',f.input)).status,403);
  assert.equal((await http(path,null,f.input)).status,401);
});
test('150 asynchronous preview, submit and retry preserve result access and one TO', async()=>{
  for (const [source,destination] of [[1,28],[28,1]]) {
    const f=fixture(source,destination);
    for (const input of [{salesOrderRef:f.input.salesOrderRef},f.input]) {
      const op=await enqueueDeliveryOperation({operationId:randomUUID(),action:'preview',input},context());
      await runDeliveryOperation(op.id,f.dependencies);
      const done=await getDeliveryOperation(op.id,context());assert.equal(done.status,'succeeded');assert.equal(done.result.baseLocationId,destination);
      assert.equal((await getDeliveryOperation(op.id,{...context(),authorizedDestinationLocationIds:[]})).status,'succeeded');
    }
    const op=await enqueueDeliveryOperation({operationId:randomUUID(),action:'submit',input:f.input},context());
    await runDeliveryOperation(op.id,f.dependencies);
    const saved=(await getDeliveryOperation(op.id,context())).result;
    assert.equal(saved.regular.handoffStatus,'complete');
    const retry=await enqueueDeliveryOperation({operationId:randomUUID(),action:'retry',requestId:saved.id},context());
    await runDeliveryOperation(retry.id,f.dependencies);
    assert.equal((await getDeliveryOperation(retry.id,context())).result.id,saved.id);assert.equal(f.calls.confirm,1);
    const read=await http('/api/sales/stock-requests/delivery/operations/'+op.id,'sales');assert.equal(read.status,200);
    assert.equal((await getDeliveryOperation(op.id,{...context(),authorizedDestinationLocationIds:[]})).status,'succeeded');
  }
});
test('deactivating a Sales account rejects queued submissions before a NetSuite read', async()=>{
  const f=fixture(),op=await enqueueDeliveryOperation({operationId:randomUUID(),action:'submit',input:f.input},context());
  await query('UPDATE operators SET active=false WHERE id=$1',[actors.sales.id]);
  try {await runDeliveryOperation(op.id,f.dependencies);}
  finally {await query('UPDATE operators SET active=true WHERE id=$1',[actors.sales.id]);}
  const failed=await getDeliveryOperation(op.id,context());assert.equal(failed.status,'failed');assert.equal(failed.code,'REGULAR_DELIVERY_ACCESS');assert.equal(f.calls.reads,0);
});
test('failed external delivery is readable and retries reuse the saved request and transfer for 150 Sales', async()=>{
  const f=fixture(),saved=await submitDeliveryStockRequest(f.input,context(),{...f.dependencies,confirmTransfer:async()=>{throw new Error('Isolated printer failure');}});
  assert.equal(saved.regular.handoffStatus,'attention');assert.equal(saved.transfers.length,1);
  const restored=await retryDeliveryStockRequest(saved.id,context(),f.dependencies);
  assert.equal(restored.regular.handoffStatus,'complete');assert.equal(restored.transfers[0].id,saved.transfers[0].id);
});
