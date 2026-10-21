import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {query,closeDb,pool as dbPool} from '../../../src/db.js';
import {setTimeout as delay} from 'node:timers/promises';
import {submitWaitlistRequest,createWaitlistPool,getWaitlistPool,allocateWaitlistPool,closeWaitlistRequest,releaseWaitlistAllocation,expireWaitlistAllocations,claimWaitlistConversion,finishWaitlistConversion,getWaitlistRequest} from '../../../src/regular-waitlist-repository.js';
const actor='waitlist-fixture-'+Date.now(),customerId=9144026001,context={operatorId:actor,authorizedDestinationLocationIds:[1,28]};
let sequence=0;
before(async()=>{
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active) VALUES($1,$1,$1,'test','test','sales',ARRAY['sales','scm'],true)",[actor]);
  await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,display_name,legal_name,currency,active,source_modified_at,source_version,payload_hash) VALUES($1,'TEST-WAITLIST','TEST Waitlist Customer','TEST Waitlist Customer','CAD',true,now(),'test',repeat('a',64)) ON CONFLICT DO NOTHING",[customerId]);
});
after(closeDb);
async function fixture(quantity=5000){
  const number=++sequence,itemId=9144030000+number,poId=9144040000+number,poRef='PO-WAITLIST-TEST-'+number;
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_plt,to_pcs) VALUES($1,$2,'SQFT',100,2)",[itemId,'UNI-TEST-'+number]);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,netsuite_active,status_text,destination_location_id) VALUES($1,$2,true,'Pending Receipt',28)",[poId,poRef]);
  const line=(await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,quantity,unit,netsuite_active,location_id) VALUES($1,'1',$2,$3,$3,$4,'SQFT',true,28) RETURNING id",[poId,itemId,'UNI-TEST-'+number,quantity])).rows[0];
  const demand=(qty=1000,yard=1)=>submitWaitlistRequest({deliveryMethod:'waitlist',customerId,destinationLocationId:yard,lines:[{itemId,salesQty:qty}],operationKey:randomUUID()},context);
  const pool=await createWaitlistPool({purchaseOrderRef:poRef,itemId,operationKey:randomUUID()},context);
  return {itemId,poId,poRef,lineId:Number(line.id),pool,demand};
}
const allocate=(pool,requests,reason='')=>allocateWaitlistPool(pool.id,{expectedRevision:pool.revision,operationKey:randomUUID(),overrideReason:reason,
  selections:requests.map(([request,quantity])=>({requestId:request.id,expectedRevision:request.revision,quantity}))},context);
test('local single-item submission bypasses stock and source-yard checks and rejects invalid demand atomically',async()=>{
  const f=await fixture(),request=await f.demand();
  assert.equal(request.lines.length,1);assert.equal(request.lines[0].sourceLocationId,null);assert.equal(request.waitlist.waitingQty,1000);assert.equal(request.regular.customerId,customerId);
  await assert.rejects(()=>submitWaitlistRequest({customerId,destinationLocationId:15,lines:[{itemId:f.itemId,salesQty:1}],operationKey:randomUUID()},context),error=>error.status===403);
  await assert.rejects(()=>submitWaitlistRequest({customerId,destinationLocationId:1,lines:[{itemId:f.itemId,salesQty:1},{itemId:f.itemId,salesQty:2}],operationKey:randomUUID()},context),error=>error.status===400);
});
test('one PO serves multiple requests and duplicate allocation commands preserve balance and notices',async()=>{
  const f=await fixture(),a=await f.demand(),b=await f.demand();
  const input={expectedRevision:f.pool.revision,operationKey:randomUUID(),overrideReason:'Partial customers confirmed',selections:[{requestId:a.id,expectedRevision:a.revision,quantity:600},{requestId:b.id,expectedRevision:b.revision,quantity:400}]};
  const first=await allocateWaitlistPool(f.pool.id,input,context),again=await allocateWaitlistPool(f.pool.id,input,context);
  assert.equal(first.availableQty,4000);assert.equal(again.availableQty,4000);assert.equal(first.allocations.length,2);assert.equal(again.allocations.length,2);
  const detail=await getWaitlistRequest(a.id,context);assert.equal(detail.waitlist.heldQty,600);assert.equal(detail.waitlist.waitingQty,400);assert(detail.manualDecisionEventId>0);
});
test('closing immediately returns stock to the same pool and SCM confirms its reallocation',async()=>{
  const f=await fixture(),a=await f.demand(600),b=await f.demand(600);
  await allocate(f.pool,[[a,600]]);
  const current=await getWaitlistRequest(a.id,context);
  const input={expectedRevision:current.revision,operationKey:randomUUID(),reason:'Customer cancelled'};
  await closeWaitlistRequest(a.id,input,context);await closeWaitlistRequest(a.id,input,context);
  const returned=await getWaitlistPool(f.pool.id);assert.equal(returned.availableQty,5000);assert(returned.lastReturnEventId>0);
  assert.equal((await getWaitlistRequest(a.id,context)).waitlist.state,'closed');
  const assigned=await allocate(returned,[[b,600]]);assert.equal(assigned.availableQty,4400);
  assert.equal((await getWaitlistRequest(b.id,context)).createdAt,b.createdAt);
});
test('SCM releases a full hold only after thirty minutes with a reason',async()=>{
  const f=await fixture(),a=await f.demand(600);const assigned=await allocate(f.pool,[[a,600]]),allocation=assigned.allocations[0];
  const release=async()=>{const request=await getWaitlistRequest(a.id,context);return releaseWaitlistAllocation(allocation.id,{expectedRevision:request.revision,operationKey:randomUUID(),reason:'Sales has not confirmed'},context);};
  await assert.rejects(release,error=>error.code==='WAITLIST_RELEASE_TOO_EARLY');
  await query("UPDATE regular_waitlist_allocations SET allocated_at=now()-interval '30 minutes' WHERE id=$1",[allocation.id]);
  await release();assert.equal((await getWaitlistPool(f.pool.id)).availableQty,5000);
  const request=await getWaitlistRequest(a.id,context);assert.equal(request.waitlist.waitingQty,600);assert.equal(request.createdAt,a.createdAt);
});
test('three-hour release waits for another unallocated same-item demand and handles late demand',async()=>{
  const f=await fixture(),a=await f.demand(1000);const assigned=await allocate(f.pool,[[a,600]]);
  await query("UPDATE regular_waitlist_allocations SET allocated_at=now()-interval '4 hours' WHERE id=$1",[assigned.allocations[0].id]);
  await expireWaitlistAllocations();assert.equal((await getWaitlistRequest(a.id,context)).waitlist.heldQty,600);
  const b=await f.demand(200);await expireWaitlistAllocations();
  assert.equal((await getWaitlistRequest(a.id,context)).waitlist.heldQty,0);assert.equal((await getWaitlistRequest(b.id,context)).waitlist.heldQty,0);
  assert.equal((await getWaitlistPool(f.pool.id)).availableQty,5000);
});
test('partial conversion commits only allocated quantity and preserves the original remaining waitlist',async()=>{
  const f=await fixture(),a=await f.demand(1000);await allocate(f.pool,[[a,600]]);
  const current=await getWaitlistRequest(a.id,context),operation=await claimWaitlistConversion(a.id,{expectedRevision:current.revision,operationKey:randomUUID(),fulfillmentMethod:'pickup',remainderAction:'keep'},context);
  assert.equal(operation.quantity,600);
  await assert.rejects(()=>closeWaitlistRequest(a.id,{expectedRevision:operation.requestRevision,operationKey:randomUUID(),reason:'Cannot race conversion'},context),error=>error.code==='WAITLIST_CONVERSION_BUSY');
  await finishWaitlistConversion(operation.id,{salesOrderId:9914401,salesOrderRef:'SO-WAITLIST-TEST-1'});
  const converted=await getWaitlistRequest(a.id,context);assert.equal(converted.waitlist.convertedQty,600);assert.equal(converted.waitlist.waitingQty,400);assert.equal(converted.createdAt,a.createdAt);
  await closeWaitlistRequest(a.id,{expectedRevision:converted.revision,operationKey:randomUUID(),reason:'Close remainder'},context);
  assert.equal((await getWaitlistPool(f.pool.id)).availableQty,4400);
});
test('real concurrent SCM allocations cannot overbook the PO or partially commit a stale batch',async()=>{
  const f=await fixture(1000),a=await f.demand(1000),b=await f.demand(1000);
  // A competing local write holds both requests while the two SCM commands start.
  // This makes both commands overlap instead of relying on incidental scheduling.
  const blocker=await dbPool.connect();let results;
  try{
    await blocker.query('BEGIN');await blocker.query('SELECT id FROM sales_stock_requests WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE',[[a.id,b.id]]);
    const running=Promise.allSettled([allocate(f.pool,[[a,800]]),allocate(f.pool,[[b,800]],'Confirmed customer')]);
    let waiting=0;
    for(let attempt=0;attempt<100;attempt++){
      waiting=Number((await query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE '%FOR UPDATE OF r,w%' OR query LIKE '%pg_advisory_xact_lock%')")).rows[0].n);
      if(waiting===2)break;await delay(20);
    }
    assert.equal(waiting,2,'Both allocation commands must overlap');await blocker.query('COMMIT');results=await running;
  }finally{await blocker.query('ROLLBACK');blocker.release();}
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const pool=await getWaitlistPool(f.pool.id);assert.equal(pool.heldQty,800);assert.equal(pool.availableQty,200);
});
