// Operational read-only verification; run inside the live app after correction.
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '../src/db.js';
import {getDispatchOrderCatalogOrder} from '../src/dispatch-order-catalog-repository.js';
import {enrichDispatchOrdersWithPoTargetAllocations} from '../src/dispatch-repository.js';
import {dispatchRequiredPickupVisitLocations} from '../src/dispatch-pickup-visits.js';
import {getDriverPlanRoutesForDate} from '../src/driver-repository.js';
import {materializeDriverOfflineJobs} from '../src/driver-offline-repository.js';
try {
 const result=await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');await query("SET LOCAL statement_timeout='30s'");
  const loadId='T5-L1793132738472-54642beda6e9b';
  const ref='GOM-6894S1-6895S1';
  const row=(await query('SELECT p.revision,s.orders,s.trucks FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=371')).rows[0];
  const load=row.trucks.flatMap(truck=>truck.loads||[]).find(entry=>entry.id===loadId);
  assert.ok(!load.stops.some(stop=>stop.id==='stop-8ee7d1bd-4c91-4764-97f3-0bcad5954b17'));
  assert.ok(load.stops.some(stop=>stop.id==='stop-49394220-af09-429d-9dd1-82e39feab513'&&stop.orderRefs?.includes('TOB01269')));
  const feed=await getDispatchOrderCatalogOrder(ref);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(feed),['TECHO BLOC Vaughan']);
  assert.equal(feed.items.find(item=>Number(item.itemId)===1784).poAllocatedSalesQty,21);
  const rows=(await query("SELECT group_ref,full_order FROM dispatch_global_order_groups WHERE active AND order_type='SO' ORDER BY group_ref")).rows;
  const projected=await enrichDispatchOrdersWithPoTargetAllocations(rows.map(entry=>entry.full_order));
  const lost=rows.filter((entry,index)=>(projected[index].items||[]).some((item,i)=>Number(item.poAllocatedSalesQty)>0&&!(Number(entry.full_order.items?.[i]?.poAllocatedSalesQty)>0))).map(entry=>entry.group_ref);
  assert.deepEqual(lost,[],'Known active PO sales allocations are still missing from the group feed');
  const routes=await getDriverPlanRoutesForDate('2026-10-28');
  const route=routes.routes.find(entry=>entry.jobs.some(job=>job.loadId===loadId));assert.ok(route,'Missing Driver route');
  const jobs=route.jobs.filter(job=>job.loadId===loadId),pickup=jobs.find(job=>job.stopType==='pickup'&&job.pickupLocation==='TECHO BLOC Vaughan');
  assert.ok(pickup,'Missing Techo Driver pickup');
  const members=pickup.orders.filter(order=>/^SOM0689[45]-S1$/.test(order.orderRef));assert.equal(members.length,2);
  for(const order of members)assert.deepEqual(order.poRefs,['LOINC-038227']);
  const offline=materializeDriverOfflineJobs([pickup],route.driverLogin)[0].snapshot;
  assert.deepEqual(offline.orders.filter(order=>/^SOM0689[45]-S1$/.test(order.orderRef)).map(order=>order.poRefs),members.map(order=>order.poRefs));
  const history=[];
  for(const historical of ['GOB-123453-123464','GOA-10588-10650','GOA-10208-10209S1']) {
   const order=await getDispatchOrderCatalogOrder(historical);
   const required=dispatchRequiredPickupVisitLocations(order);
   assert.deepEqual(required,['TECHO BLOC Vaughan']);history.push({ref:historical,required});
  }
  return {planId:371,revision:Number(row.revision),loadId,requiredPickups:['TECHO BLOC Vaughan'],palletSalesQty:21,palletAllocatedSalesQty:21,
   driverPickupOrders:members.map(order=>({ref:order.orderRef,poRefs:order.poRefs})),offlinePoRefsVerified:true,
   realTransferPickupPreserved:true,remainingLostGroupAllocations:lost,history,
   progress:(await query('SELECT id,status,stop_id,stop_type,started_at,completed_at FROM driver_job_records WHERE plan_id=371 AND load_id=$1 ORDER BY id',[loadId])).rows};
 });
 console.log(JSON.stringify(result));
} finally {await closeDb();}
