import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {app} from '../../../src/server.js';
import {query,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';
import {previewDeliveryStockRequest,submitDeliveryStockRequest,retryDeliveryStockRequest} from '../../../src/regular-stock-delivery.js';
import {getSalesStockRequest,listSalesStockRequests,listStockRequestFilterOptions} from '../../../src/stock-request-repository.js';
import {enqueueDeliveryOperation,getDeliveryOperation,runDeliveryOperation} from '../../../src/regular-stock-delivery-operations.js';

const run=randomUUID(),password=randomUUID()+'-Yard-A1!',actors={},tokens={},itemId=9800000000289;
let server,base,sequence=parseInt(run.replaceAll('-','').slice(0,10),16);
const context=yard=>({operatorId:actors[yard].id,audience:'sales',authorizedDestinationLocationIds:yard===0?[]:[yard]});
async function http(path,yard) {
  const response=await fetch(base+path,{headers:yard!==null&&yard!==undefined?{Authorization:`Bearer ${tokens[yard]}`}:{}});
  return {status:response.status,body:await response.json()};
}
function fixture(source=28,destination=1) {
  const id=++sequence,order={id,ref:'SO-TARGET-'+id,locationId:destination,
    lines:[{remoteLineId:1,itemId,quantity:100,backorderedQuantity:10,uom:'EA',locationId:destination,open:true}]};
  const calls={reads:0,confirm:0};
  const dependencies={readOrder:async()=>{calls.reads++;return structuredClone(order);},refreshAvailability:async()=>{},
    liveExecutionEnabled:true,hydrateOrder:async()=>{},linkTransferDependency:async()=>{},
    confirmTransfer:async transfer=>{calls.confirm++;await query("UPDATE sales_stock_transfers SET netsuite_transfer_order_id=$2,netsuite_transfer_order_ref=$3,confirmation_status='complete',status='pending_fulfillment' WHERE id=$1",
      [transfer.id,1800000000+transfer.id,'TO-TARGET-'+transfer.id]);}};
  return {input:{deliveryMethod:'delivery',sourceLocationId:source,destinationLocationId:destination,salesOrderRef:order.ref},order,dependencies,calls};
}
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
  for (const yard of [1,28,15,26,0]) {
    const username='target-yard-'+yard+'-'+run;
    actors[yard]=await createOperator({username,displayName:username,password,role:'sales',roles:['sales'],yardLocationIds:yard===0?[]:[yard]});
  }
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt,vendor) VALUES($1,'Target access fixture','EA',1,100,$2) ON CONFLICT(item_id) DO UPDATE SET vendor=EXCLUDED.vendor",[itemId,'TARGET-'+run]);
  for (const yard of [1,28,15,26]) await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,$2,$3,1000000,1000000,now()) ON CONFLICT DO NOTHING",[itemId,yard,String(yard)]);
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  for (const yard of [1,28,15,26,0]) {
    const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:actors[yard].username,password})});
    assert.equal(login.status,200);tokens[yard]=(await login.json()).token;
  }
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await closeDb();});

test('every Sales account can preview, submit, list, filter, read and retry both paired routes',async()=>{
  for (const yard of [1,28,15,26,0]) for (const [source,destination] of [[28,1],[1,28]]) {
    const f=fixture(source,destination),ctx=context(yard);
    const discovery=await previewDeliveryStockRequest({salesOrderRef:f.input.salesOrderRef},ctx,f.dependencies);
    assert.equal(discovery.baseLocationId,destination);
    const preview=await previewDeliveryStockRequest(f.input,ctx,f.dependencies);
    assert.equal(preview.baseLocationId,destination);assert.equal(preview.lines[0].salesQty,100);
    const saved=await submitDeliveryStockRequest(f.input,ctx,f.dependencies);
    assert.equal(saved.regular.handoffStatus,'complete');assert.equal(saved.transfers.length,1);
    assert.equal(saved.transfers[0].sourceLocationId,source);assert.equal(saved.transfers[0].destinationLocationId,destination);
    assert.equal((await getSalesStockRequest(saved.id,ctx)).id,saved.id);
    assert.ok((await listSalesStockRequests({...ctx,search:saved.requestRef})).some(record=>record.id===saved.id));
    const options=await listStockRequestFilterOptions(ctx);
    assert.ok(options.destinationYards.some(yard=>Number(yard.locationId)===destination));
    assert.equal((await http('/api/sales/stock-requests/'+saved.id,source)).status,200);
    for (const reader of [1,28,15,26,0]) assert.equal((await http('/api/sales/stock-requests/'+saved.id,reader)).status,200);
    assert.ok(options.vendors.includes('TARGET-'+run));
    assert.ok(options.destinationYards.some(option=>option.locationId===source));
    assert.equal((await http('/api/sales/stock-requests/'+saved.id,null)).status,401);
    assert.equal((await submitDeliveryStockRequest(f.input,ctx,f.dependencies)).id,saved.id);
    assert.equal((await retryDeliveryStockRequest(saved.id,ctx,f.dependencies)).id,saved.id);
    assert.equal(f.calls.confirm,1);
    assert.equal((await getSalesStockRequest(saved.id,context(0))).id,saved.id);
  }
});

test('SQL lists and detail authorization agree across yards, methods and versions',async()=>{
  for (const type of ['regular','special']) for (const workflow of [1,2]) for (const method of ['delivery','pickup','stocking','waitlist']) {
    for (const version of [1,2]) for (const [source,destination] of [[28,1],[1,28],[28,15],[15,1],[28,28],[1,1]]) {
      const ref='TARGET-MATRIX-'+run+'-'+(++sequence);
      const row=(await query(`INSERT INTO sales_stock_requests(request_ref,request_type,workflow_version,regular_details,destination_location_id,destination_name,requested_by)
        VALUES($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING id`,[ref,type,workflow,JSON.stringify({deliveryMethod:method,deliveryVersion:version,sourceLocationId:source}),destination,String(destination),actors[15].id])).rows[0];
      for (const yard of [1,28,15,26,0]) {
        const paired=(source===28&&destination===1)||(source===1&&destination===28);
        const expected=yard===destination||(type==='regular'&&workflow===2&&method==='delivery'&&version===1&&paired);
        const listed=await listSalesStockRequests({...context(yard),search:ref});
        assert.equal(listed.some(record=>record.id===Number(row.id)),expected,ref+' yard '+yard);
        if(expected)assert.equal((await getSalesStockRequest(row.id,context(yard))).id,Number(row.id));
        else await assert.rejects(()=>getSalesStockRequest(row.id,context(yard)),{status:403});
      }
    }
  }
});

test('asynchronous target previews, submissions and retries remain readable and revocation is enforced',async()=>{
  const f=fixture(),ctx=context(28);
  for (const input of [{salesOrderRef:f.input.salesOrderRef},f.input]) {
    const op=await enqueueDeliveryOperation({operationId:randomUUID(),action:'preview',input},ctx);
    await runDeliveryOperation(op.id,f.dependencies);
    const done=await getDeliveryOperation(op.id,ctx);assert.equal(done.status,'succeeded');assert.equal(done.result.baseLocationId,1);
    assert.equal((await getDeliveryOperation(op.id,{...ctx,authorizedDestinationLocationIds:[]})).status,'succeeded');
  }
  const op=await enqueueDeliveryOperation({operationId:randomUUID(),action:'submit',input:f.input},ctx);
  await runDeliveryOperation(op.id,f.dependencies);
  const done=await getDeliveryOperation(op.id,ctx);assert.equal(done.status,'succeeded');assert.equal(done.result.regular.handoffStatus,'complete');
  assert.equal((await http('/api/sales/stock-requests/delivery/operations/'+op.id,28)).status,200);
  const retry=await enqueueDeliveryOperation({operationId:randomUUID(),action:'retry',requestId:done.result.id},ctx);
  await runDeliveryOperation(retry.id,f.dependencies);assert.equal((await getDeliveryOperation(retry.id,ctx)).status,'succeeded');assert.equal(f.calls.confirm,1);
  const revoked=await enqueueDeliveryOperation({operationId:randomUUID(),action:'submit',input:fixture().input},ctx);
  const reads=f.calls.reads;
  await query('UPDATE operators SET active=false WHERE id=$1',[actors[28].id]);
  try{await runDeliveryOperation(revoked.id,f.dependencies);}finally{await query('UPDATE operators SET active=true WHERE id=$1',[actors[28].id]);}
  const failed=await getDeliveryOperation(revoked.id,ctx);assert.equal(failed.status,'failed');assert.equal(failed.code,'REGULAR_DELIVERY_ACCESS');assert.equal(f.calls.reads,reads);
  assert.equal((await getDeliveryOperation(op.id,{...ctx,authorizedDestinationLocationIds:[]})).status,'succeeded');
});

test('out-of-pair unassigned destination access are denied before remote submission reads',async()=>{
  for (const [source,destination,yard] of [[28,15,28],[15,1,15],[26,1,26],[28,15,0]]) {
    const f=fixture(source,destination);
    await assert.rejects(()=>submitDeliveryStockRequest(f.input,context(yard),f.dependencies),{status:403});
    assert.equal(f.calls.reads,0);assert.equal(f.calls.confirm,0);
  }
});

test('only checked SO lines create transfer quantities and ownership; retry preserves selection',async()=>{
  const f=fixture(),ctx=context(28);
  f.order.lines.push({...f.order.lines[0],remoteLineId:2,quantity:200,backorderedQuantity:20});
  f.input.selectedRemoteLineIds=[2];
  const before=structuredClone(f.order);
  const preview=await previewDeliveryStockRequest(f.input,ctx,f.dependencies);
  assert.deepEqual(preview.candidates.map(line=>line.remoteLineId),[1,2]);
  assert.deepEqual(preview.lines.map(line=>line.remoteLineId),[2]);assert.equal(preview.palletQuantity,2);
  const saved=await submitDeliveryStockRequest(f.input,ctx,f.dependencies);
  assert.equal(saved.regular.handoffStatus,'complete');assert.deepEqual(saved.regular.selectedRemoteLineIds,[2]);
  assert.equal(saved.lines.length,1);assert.equal(saved.lines[0].salesQty,200);
  assert.equal(saved.transfers[0].lines.length,1);assert.equal(saved.transfers[0].lines[0].salesQty,200);
  const plan=(await query('SELECT plan FROM regular_stock_handoffs WHERE request_id=$1',[saved.id])).rows[0].plan;
  assert.deepEqual(plan.materialLineIds,[2]);assert.deepEqual(plan.mappings.map(line=>line.remoteLineId),[2]);
  const owners=(await query('SELECT remote_line_id FROM regular_stock_so_line_owners WHERE sales_order_id=$1',[f.order.id])).rows;
  assert.deepEqual(owners.map(row=>Number(row.remote_line_id)),[2]);
  assert.equal((await submitDeliveryStockRequest(f.input,ctx,f.dependencies)).id,saved.id);
  assert.equal((await retryDeliveryStockRequest(saved.id,ctx,f.dependencies)).id,saved.id);assert.equal(f.calls.confirm,1);
  await assert.rejects(()=>submitDeliveryStockRequest({...f.input,selectedRemoteLineIds:[1,2]},ctx,f.dependencies),{code:'REGULAR_DELIVERY_SELECTION_CONFLICT'});
  await assert.rejects(()=>submitDeliveryStockRequest({...f.input,selectedRemoteLineIds:[1]},ctx,f.dependencies),{code:'REGULAR_DELIVERY_SELECTION_CONFLICT'});
  assert.equal(f.calls.confirm,1);assert.deepEqual(f.order,before);
});

test('shortage on an unchecked line does not prevent selected preview or transfer',async()=>{
  const f=fixture(),ctx=context(28),missingItem=itemId+1;
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt) VALUES($1,'Unchecked shortage fixture','EA',1,100) ON CONFLICT DO NOTHING",[missingItem]);
  await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,28,'2967',0,0,now()) ON CONFLICT DO NOTHING",[missingItem]);
  f.order.lines.push({...f.order.lines[0],remoteLineId:2,itemId:missingItem,quantity:200,backorderedQuantity:20});
  const all=await previewDeliveryStockRequest(f.input,ctx,f.dependencies);
  assert.deepEqual(all.candidates.map(line=>line.remoteLineId),[1,2]);assert.equal(all.calculationCode,'REGULAR_DELIVERY_STOCK_SHORTAGE');
  const none=await previewDeliveryStockRequest({...f.input,selectedRemoteLineIds:[]},ctx,f.dependencies);
  assert.equal(none.candidates.length,2);assert.deepEqual(none.selectedRemoteLineIds,[]);assert.equal(none.lines,undefined);
  const input={...f.input,selectedRemoteLineIds:[1]},selected=await previewDeliveryStockRequest(input,ctx,f.dependencies);
  assert.equal(selected.lines.length,1);assert.equal(selected.calculationError,undefined);
  const saved=await submitDeliveryStockRequest(input,ctx,f.dependencies);assert.equal(saved.regular.handoffStatus,'complete');assert.equal(saved.lines.length,1);
  assert.equal(saved.transfers[0].lines[0].itemId,itemId);
});

test('invalid selection cannot save a request or confirm any transfer',async()=>{
  const f=fixture(),ctx=context(28);
  for(const selectedRemoteLineIds of [[],null,'1',[1,1],[999],[true]]) {
    await assert.rejects(()=>submitDeliveryStockRequest({...f.input,selectedRemoteLineIds},ctx,f.dependencies),{code:'REGULAR_DELIVERY_SELECTION_INVALID',status:400});
  }
  assert.equal((await query('SELECT 1 FROM regular_stock_handoffs WHERE sales_order_id=$1',[f.order.id])).rowCount,0);assert.equal(f.calls.confirm,0);
});

test('preview keeps candidates for missing pallet conversion and propagates unrelated calculation failures',async()=>{
  const f=fixture(),ctx=context(28);
  await query('UPDATE inventory_items SET to_plt=NULL WHERE item_id=$1',[itemId]);
  try {
    const result=await previewDeliveryStockRequest(f.input,ctx,f.dependencies);
    assert.equal(result.candidates.length,1);assert.equal(result.calculationCode,'REGULAR_DELIVERY_PALLET_CONVERSION');
  }finally{await query('UPDATE inventory_items SET to_plt=100 WHERE item_id=$1',[itemId]);}
  f.order.lines[0].itemId=9800000999999;
  await assert.rejects(()=>previewDeliveryStockRequest(f.input,ctx,f.dependencies),{code:'STOCK_REQUEST_ITEM_NOT_FOUND'});
  assert.equal(f.calls.confirm,0);
});
