import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import { enrichDispatchOrdersWithPoTargetAllocations, getSalesOrderPoAllocationOptions } from '../../../src/dispatch-repository.js';
import { createDispatchPlan, saveDispatchPlanSnapshot } from '../../../src/dispatch-plan-repository.js';
import { getDriverPlanRoutesForDate, planJobsForDrivers, driverOrderDetailsFromPlan } from '../../../src/driver-repository.js';
import { dispatchRequiredPickupVisitLocations } from '../../../src/dispatch-pickup-visits.js';
import { stripDispatchRelationshipProjections } from '../../../src/dispatch-plan-order-projection.js';
import { applyDispatchV2Command } from '../../../src/dispatch-planner-v2-repository.js';
import { digestDispatchPlan } from '../../../src/dispatch-planner-performance.js';
import crypto from 'node:crypto';
import { repairLinkedPoLoad } from '../../../tools/dispatch-po-count-repair.mjs';

after(closeDb);
const VENDOR = 'Count Test Vendor';
const GROUP = 'GOB-COUNT-MATERIAL-PALLET';
const PO = '#COUNT-22';
const DATE = '2098-10-19';
async function rollback(run) {
  const tx = await beginRollbackContext();
  try { await tx.run(run); } finally { await tx.rollback(); }
}

async function seed() {
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,vendor,status,status_text,
    destination_location_id,destination_location,dispatch_vendor_yard,dispatch_address,receipt_status,netsuite_active)
    VALUES (9322301585,'PO-COUNT-22',$1,$2,'B','Pending Receipt',28,'2967',$2,'20 Isolated Vendor Road','not_received',true)`, [PO,VENDOR]);
  const children = [];
  const poItems = [];
  for (const [index, itemId, sku, unit, quantity, poQuantity, pallets, pieces, toPlt] of [
    [0,10374,'COUNT-PAVER','SQFT',1673.6,2301.2,16,0,104.6],
    [1,1784,'PALLET','EACH',16,22,0,16,0]
  ]) {
    const soId = 9322301590 + index;
    const ref = `SO-COUNT-${index}`;
    await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,status_text,sales_order_type,
      outbound_location_id,outbound_location,dispatch_address,fulfillment_status,netsuite_active)
      VALUES ($1,$2,'Count Customer','B','Pending Fulfillment','Delivery',28,'2967','30 Isolated Customer Road','not_fulfilled',true)`,[soId,ref]);
    const line = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,item_type,
      quantity,unit,pallet_qty,piece_qty,to_plt,netsuite_active)
      VALUES ($1,$2,$3,$4,$4,'InvtPart',$5,$6,$7,$8,$9,true) RETURNING id`,[soId,index+1,itemId,sku,quantity,unit,pallets,pieces,toPlt])).rows[0];
    const poLine = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,item_type,
      quantity,unit,pallet_qty,to_plt,location_id,location,netsuite_active)
      VALUES (9322301585,$1,$2,$3,$3,'InvtPart',$4,$5,$6,$7,28,'2967',true) RETURNING id`,[index+1,itemId,sku,poQuantity,unit,pallets ? 22 : 0,toPlt])).rows[0];
    await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,
      po_order_id,po_order_ref,po_line_id,item_id,item_name,sku,allocated_sales_qty,allocated_pallet_qty,
      dispatch_target_ref,dispatch_target_kind,dispatch_target_line_key,created_by)
      VALUES ($1,$2,$3,9322301585,$4,$5,$6,$7,$7,$8,$9,$10,'group',$11,'count-regression')`,
      [soId,ref,line.id,PO,poLine.id,itemId,sku,quantity,pallets,GROUP,`${GROUP}::${ref}::${line.id}`]);
    const item = {lineRowId:String(line.id),lineId:index+1,itemId,itemName:sku,sku,itemType:'InvtPart',unit,quantity,pallets,pieces,toPlt};
    children.push({id:ref,type:'SO',netsuiteId:soId,sourceYard:'2967',pickupLocations:['2967'],address:'30 Isolated Customer Road',items:[item],pallets});
    poItems.push({...item,lineRowId:String(poLine.id),quantity:poQuantity,pallets:pallets ? 22 : 0,pieces:0,destinationLocationId:28,destinationYard:'2967'});
  }
  const group = {...children[0],id:GROUP,isGrouped:true,planOwned:true,childOrders:children.map(child=>child.id),
    childOrderDetails:children,items:children.flatMap(child=>child.items)};
  const po = {id:PO,type:'PO',netsuiteId:9322301585,sourceYard:VENDOR,sourceAddress:'20 Isolated Vendor Road',
    pickupLocations:[VENDOR],destinationLocationId:28,destinationYard:'2967',destinationAddress:'2967 Kennedy Road, Toronto, ON',
    items:poItems,pallets:22};
  return {group,po};
}

function planFor(orders) {
  return {id:'123',planDate:DATE,status:'confirmed',orders,trucks:[{id:'count-truck',plate:'COUNT-TRUCK',driver:'Count Driver',driverLogin:'count-driver',base:'3445',loads:[{
    id:'count-load',name:'Load 1',driverLogin:'count-driver',driverName:'Count Driver',switchYard:'3445',start:'06:30',pickupVisitSchemaVersion:1,
    stops:[{id:'original-pickup',type:'pick',location:VENDOR,orderId:GROUP,orderRefs:orders.map(order=>order.id)},
      {id:'customer',type:'drop',orderId:GROUP,location:'Customer'},
      ...(orders.some(order=>order.type==='PO') ? [{id:'yard',type:'drop',orderId:PO,location:'2967'}] : [])]
  }]}]};
}

test('grouped sales-only count links have no phantom yard pickup and each driver member keeps its manifest', () => rollback(async () => {
  const {group} = await seed();
  const [result] = await enrichDispatchOrdersWithPoTargetAllocations([group]);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(result),[VENDOR]);
  assert.equal(result.items[1].poAllocatedPieces,16);
  assert.deepEqual(result.childOrderDetails.map(child=>child.poPickupManifest.flatMap(entry=>entry.items).map(item=>item.itemId)),[['10374'],['1784']]);
  const plan = planFor([result]);
  const pickup = planJobsForDrivers(plan,['count-driver']).get('count-driver').find(job=>job.stopType==='pickup');
  assert.deepEqual(pickup.orderRefs,['SO-COUNT-0','SO-COUNT-1']);
  const displayed = result.childOrderDetails.map(child=>driverOrderDetailsFromPlan(child.id,child,{plan,stopType:'pickup',pickupLocation:VENDOR}));
  assert.deepEqual(displayed.map(order=>order.items.map(item=>item.units)),[[[{unit:'PLT',value:16}]],[[{unit:'EACH',value:16,fallback:true}]]]);
  await query("UPDATE dispatch_so_po_allocations SET allocated_sales_qty=8 WHERE item_id=1784");
  const [partial] = await enrichDispatchOrdersWithPoTargetAllocations(stripDispatchRelationshipProjections([result]));
  assert.equal(partial.items[1].poAllocatedPieces,8);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(partial),['2967',VENDOR]);
  await query("UPDATE dispatch_so_po_allocations SET status='cancelled'");
  const [cancelled] = await enrichDispatchOrdersWithPoTargetAllocations(stripDispatchRelationshipProjections([partial]));
  assert.deepEqual(dispatchRequiredPickupVisitLocations(cancelled),['2967']);
  assert.ok(cancelled.childOrderDetails.every(child=>!child.poPickupManifest));
}));

test('shared vendor pickup carries 22 once, with 16 customer and 6 yard drop quantities', () => rollback(async () => {
  const {group,po} = await seed();
  const orders = await enrichDispatchOrdersWithPoTargetAllocations([group,po]);
  const plan = planFor(orders);
  const pickup = orders.map(order=>driverOrderDetailsFromPlan(order.id,order,{plan,stopType:'pickup',pickupLocation:VENDOR,pickupCoveredPoOrderRefs:[PO]}));
  assert.deepEqual(pickup[0].items,[],'PO pickup already covers the linked cargo');
  assert.deepEqual(pickup[1].items.map(item=>item.units),[[{unit:'PLT',value:22}],[{unit:'EACH',value:22,fallback:true}]]);
  const customer = driverOrderDetailsFromPlan(GROUP,orders[0],{plan,stopType:'dropoff'});
  assert.deepEqual(customer.items.map(item=>item.units),[[{unit:'PLT',value:16}],[{unit:'PCS',value:16}]]);
  const yard = driverOrderDetailsFromPlan(PO,orders[1],{plan,stopType:'dropoff',dropLocation:'2967'});
  assert.deepEqual(yard.items.map(item=>item.units),[[{unit:'PLT',value:6}],[{unit:'EACH',value:6,fallback:true}]]);
}));

test('saving and reloading keeps original start, completed travel and reopened pickup photos', () => rollback(async () => {
  const {group,po} = await seed();
  const driver = (await query("INSERT INTO dispatch_drivers(name,login,active) VALUES ('Count Driver','count-driver',true) RETURNING id")).rows[0];
  const truck = (await query("INSERT INTO dispatch_trucks(plate,active) VALUES ('COUNT-TRUCK',true) RETURNING id::text")).rows[0];
  assert.ok(driver.id);
  const created = await createDispatchPlan({planDate:DATE});
  const input = planFor([group,po]);
  input.trucks[0].id=truck.id;
  const saved = await saveDispatchPlanSnapshot(created.id,{...input,baseRevision:created.revision});
  assert.deepEqual(saved.trucks[0].loads[0].stops.map(stop=>stop.id),['original-pickup','customer','yard']);
  const options=await getSalesOrderPoAllocationOptions(GROUP,{planDate:DATE});
  const countOption=options.salesLines.find(line=>Number(line.itemId)===1784);
  assert.equal(countOption.required.unit,'EACH');
  assert.equal(countOption.allocated.pieces,16,'Link PO must recognize the already allocated count');
  assert.equal(countOption.available.pieces,0,'No ghost pieces may remain in linking options');
  assert.equal(countOption.available.salesQty,0);
  assert.ok(countOption.poCandidates.some(candidate=>candidate.poRef===PO&&candidate.unitMatch));
  await query("UPDATE dispatch_plans SET status='confirmed' WHERE id=$1",[created.id]);
  const beforeRoute = await getDriverPlanRoutesForDate(DATE);
  const jobs = beforeRoute.routes.find(route=>route.driverLogin==='count-driver').jobs;
  const travel = jobs.find(job=>job.stopType==='travel');
  const pickup = jobs.find(job=>job.stopType==='pickup');
  const yardJob = jobs.find(job=>job.stopType==='dropoff'&&job.orderRefs.includes(PO));
  assert.equal(travel.fromLocation,'3445');
  assert.equal(travel.toLocation,VENDOR);
  for (const job of [travel,pickup,yardJob]) {
    await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,truck_id,truck_plate,load_id,load_name,
      stop_id,stop_type,order_refs,status,started_at,completed_at,photo_data_urls,job_details)
      VALUES ($1,$2,$3,'count-driver',$4,'COUNT-TRUCK','count-load','Load 1',$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12::jsonb)`,
      [job.jobId,created.id,DATE,truck.id,job.stopId,job.stopType,JSON.stringify(job.orderRefs),job===travel?'complete':'pending',
        job===travel?'2098-10-19T10:50:28Z':null,job===travel?'2098-10-19T12:26:36Z':null,
        JSON.stringify(job===pickup?Array.from({length:5},(_,i)=>`r2://isolated-pickup-${i}.jpg`):[]),JSON.stringify(job)]);
  }
  const records = (await query('SELECT * FROM driver_job_records WHERE plan_id=$1 ORDER BY id',[created.id])).rows;
  const again = await saveDispatchPlanSnapshot(created.id,{...saved,baseRevision:saved.revision});
  const incremental = await applyDispatchV2Command({planId:created.id,command:{
    commandId:crypto.randomUUID(),commandType:'update_load',baseRevision:again.revision,baseDigest:digestDispatchPlan(again),
    payload:{planDelta:{s:{...again.summary,countRegression:true}}}
  }});
  assert.equal(incremental.payload.plan.revision,again.revision+1);
  assert.deepEqual((await query('SELECT * FROM driver_job_records WHERE plan_id=$1 ORDER BY id',[created.id])).rows,records);
  const reloaded = await getDriverPlanRoutesForDate(DATE);
  const actual = reloaded.routes.find(route=>route.driverLogin==='count-driver').jobs;
  assert.equal(actual.find(job=>job.stopType==='travel').jobId,travel.jobId);
  assert.equal(actual.find(job=>job.stopType==='travel').status,'complete');
  assert.equal(actual.find(job=>job.stopType==='pickup').retainedPhotoCount,5);
  assert.equal(actual.find(job=>job.stopType==='pickup').status,'pending');
  assert.equal(again.trucks[0].loads[0].start,'06:30');
  assert.deepEqual(actual.filter(job=>job.stopType==='pickup').map(job=>job.pickupLocation),[VENDOR]);

  // Reproduce the reported saved board: the standalone residual PO was removed,
  // a phantom yard pickup precedes a new vendor stop, but the original travel
  // and reopened pickup (including photos) still exist in driver history.
  const current=(await query('SELECT orders,trucks FROM dispatch_plan_snapshots WHERE plan_id=$1',[created.id])).rows[0];
  const legacyGroup=current.orders.find(order=>order.id===GROUP);
  legacyGroup.items.find(item=>Number(item.itemId)===1784).poAllocatedPieces=0;
  for(const child of legacyGroup.childOrderDetails) {
    delete child.poPickupManifest;child.pickupLocations=['2967'];
    for(const item of child.items) item.poAllocatedPieces=0;
  }
  const legacyLoad=current.trucks[0].loads[0];
  legacyLoad.stops=[{id:'phantom-yard',type:'pick',location:'2967',orderId:GROUP,orderRefs:[GROUP]},
    {...legacyLoad.stops[0],id:'replacement-vendor',orderId:GROUP,orderRefs:[GROUP]},legacyLoad.stops[1]];
  await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb WHERE plan_id=$1',
    [created.id,JSON.stringify([legacyGroup]),JSON.stringify(current.trucks)]);
  const repair={planId:created.id,planDate:DATE,baseRevision:incremental.payload.plan.revision,groupRef:GROUP,poRef:PO,
    loadId:'count-load',driverLogin:'count-driver',originalPickupId:records.find(row=>row.stop_type==='pickup').id,
    originalDropId:records.find(row=>row.stop_type==='dropoff').id};
  const repaired=await repairLinkedPoLoad(repair);
  assert.equal(repaired.applied,true);
  assert.equal(repaired.beforeDriverHash,repaired.afterDriverHash);
  assert.equal(repaired.retainedPickupPhotos,5);
  assert.deepEqual(repaired.stops.map(stop=>stop.id),['original-pickup','customer','yard']);
  assert.equal(repaired.route[0].jobId,travel.jobId);
  assert.deepEqual((await query('SELECT * FROM driver_job_records WHERE plan_id=$1 ORDER BY id',[created.id])).rows,records);
  assert.equal(Number((await query("SELECT count(*) FROM dispatch_plan_snapshot_history WHERE plan_id=$1 AND archive_reason='po_count_route_repair'",[created.id])).rows[0].count),1);
  await assert.rejects(repairLinkedPoLoad(repair),/Plan revision changed/);
  const snapshot=(await query('SELECT orders,trucks FROM dispatch_plan_snapshots WHERE plan_id=$1',[created.id])).rows[0];
  await query("UPDATE driver_job_records SET status='in_progress' WHERE id=$1",[repair.originalPickupId]);
  await assert.rejects(repairLinkedPoLoad({...repair,baseRevision:repaired.revision}),/physical stop has started/);
  assert.deepEqual((await query('SELECT orders,trucks FROM dispatch_plan_snapshots WHERE plan_id=$1',[created.id])).rows[0],snapshot);
}));
