import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import * as ledger from '../../../src/regular-waitlist-repository.js';
import {createWaitlistFixture} from '../../support/regular-waitlist-fixture.mjs';
import {regularStockAlerts,acknowledgeRegularStockDecisions} from '../../../src/regular-stock-request-service.js';
let f,sequence=0;
before(async()=>{f=await createWaitlistFixture();});after(closeDb);
async function queuedPo(s,{status='Queued',active=true,closed=false,received=false,split=false,inactiveSplit=false,day=1}={}){
  const id=9344040000+(++sequence),ref='PO-RECENT-'+sequence,date=`2026-09-${String(day).padStart(2,'0')}`;
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,netsuite_active,status_text,initial_scm_status,synced_at,expected_delivery_date) VALUES($1,$2,$3,$4,'Pending Receipt','Queued',$5::timestamptz,'2026-10-20')",[id,ref,split?ref+'-S1':null,active,date]);
  const actual=split?ref+'-S1':ref;
  const line=(await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,quantity,unit,netsuite_active,netsuite_closed,netsuite_received_qty) VALUES($1,'1',$2,'TEST','TEST',500,'SQFT',true,$3,$4) RETURNING id",[id,s.itemId,closed,received?500:0])).rows[0];
  await query("INSERT INTO scm_transport_schedule(order_kind,source_table,source_id,order_ref,status,created_at,eta_date) VALUES('PO','purchase_orders',$1,$2,$3,$4::timestamptz,'2026-10-15')",[id,actual,status,date]);
  if(split){const header=(await query('INSERT INTO dispatch_scm_po_splits(source_po_id,source_po_ref,split_po_id,split_po_ref,status) VALUES($1,$2,$3,$4,$5) RETURNING id',[s.poId,s.poRef,id,actual,inactiveSplit?'cancelled':'active'])).rows[0];
    await query('INSERT INTO dispatch_scm_po_split_lines(split_id,source_line_id,split_line_id,item_id,sales_qty,unit) VALUES($1,$2,$3,$4,500,\'SQFT\')',[header.id,s.lineId,line.id,s.itemId]);}
  return {id,ref:actual};
}
const reject=(request,reason='Not being produced soon',key=randomUUID())=>ledger.rejectWaitlistRequest(request.id,{operationKey:key,expectedRevision:request.revision,reason},{operatorId:f.actor});
test('waiting rows expose canonical vendor and only the three most recent queued source/split POs',async()=>{
  const s=await f.supply(),request=await s.demand();
  await query("UPDATE inventory_items SET vendor_id=751,vendor='Vendor A',display_name='Customer item' WHERE item_id=$1",[s.itemId]);
  const oldest=await queuedPo(s,{day:1}),second=await queuedPo(s,{day:2}),third=await queuedPo(s,{day:3,split:true}),latest=await queuedPo(s,{day:4});
  for(const options of [{status:'Planned'},{status:'Hold'},{status:'Completed'},{status:'Cancelled'},{active:false},{closed:true},{received:true},{split:true,inactiveSplit:true}])await queuedPo(s,{...options,day:20});
  await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,quantity,unit,netsuite_active) VALUES($1,'2',$2,'TEST',1,'SQFT',true)",[latest.id,s.itemId]);
  const row=(await ledger.listWaitlistRequests()).find(r=>r.id===request.id);
  assert.equal(row.vendorId,751);assert.equal(row.vendorName,'Vendor A');assert.equal(row.vendorKey,'751');assert.equal(row.itemDisplayName,'Customer item');
  assert.deepEqual(row.recentQueuedPurchaseOrders.map(p=>p.ref),[latest.ref,third.ref,second.ref]);
  assert.equal(row.recentQueuedPurchaseOrders.some(p=>p.ref===oldest.ref),false);
  assert.equal(row.recentQueuedPurchaseOrders[1].sourceRef,s.poRef);assert.equal(row.recentQueuedPurchaseOrders[1].isSplit,true);
  assert.equal(String(row.recentQueuedPurchaseOrders[0].eta).slice(0,10),'2026-10-15');
  assert.equal((await ledger.getWaitlistPool(s.pool.id)).allocations.length,0);
});
test('SCM rejection immediately returns unused stock and retries notify Sales only once',async()=>{
  const s=await f.supply(),request=await s.demand(600);await f.allocate(s.pool,[[request,600]]);
  const current=await ledger.getWaitlistRequest(request.id),key=randomUUID();
  const result=await reject(current,'No production this season',key),again=await reject(current,'No production this season',key);
  assert.equal(result.waitlist.state,'closed');assert.equal(result.waitlist.closureType,'rejected');assert.equal(again.waitlist.heldQty,0);assert.equal(result.waitlist.closedQty,600);
  const pool=await ledger.getWaitlistPool(s.pool.id,{operatorId:f.actor});assert.equal(pool.availableQty,5000);assert.equal(pool.returnedUnread,true);
  const events=(await query("SELECT id FROM sales_stock_request_events WHERE request_id=$1 AND event_type='waitlist_rejected'",[request.id])).rows;
  assert.equal(events.length,1);assert.equal(result.manualDecisionEventId,Number(events[0].id));
  assert((await regularStockAlerts(f.context)).requests.some(r=>r.id===request.id));
  await acknowledgeRegularStockDecisions(request.id,{eventId:events[0].id},f.context);
  assert.equal((await regularStockAlerts(f.context)).requests.some(r=>r.id===request.id),false);
  assert.equal((await ledger.listWaitlistRequests()).some(r=>r.id===request.id),false);
  await assert.rejects(()=>reject(current,'Different reason',key),e=>e.code==='WAITLIST_IDEMPOTENCY_CONFLICT');
  assert.equal((await ledger.getWaitlistPool(s.pool.id)).availableQty,5000);
});
test('rejecting the remainder retains converted SO quantities and immutable references',async()=>{
  const s=await f.supply(),request=await s.demand(1000);await f.allocate(s.pool,[[request,600]]);
  const operation=await ledger.claimWaitlistConversion(request.id,{operationKey:randomUUID(),expectedRevision:(await ledger.getWaitlistRequest(request.id)).revision,fulfillmentMethod:'pickup'},f.context);
  await ledger.finishWaitlistConversion(operation.id,{salesOrderId:997001,salesOrderRef:'SO-REJECT-REMAINDER'});
  const remainder=await ledger.getWaitlistRequest(request.id);await f.allocate(await ledger.getWaitlistPool(s.pool.id),[[remainder,400]]);
  const rejected=await reject(await ledger.getWaitlistRequest(request.id));
  assert.equal(rejected.waitlist.convertedQty,600);assert.equal(rejected.waitlist.closedQty,400);
  assert.equal(rejected.waitlist.conversions[0].salesOrderRef,'SO-REJECT-REMAINDER');assert.equal((await ledger.getWaitlistPool(s.pool.id)).availableQty,4400);
});
test('missing reason, stale revision and in-flight conversion fail without discarding stock',async()=>{
  const s=await f.supply(),request=await s.demand(600);await f.allocate(s.pool,[[request,600]]);const current=await ledger.getWaitlistRequest(request.id);
  await assert.rejects(()=>reject(current,''),e=>e.status===400);
  await assert.rejects(()=>reject(request),e=>e.code==='STOCK_REQUEST_REVISION_CONFLICT');
  const operation=await ledger.claimWaitlistConversion(request.id,{operationKey:randomUUID(),expectedRevision:current.revision,fulfillmentMethod:'pickup'},f.context);
  for(const status of ['pending','preparing','submitted','uncertain']){
    await query('UPDATE regular_waitlist_conversions SET status=$2 WHERE id=$1',[operation.id,status]);
    await assert.rejects(async()=>reject(await ledger.getWaitlistRequest(request.id)),e=>e.code==='WAITLIST_CONVERSION_BUSY');
  }
  assert.equal((await ledger.getWaitlistPool(s.pool.id)).availableQty,4400);assert.equal((await ledger.getWaitlistRequest(request.id)).waitlist.closedAt,null);
});
test('a Reject versus conversion race has one winning command and conserves the PO',async()=>{
  const s=await f.supply(),request=await s.demand(600);await f.allocate(s.pool,[[request,600]]);const current=await ledger.getWaitlistRequest(request.id);
  const outcomes=await Promise.allSettled([reject(current),ledger.claimWaitlistConversion(request.id,{operationKey:randomUUID(),expectedRevision:current.revision,fulfillmentMethod:'pickup'},f.context)]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
  assert(['WAITLIST_CONVERSION_BUSY','STOCK_REQUEST_REVISION_CONFLICT','WAITLIST_CLOSED'].includes(outcomes.find(o=>o.status==='rejected').reason.code));
  const saved=await ledger.getWaitlistRequest(request.id),pool=await ledger.getWaitlistPool(s.pool.id);
  assert.equal(pool.availableQty+saved.waitlist.heldQty+saved.waitlist.convertedQty,5000);
  assert(saved.waitlist.state==='closed'||saved.waitlist.state==='converting');
});
test('a completed request cannot be rejected and a missing SCM actor cannot discard demand',async()=>{
  const s=await f.supply(),request=await s.demand(600);
  await assert.rejects(()=>ledger.rejectWaitlistRequest(request.id,{operationKey:randomUUID(),expectedRevision:request.revision,reason:'No production'},{}),e=>e.status===403);
  await f.allocate(s.pool,[[request,600]]);const current=await ledger.getWaitlistRequest(request.id);
  const conversion=await ledger.claimWaitlistConversion(request.id,{operationKey:randomUUID(),expectedRevision:current.revision,fulfillmentMethod:'pickup'},f.context);
  await ledger.finishWaitlistConversion(conversion.id,{salesOrderId:997002,salesOrderRef:'SO-COMPLETE-RETAINED'});
  await assert.rejects(async()=>reject(await ledger.getWaitlistRequest(request.id)),e=>e.code==='WAITLIST_COMPLETED');
  assert.equal((await ledger.getWaitlistRequest(request.id)).waitlist.state,'completed');assert.equal((await ledger.getWaitlistPool(s.pool.id)).availableQty,4400);
});
