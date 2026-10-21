import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before, after } from 'node:test';
import fc from 'fast-check';
import { query, pool } from '../../../src/db.js';
import { createDispatchPlan } from '../../../src/dispatch-plan-repository.js';
import { getDispatchSplitPreview } from '../../../src/dispatch-split-preview-repository.js';
import { syncDispatchGlobalOrderSplitsFromPlan } from '../../../src/dispatch-delivery-group-repository.js';
import { materializeSalesSplitOrder, getNextDispatchSplitSuffix } from '../../../src/delivery-repository.js';
import { unsplitSalesOrder } from '../../../src/dispatch-sales-resplit-repository.js';
import { previewOperatorOrderReopen, reopenOperatorOrder } from '../../../src/operator-order-reopen-repository.js';
import { createOperator } from '../../../src/auth-repository.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from '../../../src/dispatch-fleet-status.js';
import { createDispatchV2Fixture } from '../support/dispatch-v2-fixture.js';
import { seedSalesOrder, scenario } from '../support/fulfilled-so-fixture.js';

let http;
before(async()=>{http=await createDispatchV2Fixture();});
after(async()=>http?.close());
const blocked=error=>error.status===409 && error.code==='DISPATCH_SPLIT_ALLOCATED' && /unlink.*(?:PO|TO)/iu.test(error.message);

async function root({pieces=22,quantity=88,converted=false}={}){
 const id=12_000_000_000+Number.parseInt(crypto.randomBytes(4).toString('hex'),16),ref=`SO-SPLIT-GUARD-${id}`;
 await seedSalesOrder(id,ref,{status:'B'});
 await query(`UPDATE sales_order_lines SET item_type='NonInvtPart',quantity=$2,pallet_qty=0,piece_qty=$3,
   to_plt=0,to_lyr=0,to_sec=0,to_pcs=$4 WHERE sales_order_id=$1`,[id,quantity,pieces,converted?quantity/pieces:0]);
 const preview=await getDispatchSplitPreview({orderRef:ref,type:'SO'});
 const plan=await createDispatchPlan({planDate:'2098-10-15'});
 const source={...preview,sourceTable:'sales_orders',customer:'Split guard',sourceYard:'3445',pickupLocations:['3445'],
   address:'Test Road',destinationAddress:'Test Road',netsuiteId:String(id)};
 const parts=[1,2].map(n=>({...source,id:`${ref}-S${n}`,originalOrderId:ref,netsuiteId:'',items:source.items.map(item=>({...item,quantity:quantity/2,pieces:0}))}));
 return {id,ref,source,parts,plan};
}
async function po(f,target=f.ref,execute=query){
 const poId=f.id+1;
 await execute("INSERT INTO purchase_orders(netsuite_id,tranid,vendor,status,netsuite_active) VALUES($1,$2,'Split guard','pendingReceipt',true)",[poId,`PO-${f.id}`]);
 const line=(await execute("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,quantity,netsuite_active) VALUES($1,1,817159900,'Cargo',100,true) RETURNING id",[poId])).rows[0];
 return (await execute(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,
   allocated_sales_qty,dispatch_target_ref,dispatch_target_kind,dispatch_target_line_key) VALUES($1,$2,$1,$3,$4,$5,1,$6,'normal',$6||'::'||$2||'::1') RETURNING id`,
 [f.id,f.ref,poId,`PO-${f.id}`,line.id,target])).rows[0].id;
}
async function to(f,status='active'){
 const toId=f.id+2;
 await query("INSERT INTO transfer_orders(netsuite_id,tranid,netsuite_active) VALUES($1,$2,true)",[toId,`TO-${f.id}`]);
 return (await query(`INSERT INTO order_dependencies(sales_order_id,sales_order_ref,transfer_order_id,transfer_order_ref,
   source_location_id,source_location,accounting_destination_location_id,status,dispatch_target_ref)
   VALUES($1,$2,$3,$4,1,'3445',26,$5,$2) RETURNING id`,[f.id,f.ref,toId,`TO-${f.id}`,status])).rows[0].id;
}
const publish=f=>syncDispatchGlobalOrderSplitsFromPlan({...f.plan,orders:f.parts,trucks:[]});
async function materialize(f){
 for(const part of f.parts) part.netsuiteId=String(await materializeSalesSplitOrder(part,{netsuite_id:f.id}));
 await publish(f);
 await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb WHERE plan_id=$1',[f.plan.id,JSON.stringify(f.parts)]);
}
const unsplit=f=>unsplitSalesOrder({orderRef:f.parts[0].id,planId:f.plan.id,planDate:f.plan.planDate});
const family=f=>query('SELECT split_ref,active,full_order FROM dispatch_global_order_splits WHERE parent_order_ref=$1 ORDER BY split_ref',[f.ref]).then(r=>r.rows);

for(const kind of ['PO','TO']){
 test(`${kind} allocation blocks split preview and seed with unlink instructions`,()=>scenario(async()=>{
  const f=await root();await (kind==='PO'?po(f):to(f));
  await assert.rejects(getDispatchSplitPreview({orderRef:f.ref,type:'SO'}),blocked);
  await assert.rejects(getNextDispatchSplitSuffix({originalOrderId:f.ref,orderType:'SO'}),blocked);
 }));
 test(`${kind} allocation blocks initial split persistence without partial definitions`,()=>scenario(async()=>{
  const f=await root();await (kind==='PO'?po(f):to(f));
  await assert.rejects(publish(f),blocked);
  assert.deepEqual(await family(f),[]);
 }));
}

test('cancelled PO and TO links allow splitting; established linked children can be saved unchanged',()=>scenario(async()=>{
 const f=await root(),p=await po(f),t=await to(f);
 await query("UPDATE dispatch_so_po_allocations SET status='cancelled' WHERE id=$1",[p]);
 await query("UPDATE order_dependencies SET status='cancelled' WHERE id=$1",[t]);
 await publish(f);assert.equal((await family(f)).length,2);
 await query("UPDATE dispatch_so_po_allocations SET status='active',dispatch_target_ref=$2 WHERE id=$1",[p,f.parts[0].id]);
 await publish(f);assert.equal((await family(f)).length,2);
}));

test('non-cancelled TO states and legacy PO targets cannot bypass the blocker',()=>scenario(async()=>{
 const f=await root(),t=await to(f);
 for(const status of ['packed','loaded','in_transit','delivered','received_local','attention']){
  await query('UPDATE order_dependencies SET status=$2 WHERE id=$1',[t,status]);
  await assert.rejects(publish(f),blocked);
 }
 await query("UPDATE order_dependencies SET status='cancelled' WHERE id=$1",[t]);
 const p=await po(f);await query("UPDATE dispatch_so_po_allocations SET dispatch_target_ref='' WHERE id=$1",[p]);
 await assert.rejects(publish(f),blocked);
}));

test('editing established split quantities with a PO link is blocked while a harmless refresh is allowed',()=>scenario(async()=>{
 const f=await root();await publish(f);await po(f,f.parts[0].id);
 const before=await family(f);
 await publish(f);
 f.parts[0].items[0].quantity-=1;f.parts[1].items[0].quantity+=1;
 await assert.rejects(publish(f),blocked);
 assert.deepEqual((await family(f)).map(r=>r.full_order.items),before.map(r=>r.full_order.items));
}));

test('HTTP rejects a PO-linked split preview and a direct stale plan save',async()=>{
 const f=await root();await po(f);
 const preview=await http.request(`/api/dispatch/orders/${f.ref}/split-preview?type=SO`);
 assert.equal(preview.response.status,409);assert.match(preview.payload.error,/unlink/iu);
 const sessionId=`split-http-${f.id}`,lease=await http.acquireLease({planDate:f.plan.planDate,sessionId});
 const response=await http.request(`/api/dispatch/plans/${f.plan.id}`,{method:'PUT',headers:{'x-dispatch-edit-lease':lease},body:{
  planDate:f.plan.planDate,baseRevision:f.plan.revision,baseDigest:f.plan.digest,orders:f.parts,trucks:[],summary:{},audit:{sessionId}}});
 assert.equal(response.response.status,409,JSON.stringify(response.payload));
 assert.match(JSON.stringify(response.payload),/DISPATCH_SPLIT_ALLOCATED/u);
 assert.deepEqual(await family(f),[]);
});

test('a link committed while split persistence waits on the fleet lock wins without partial writes',async()=>{
 const f=await root(),client=await pool.connect();let pending;
 try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
  const pid=(await client.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  pending=publish(f);const rejected=assert.rejects(pending,blocked);rejected.catch(()=>undefined);
  let waiting=false;
  for(let n=0;n<100;n++){
   await query('SELECT pg_stat_clear_snapshot()');
   waiting=(await query("SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND wait_event='advisory'",[pid])).rowCount>0;
   if(waiting)break;await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(waiting,true,'Split persistence must serialize with allocation commands');
  await po(f,f.ref,(sql,args)=>client.query(sql,args));
  await client.query('COMMIT');await rejected;
  assert.deepEqual(await family(f),[]);
 }finally{await client.query('ROLLBACK');client.release();await pending?.catch(()=>undefined);}
});

test('unsplit restores the original descriptive pieces omitted by a legacy sales-only split',()=>scenario(async()=>{
 const f=await root();await materialize(f);
 const before=(await query('SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id',[f.id])).rows;
 const result=await unsplit(f);
 assert.equal(result.restoredOrder.items[0].quantity,88);assert.equal(result.restoredOrder.items[0].pieces,22);
 assert.ok((await family(f)).every(r=>!r.active));
 assert.deepEqual((await query('SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id',[f.id])).rows,before);
}));

test('property: legacy sales-only unsplit conserves original sales and descriptive pieces over arbitrary partitions',()=>scenario(async()=>{
 await fc.assert(fc.asyncProperty(fc.integer({min:2,max:40}),fc.integer({min:1,max:99}),async(pieces,percent)=>scenario(async()=>{
  const quantity=pieces*4,f=await root({pieces,quantity});
  f.parts[0].items[0].quantity=quantity*percent/100;f.parts[1].items[0].quantity=quantity-f.parts[0].items[0].quantity;
  await materialize(f);const result=await unsplit(f);
  assert.equal(result.restoredOrder.items[0].quantity,quantity);assert.equal(result.restoredOrder.items[0].pieces,pieces);
 })),{seed:20261015,numRuns:12}).catch(error=>{console.error('Property cause:',error.cause);throw error;});
}));

test('converted packing quantities and actual sales shortages still block unsplit atomically',()=>scenario(async()=>{
 for(const converted of [true,false]) await scenario(async()=>{
  const f=await root({converted});
  if(!converted)f.parts[0].items[0].quantity-=1;
  await materialize(f);const before=await family(f);
  await assert.rejects(unsplit(f),{code:'DISPATCH_SPLIT_QUANTITY_INVALID'});
  assert.deepEqual(await family(f),before);
 });
}));

test('unknown child line cannot be discarded by unsplit even when known source quantities balance',()=>scenario(async()=>{
 const f=await root({pieces:0});f.parts[0].items.push({...f.parts[0].items[0],lineId:999,itemId:12345,quantity:1});
 await materialize(f);const before=await family(f);
 await assert.rejects(unsplit(f),{code:'DISPATCH_SPLIT_QUANTITY_INVALID'});
 assert.deepEqual(await family(f),before);
}));

test('unsplit immediately returns authoritative local-open flags for an audited Billed parent',()=>scenario(async()=>{
 const f=await root();await query("UPDATE sales_orders SET status='G',status_text='Sales Order : Billed' WHERE netsuite_id=$1",[f.id]);
 const actor=await createOperator({username:`split-admin-${f.id}`,displayName:'Split admin',role:'admin',password:'isolated-split-admin-password'});
 const preview=await previewOperatorOrderReopen({orderRef:f.ref,actor});
 await reopenOperatorOrder({orderRef:f.ref,actor,reason:'Isolated local reopen unsplit regression',requestId:crypto.randomUUID(),expectedStateHash:preview.stateHash});
 f.parts=f.parts.map(part=>({...part,localOrderReopened:false,dispatchCompletionStatus:'completed'}));
 await materialize(f);const result=await unsplit(f);
 assert.equal(result.restoredOrder.localOrderReopened,true);
 assert.equal(result.restoredOrder.dispatchCompletionStatus,'');
 assert.equal(result.restoredOrder.dispatchFulfilledSalesPlanningEligible,true);
 assert.equal((await query('SELECT status FROM sales_orders WHERE netsuite_id=$1',[f.id])).rows[0].status,'G');
}));
