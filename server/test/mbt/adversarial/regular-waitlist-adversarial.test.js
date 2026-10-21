import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {createWaitlistFixture} from '../../support/regular-waitlist-fixture.mjs';
import {waitlistQuantity,waitlistId} from '../../../src/regular-waitlist-domain.js';
import {submitWaitlistRequest,getWaitlistRequest,getWaitlistPool,createWaitlistPool,claimWaitlistConversion,expireWaitlistAllocations,allocateWaitlistPool,closeWaitlistRequest,acknowledgeWaitlistPool} from '../../../src/regular-waitlist-repository.js';
import {processWaitlistConversion} from '../../../src/regular-waitlist-service.js';
let f;before(async()=>{f=await createWaitlistFixture();});after(closeDb);
test('quantity and identity parsers reject coerced booleans, arrays and objects',()=>{
  for(const value of [true,[100],{valueOf:()=>100}])assert.throws(()=>waitlistQuantity(value));
  for(const value of [true,[1],{valueOf:()=>1}])assert.throws(()=>waitlistId(value));
});
test('an in-progress competitor with unallocated remainder still creates demand for expired holds',async()=>{
  const s=await f.supply(),a=await s.demand(600),b=await s.demand(1000);let pool=await f.allocate(s.pool,[[a,600]]);
  pool=await f.allocate(pool,[[b,500]],'Customer has confirmed their partial order');
  const current=await getWaitlistRequest(b.id,f.context);await claimWaitlistConversion(b.id,{expectedRevision:current.revision,operationKey:randomUUID(),fulfillmentMethod:'pickup'},f.context);
  await query("UPDATE regular_waitlist_allocations SET allocated_at=now()-interval '4 hours' WHERE request_id=$1",[a.id]);
  await expireWaitlistAllocations();assert.equal((await getWaitlistRequest(a.id,f.context)).waitlist.heldQty,0);
  assert.equal((await getWaitlistRequest(b.id,f.context)).waitlist.heldQty,500);
});
test('close racing conversion commits exactly one outcome and cannot return SO-held quantity',async()=>{
  const s=await f.supply(),a=await s.demand(600);await f.allocate(s.pool,[[a,600]]);const r=await getWaitlistRequest(a.id,f.context);
  const results=await Promise.allSettled([claimWaitlistConversion(a.id,{expectedRevision:r.revision,operationKey:randomUUID(),fulfillmentMethod:'pickup'},f.context),closeWaitlistRequest(a.id,{expectedRevision:r.revision,operationKey:randomUUID(),reason:'Sales cancellation'},f.context)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const saved=await getWaitlistRequest(a.id,f.context),pool=await getWaitlistPool(s.pool.id);
  assert.equal(saved.waitlist.state==='closed'?pool.availableQty:pool.heldQty,saved.waitlist.state==='closed'?5000:600);
});
test('concurrent conversion workers submit exactly once and uncertain lease recovery never posts again',async()=>{
  const s=await f.supply(),a=await s.demand(600);await f.allocate(s.pool,[[a,600]]);const r=await getWaitlistRequest(a.id,f.context);
  const operation=await claimWaitlistConversion(a.id,{expectedRevision:r.revision,operationKey:randomUUID(),fulfillmentMethod:'pickup'},f.context);let posts=0;
  const boundary={prepare:async()=>({externalId:'test'}),post:async()=>{posts++;},find:async()=>null};
  await Promise.all([processWaitlistConversion(operation.id,boundary),processWaitlistConversion(operation.id,boundary)]);assert.equal(posts,1);
  await query("UPDATE regular_waitlist_conversions SET lease_until=now()-interval '1 second' WHERE id=$1",[operation.id]);await processWaitlistConversion(operation.id,boundary);assert.equal(posts,1);
});
test('idempotency key reuse with different quantities fails without additional writes or notices',async()=>{
  const s=await f.supply(),a=await s.demand(1000),input={operationKey:randomUUID(),expectedRevision:s.pool.revision,selections:[{requestId:a.id,expectedRevision:a.revision,quantity:500}]};
  await allocateWaitlistPool(s.pool.id,input,f.context);
  await assert.rejects(()=>allocateWaitlistPool(s.pool.id,{...input,selections:[{...input.selections[0],quantity:501}]},f.context),error=>error.code==='WAITLIST_IDEMPOTENCY_CONFLICT');
  assert.equal((await getWaitlistPool(s.pool.id)).allocations.length,1);
});
test('returned-pool read acknowledges only the displayed event and removes the persistent notification',async()=>{
  const s=await f.supply(),a=await s.demand(600);await f.allocate(s.pool,[[a,600]]);const r=await getWaitlistRequest(a.id,f.context);
  await closeWaitlistRequest(a.id,{expectedRevision:r.revision,operationKey:randomUUID(),reason:'Customer withdrew'},f.context);
  const returned=await getWaitlistPool(s.pool.id,f.context);assert.equal(returned.returnedUnread,true);
  await assert.rejects(()=>acknowledgeWaitlistPool(s.pool.id,{eventId:returned.lastReturnEventId+1},f.context));
  await acknowledgeWaitlistPool(s.pool.id,{eventId:returned.lastReturnEventId},f.context);
  assert.equal((await getWaitlistPool(s.pool.id,f.context)).returnedUnread,false);
});
test('a split of a split cannot duplicate capacity already reserved on an ancestor branch',async()=>{
  const s=await f.supply(1000);
  async function split(parentId,parentRef,parentLine,number,quantity){
    const id=s.poId+1000000+number,ref=s.poRef+'-NEST-'+number;
    await query("INSERT INTO purchase_orders(netsuite_id,tranid,netsuite_active,status_text) VALUES($1,$2,true,'Pending Receipt')",[id,ref]);
    const line=(await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,quantity,unit,netsuite_active) VALUES($1,'1',$2,'UNI-NEST', $3,'SQFT',true) RETURNING id",[id,s.itemId,quantity])).rows[0];
    const header=(await query('INSERT INTO dispatch_scm_po_splits(source_po_id,source_po_ref,split_po_id,split_po_ref) VALUES($1,$2,$3,$4) RETURNING id',[parentId,parentRef,id,ref])).rows[0];
    await query("INSERT INTO dispatch_scm_po_split_lines(split_id,source_line_id,split_line_id,item_id,sales_qty,unit) VALUES($1,$2,$3,$4,$5,'SQFT')",[header.id,parentLine,line.id,s.itemId,quantity]);return {id,ref,lineId:Number(line.id)};
  }
  const child=await split(s.poId,s.poRef,s.lineId,1,600),pool=await createWaitlistPool({purchaseOrderRef:child.ref,itemId:s.itemId,operationKey:randomUUID()},f.context),a=await s.demand(500);
  await f.allocate(pool,[[a,500]]);const grandchild=await split(child.id,child.ref,child.lineId,2,300);
  await assert.rejects(()=>createWaitlistPool({purchaseOrderRef:grandchild.ref,itemId:s.itemId,operationKey:randomUUID()},f.context),error=>error.code==='WAITLIST_PO_UNAVAILABLE');
  assert.equal((await getWaitlistRequest(a.id,f.context)).waitlist.heldQty,500);
});
test('a later item sales-unit change cannot allocate an old SQFT request from a new EA pool',async()=>{
  const s=await f.supply(),a=await s.demand(600),id=s.poId+2000000,ref=s.poRef+'-EA';
  await query("UPDATE inventory_items SET stock_unit='EA' WHERE item_id=$1",[s.itemId]);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,netsuite_active,status_text) VALUES($1,$2,true,'Pending Receipt')",[id,ref]);
  await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,quantity,unit,netsuite_active) VALUES($1,'1',$2,'UNIT CHANGED',1000,'EA',true)",[id,s.itemId]);
  const pool=await createWaitlistPool({purchaseOrderRef:ref,itemId:s.itemId,operationKey:randomUUID()},f.context);
  await assert.rejects(()=>f.allocate(pool,[[a,600]]),error=>error.code==='WAITLIST_DEMAND_UNIT_MISMATCH');
  assert.equal((await getWaitlistRequest(a.id,f.context)).waitlist.heldQty,0);
});
test('known non-inventory items cannot become ordinary waitlist demand',async()=>{
  const s=await f.supply();await query("UPDATE inventory_items SET item_type='NonInvtPart' WHERE item_id=$1",[s.itemId]);
  await assert.rejects(()=>submitWaitlistRequest({customerId:f.customerId,destinationLocationId:1,lines:[{itemId:s.itemId,salesQty:100}],operationKey:randomUUID()},f.context),error=>error.code==='WAITLIST_ITEM_INVALID');
});
