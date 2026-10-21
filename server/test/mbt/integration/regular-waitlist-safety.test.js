import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {createWaitlistFixture} from '../../support/regular-waitlist-fixture.mjs';
import {getWaitlistPool,getWaitlistRequest,createWaitlistPool,closeWaitlistRequest,expireWaitlistAllocations,claimWaitlistConversion,finishWaitlistConversion} from '../../../src/regular-waitlist-repository.js';
import {processWaitlistConversion,createWaitlistRuntime} from '../../../src/regular-waitlist-service.js';
import {regularStockAlerts,acknowledgeRegularStockDecisions} from '../../../src/regular-stock-request-service.js';
let f;before(async()=>{f=await createWaitlistFixture();});after(closeDb);
async function conversion(supply,quantity=600){const demand=await supply.demand(1000);await f.allocate(supply.pool,[[demand,quantity]]);const request=await getWaitlistRequest(demand.id,f.context);return claimWaitlistConversion(request.id,{expectedRevision:request.revision,operationKey:randomUUID(),fulfillmentMethod:'pickup',remainderAction:'keep'},f.context);}
test('selling-yard priority is independent of PO yard and bypass needs a reason',async()=>{
  for(const [prefix,preferred] of [['UNI',1],['BWS',1],['PER',28],['TH',28]]){
    const s=await f.supply(1000,prefix),older=await s.demand(500,preferred===1?28:1),newer=await s.demand(500,preferred);
    const pool=await getWaitlistPool(s.pool.id);assert.equal(pool.requests[0].id,newer.id);
    await assert.rejects(()=>f.allocate(pool,[[older,500]]),error=>error.code==='WAITLIST_PRIORITY_OVERRIDE_REQUIRED');
    const allocated=await f.allocate(pool,[[older,500]],'Customer promised today');assert.equal(allocated.allocations[0].overrideReason,'Customer promised today');
  }
});
test('parent and split PO capacities share the source and never read Dispatch SO allocations',async()=>{
  const s=await f.supply(1000),splitId=s.poId+1000000,splitRef=s.poRef+'-1';
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,netsuite_active,status_text,destination_location_id) VALUES($1,$2,$2,true,'Pending Receipt',1)",[splitId,splitRef]);
  const child=(await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,quantity,unit,netsuite_active,location_id) VALUES($1,'1',$2,'UNI-SPLIT',600,'SQFT',true,1) RETURNING id",[splitId,s.itemId])).rows[0];
  const split=(await query("INSERT INTO dispatch_scm_po_splits(source_po_id,source_po_ref,split_po_id,split_po_ref) VALUES($1,$2,$3,$4) RETURNING id",[s.poId,s.poRef,splitId,splitRef])).rows[0];
  await query('INSERT INTO dispatch_scm_po_split_lines(split_id,source_line_id,split_line_id,item_id,sales_qty,unit) VALUES($1,$2,$3,$4,600,\'SQFT\')',[split.id,s.lineId,child.id,s.itemId]);
  const parent=await getWaitlistPool(s.pool.id),childPool=await createWaitlistPool({purchaseOrderRef:splitRef,itemId:s.itemId,operationKey:randomUUID()},f.context);
  assert.equal(parent.availableQty,400);assert.equal(childPool.availableQty,600);
  const a=await s.demand(1000);await f.allocate(parent,[[a,400]]);const updated=await getWaitlistRequest(a.id,f.context);await f.allocate(childPool,[[updated,600]]);
  assert.equal((await getWaitlistPool(parent.id)).availableQty,0);assert.equal((await getWaitlistPool(childPool.id)).availableQty,0);
  const total=(await query("SELECT SUM(quantity) AS qty FROM regular_waitlist_allocations WHERE request_id=$1 AND status='reserved'",[a.id])).rows[0];assert.equal(Number(total.qty),1000);
});
test('quantity reductions and PO cancellation block conversion without losing reservations',async()=>{
  const s=await f.supply(1000),a=await s.demand(800);await f.allocate(s.pool,[[a,800]]);
  await query('UPDATE purchase_order_lines SET quantity=500 WHERE id=$1',[s.lineId]);const pool=await getWaitlistPool(s.pool.id);assert(pool.attention);assert.equal(pool.availableQty,0);
  const request=await getWaitlistRequest(a.id,f.context);
  await assert.rejects(()=>claimWaitlistConversion(a.id,{expectedRevision:request.revision,operationKey:randomUUID(),fulfillmentMethod:'pickup'},f.context),error=>error.code==='WAITLIST_PO_UNAVAILABLE');
  assert.equal((await getWaitlistRequest(a.id,f.context)).waitlist.heldQty,800);
  await query("UPDATE purchase_orders SET status_text='Cancelled' WHERE netsuite_id=$1",[s.poId]);assert((await getWaitlistPool(s.pool.id)).attention);
});
test('uncertain NetSuite response never reposts and preserves held stock until marker recovery',async()=>{
  const s=await f.supply(),operation=await conversion(s);let posts=0,visible=false;
  const boundary={prepare:async()=>({externalId:'test'}),post:async()=>{posts++;throw new Error('Lost response after creation');},find:async()=>visible?{salesOrderId:995001,salesOrderRef:'SO-RECOVERED'}:null};
  assert.equal((await processWaitlistConversion(operation.id,boundary)).status,'uncertain');
  await query("UPDATE regular_waitlist_allocations SET allocated_at=now()-interval '4 hours' WHERE conversion_id=$1",[operation.id]);await s.demand(100);
  await expireWaitlistAllocations();assert.equal((await getWaitlistRequest(operation.requestId,f.context)).waitlist.heldQty,600);
  await processWaitlistConversion(operation.id,boundary);assert.equal(posts,1);visible=true;
  const recovered=await processWaitlistConversion(operation.id,boundary);assert.equal(recovered.status,'completed');assert.equal(posts,1);
  const closed=await getWaitlistRequest(operation.requestId,f.context);assert.equal(closed.waitlist.convertedQty,600);
});
test('preparation failures retain the reservation and a later conversion uses a different marker',async()=>{
  const s=await f.supply(),operation=await conversion(s);let posts=0;
  assert.equal((await processWaitlistConversion(operation.id,{prepare:async()=>{throw new Error('Unit verification unavailable');},post:async()=>{posts++;}})).status,'failed');
  assert.equal(posts,0);let request=await getWaitlistRequest(operation.requestId,f.context);assert.equal(request.waitlist.heldQty,600);
  const next=await claimWaitlistConversion(request.id,{expectedRevision:request.revision,operationKey:randomUUID(),fulfillmentMethod:'pickup',remainderAction:'keep'},f.context);assert.notEqual(next.id,operation.id);
  await finishWaitlistConversion(next.id,{salesOrderId:995002,salesOrderRef:'SO-SECOND-TRY'});request=await getWaitlistRequest(request.id,f.context);
  await f.allocate(await getWaitlistPool(s.pool.id),[[request,400]]);request=await getWaitlistRequest(request.id,f.context);
  const final=await claimWaitlistConversion(request.id,{expectedRevision:request.revision,operationKey:randomUUID(),fulfillmentMethod:'pickup',remainderAction:'close'},f.context);
  await finishWaitlistConversion(final.id,{salesOrderId:995003,salesOrderRef:'SO-REMAINDER'});
  const saved=await getWaitlistRequest(request.id,f.context);assert.equal(saved.waitlist.convertedQty,1000);assert.equal(saved.waitlist.waitingQty,0);assert.equal((await getWaitlistPool(s.pool.id)).convertedQty,1000);
});
test('allocation notices stay unread once per event and case acknowledgement clears them',async()=>{
  const s=await f.supply(),a=await s.demand(600);await f.allocate(s.pool,[[a,600]]);const current=await getWaitlistRequest(a.id,f.context);
  const alerts=await regularStockAlerts(f.context);assert(alerts.requests.some(r=>r.id===a.id));
  await acknowledgeRegularStockDecisions(a.id,{eventId:current.manualDecisionEventId},f.context);
  await acknowledgeRegularStockDecisions(a.id,{eventId:current.manualDecisionEventId},f.context);
  assert.equal((await regularStockAlerts(f.context)).requests.some(r=>r.id===a.id),false);
});
test('startup catch-up releases eligible stock once and never allocates returned quantities silently',async()=>{
  const s=await f.supply(),a=await s.demand(600);await f.allocate(s.pool,[[a,600]]);await s.demand(100);
  await query("UPDATE regular_waitlist_allocations SET allocated_at=now()-interval '3 hours' WHERE request_id=$1",[a.id]);
  const emitted=[],runtime=createWaitlistRuntime({remoteEnabled:false,emit:e=>emitted.push(e),log:message=>assert.fail(message)});
  await runtime.tick();await runtime.tick();assert.equal(emitted.length,1);assert.equal((await getWaitlistPool(s.pool.id)).heldQty,0);
  assert.equal((await getWaitlistRequest(a.id,f.context)).waitlist.state,'waiting');
});
test('a slow NetSuite conversion does not delay the fifteen-second local expiry checks',async()=>{
  const s=await f.supply(),a=await s.demand(600),b=await s.demand(1000);let pool=await f.allocate(s.pool,[[a,600]]);
  await f.allocate(pool,[[b,500]],'Confirmed partial order');const current=await getWaitlistRequest(b.id,f.context);
  await claimWaitlistConversion(b.id,{expectedRevision:current.revision,operationKey:randomUUID(),fulfillmentMethod:'pickup'},f.context);
  let releaseRemote,started;const remote=new Promise(resolve=>{releaseRemote=resolve;}),running=new Promise(resolve=>{started=resolve;});
  const runtime=createWaitlistRuntime({remoteEnabled:true,processConversion:async()=>{started();await remote;},log:message=>assert.fail(message)});
  const first=runtime.tick();await running;
  try{await query("UPDATE regular_waitlist_allocations SET allocated_at=now()-interval '4 hours' WHERE request_id=$1",[a.id]);await runtime.tick();
    assert.equal((await getWaitlistRequest(a.id,f.context)).waitlist.heldQty,0);
  }finally{releaseRemote();await first;runtime.stop();}
});
