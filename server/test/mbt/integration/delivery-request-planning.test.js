import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {query,closeDb} from '../../../src/db.js';
import {upsertDispatchOrderCatalog,listDispatchOrderPool} from '../../../src/dispatch-order-catalog-repository.js';
import {prioritizeDeliveryOrders} from '../../../src/delivery-request-repository.js';
let requestId;
before(async()=>{
  await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active)
    VALUES('delivery-planner','delivery-planner','Planner test','test','test','sales',ARRAY['sales'],true)`);
  const result=await query(`INSERT INTO delivery_requests(requesting_yard_location_id,status,data,created_by,last_action)
    VALUES(1,'confirmed',$1,'delivery-planner','secure') RETURNING id`,[{salesOrderRefs:['SODROLD'],securedAt:new Date().toISOString(),confirmedWindow:{date:'2028-10-10',start:'08:00',end:'09:00'}}]);
  requestId=result.rows[0].id;
  await query(`INSERT INTO delivery_request_sales_orders(request_id,order_ref) VALUES($1,'SODROLD')`,[requestId]);
  await upsertDispatchOrderCatalog({source:'delivery-priority-test',orders:[
    {id:'SODROLD',type:'SO',firstSeenAt:'2020-01-01T00:00:00Z',expectedDeliveryDate:'2028-10-01',windowStart:'08:00',windowEnd:'22:00'},
    ...[1,2,3].map(index=>({id:`SODRN${index}`,type:'SO',firstSeenAt:`2028-10-0${index}T00:00:00Z`}))]});
});
after(closeDb);
test('secured SO appears on the first paged planning feed and keyset pagination has no omissions or duplicates',async()=>{
  const first=await listDispatchOrderPool({type:'SO',limit:2});
  assert.deepEqual(first.orders.map(order=>order.id),['SODROLD','SODRN3']);
  assert.equal(first.orders[0].deliveryApprovalPriority,true);
  assert.equal(first.orders[0].windowStart,'08:00');assert.equal(first.orders[0].windowEnd,'09:00');
  assert.equal(first.orders[0].expectedDeliveryDate,'2028-10-10');
  const second=await listDispatchOrderPool({type:'SO',limit:2,cursor:first.nextCursor});
  assert.deepEqual(second.orders.map(order=>order.id),['SODRN2','SODRN1']);assert.equal(second.nextCursor,'');
});
test('grouped children inherit priority and timing; cancellation restores original timing and removes stale flags',async()=>{
  const original=[{id:'NORMAL',type:'SO'},{id:'GROUP',type:'SO',childOrders:['SODROLD'],windowStart:'08:00',windowEnd:'22:00'}];
  const sorted=await prioritizeDeliveryOrders(original);
  assert.equal(sorted[0].id,'GROUP');
  assert.equal(sorted[0].windowEnd,'09:00');assert.equal(sorted[0].expectedDeliveryDate,'2028-10-10');
  assert.deepEqual(await prioritizeDeliveryOrders(sorted),sorted,'Overlay must be idempotent');
  assert.equal(original[1].windowEnd,'22:00','Input snapshot must not mutate');
  await query(`UPDATE delivery_requests SET status='cancelled' WHERE id=$1`,[requestId]);
  const restored=await listDispatchOrderPool({type:'SO',limit:2});
  assert.deepEqual(restored.orders.map(order=>order.id),['SODRN3','SODRN2']);
  const stale=await prioritizeDeliveryOrders([{id:'NORMAL',type:'SO'},{id:'SODROLD',type:'SO',deliveryApprovalPriority:true}]);
  assert.deepEqual(stale.map(order=>order.id),['NORMAL','SODROLD']);assert.notEqual(stale[1].deliveryApprovalPriority,true);
  const restoredTiming=(await prioritizeDeliveryOrders(sorted)).find(order=>order.id==='GROUP');
  assert.equal(restoredTiming.windowEnd,'22:00');assert.equal(restoredTiming.expectedDeliveryDate,undefined);
});
test('linkage: compact catalog keeps original SO times when a projected card is cached and then unlinked',async()=>{
  await query("UPDATE delivery_requests SET status='confirmed' WHERE id=$1",[requestId]);
  const projected=await prioritizeDeliveryOrders([{id:'SODROLD',type:'SO',windowStart:'08:00',windowEnd:'22:00',expectedDeliveryDate:'2028-10-01'}]);
  await upsertDispatchOrderCatalog({source:'delivery-priority-test',orders:projected});
  await query('DELETE FROM delivery_request_sales_orders WHERE request_id=$1',[requestId]);
  const result=await listDispatchOrderPool({type:'SO',search:'SODROLD',limit:2});
  assert.equal(result.orders[0].windowStart,'08:00');assert.equal(result.orders[0].windowEnd,'22:00');
  assert.equal(result.orders[0].expectedDeliveryDate,'2028-10-01');assert.notEqual(result.orders[0].deliveryApprovalPriority,true);
});
