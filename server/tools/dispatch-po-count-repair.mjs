// One-off, revision-fenced repair. Imported by the isolated regression tests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { query, withTransaction, closeDb } from '../src/db.js';
import { persistedDispatchPlan } from '../src/dispatch-plan-fence.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from '../src/dispatch-fleet-status.js';
import { enrichDispatchOrdersWithPoTargetAllocations, listDispatchOrders } from '../src/dispatch-repository.js';
import { stripDispatchRelationshipProjections } from '../src/dispatch-plan-order-projection.js';
import { dispatchRequiredPickupVisitLocations, materializeDispatchPickupVisits } from '../src/dispatch-pickup-visits.js';
import { assertDispatchExecutedPrefixPreserved } from '../src/dispatch-executed-prefix-repository.js';
import { digestDispatchPlan, dispatchPlanBoard } from '../src/dispatch-planner-performance.js';
import { syncDispatchPlanOrderAssignments, syncDispatchPlanRelationEdges } from '../src/dispatch-planner-v2-repository.js';
import { writeDispatchAudit } from '../src/dispatch-audit-repository.js';
import { getDriverPlanRoutesForDate, planJobsForDrivers, driverOrderDetailsFromPlan } from '../src/driver-repository.js';

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cleanTiming = stop => {
  const result={...stop};
  for(const field of ['timing','arriveTime','departTime','plannedArrive','plannedDepart','plannedArrival','plannedDeparture']) delete result[field];
  return result;
};

export async function repairLinkedPoLoad({planId,planDate,baseRevision,groupRef,poRef,loadId,driverLogin,
  originalPickupId,originalDropId,preview=false}) {
  return withTransaction(async()=>{
    if(preview) await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL statement_timeout='20s'");
    if(!preview) await query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
    const row=(await query(`SELECT p.*,p.plan_date::text AS plan_date,s.orders,s.trucks,s.summary,s.saved_at
      FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1 ${preview?'':'FOR UPDATE OF p'}`,[planId])).rows[0];
    assert.ok(row,'Plan exists');
    const before=persistedDispatchPlan(row);
    assert.equal(before.planDate,planDate);assert.equal(before.revision,baseRevision,'Plan revision changed');
    assert.equal(before.status,'confirmed');
    const truck=before.trucks.find(t=>t.loads?.some(load=>load.id===loadId));
    const load=truck?.loads.find(load=>load.id===loadId);
    assert.ok(load);assert.equal(load.driverLogin,driverLogin);
    const group=before.orders.find(order=>order.id===groupRef);
    assert.ok(group);assert.equal(group.type,'SO');
    assert.ok(load.stops.some(stop=>stop.type==='drop'&&stop.orderId===groupRef));
    assert.ok(load.stops.every(stop=>['pick','drop'].includes(stop.type)&&[groupRef,poRef].includes(stop.orderId)), 'New unrelated stops require review');
    const records=(await query('SELECT * FROM driver_job_records WHERE plan_id=$1 ORDER BY id',[planId])).rows;
    const loadRecords=records.filter(job=>job.load_id===loadId);
    assert.ok(loadRecords.every(job=>job.stop_type==='travel'||!['in_progress','complete'].includes(job.status)), 'A physical stop has started');
    const originalPickup=loadRecords.find(job=>String(job.id)===String(originalPickupId));
    const originalDrop=loadRecords.find(job=>String(job.id)===String(originalDropId));
    assert.equal(originalPickup?.status,'pending');assert.equal(originalPickup.stop_type,'pickup');
    assert.equal(originalDrop?.status,'pending');assert.equal(originalDrop.stop_type,'dropoff');
    const existingPo=before.orders.find(order=>order.id===poRef);
    const po=existingPo || (await listDispatchOrders({type:'PO',exactOrderRefs:[poRef],includeHiddenScm:true})).find(order=>order.id===poRef);
    assert.ok(po,'Source PO exists');
    assert.ok(!before.trucks.flatMap(t=>t.loads||[]).filter(l=>l.id!==loadId).some(l=>(l.stops||[]).some(stop=>stop.orderId===poRef)), 'PO is assigned to another load');
    const [linked,residual]=await enrichDispatchOrdersWithPoTargetAllocations(stripDispatchRelationshipProjections([group,po]));
    const [vendor]=dispatchRequiredPickupVisitLocations(linked,before);
    assert.deepEqual(dispatchRequiredPickupVisitLocations(linked,before),[vendor]);
    assert.equal(vendor,po.sourceYard);
    const palletSum=items=>(items||[]).reduce((sum,item)=>sum+Number(item.pallets||0),0);
    assert.equal(palletSum(linked.items),16);assert.equal(palletSum(po.items),22);
    assert.equal(palletSum(residual.poRouteProjection.items),6);
    const palletLine=linked.items.find(item=>Number(item.itemId)===1784);
    assert.equal(Number(palletLine?.poAllocatedSalesQty),16);assert.equal(Number(palletLine.poAllocatedPieces),16);
    const pickup=load.stops.find(stop=>stop.type==='pick'&&stop.location===vendor);
    const customer=load.stops.find(stop=>stop.type==='drop'&&stop.orderId===groupRef);
    assert.ok(pickup);assert.ok(customer);
    const dropoff=residual.poRouteProjection.dropoffs.find(drop=>drop.destinationYard==='2967');
    assert.ok(dropoff);assert.equal(residual.poRouteProjection.dropoffs.length,1);
    const nextLoad={...load,stops:[
      cleanTiming({...pickup,id:originalPickup.stop_id,orderId:poRef,orderRefs:[poRef,groupRef]}),
      cleanTiming({...customer,location:linked.address}),
      {id:originalDrop.stop_id,type:'drop',loadId,orderId:poRef,location:'2967',dropLocation:'2967',dropoffKey:dropoff.key,
        dropAddress:dropoff.address,lineRowIds:dropoff.lineRowIds,destinationLocationId:dropoff.destinationLocationId}
    ]};
    for(const field of ['routeEstimate','routeEstimateId','routeSignature','plannedFinishMinute','finish','finishTime','timing']) delete nextLoad[field];
    const next={...before,revision:before.revision+1,
      orders:before.orders.map(order=>order.id===groupRef?linked:order.id===poRef?residual:order),
      trucks:before.trucks.map(t=>t.id===truck.id?{...t,loads:t.loads.map(l=>l.id===loadId?nextLoad:l)}:t)};
    if(!existingPo) next.orders.push(residual);
    const scoped={...next,orders:[linked,residual],trucks:[{...truck,loads:[nextLoad]}]};
    assert.deepEqual(materializeDispatchPickupVisits(scoped,{allowLegacyPassthrough:true}).conflicts,[]);
    await assertDispatchExecutedPrefixPreserved({previousPlan:before,nextPlan:next});
    const jobs=planJobsForDrivers(next,[driverLogin],{allowBin:true}).get(driverLogin).filter(job=>job.loadId===loadId);
    const travel=jobs.find(job=>job.stopType==='travel');
    assert.ok(loadRecords.some(job=>job.job_id===travel?.jobId&&job.status==='complete'),'Original completed travel must remain the first job');
    assert.equal(jobs.find(job=>job.stopType==='pickup').jobId,originalPickup.job_id,'Original pickup photo identity');
    assert.equal(jobs.find(job=>job.stopType==='dropoff'&&job.orderRefs.includes(poRef)).jobId,originalDrop.job_id);
    const details={
      pickup:driverOrderDetailsFromPlan(poRef,residual,{plan:next,stopType:'pickup',pickupLocation:vendor}),
      customer:driverOrderDetailsFromPlan(groupRef,linked,{plan:next,stopType:'dropoff'}),
      yard:driverOrderDetailsFromPlan(poRef,residual,{plan:next,stopType:'dropoff',dropLocation:'2967'})
    };
    for(const [key,expected] of [['pickup',22],['customer',16],['yard',6]]) {
      assert.equal(details[key].items.flatMap(item=>item.units).filter(unit=>unit.unit==='PLT').reduce((sum,unit)=>sum+unit.value,0),expected);
    }
    const report={planId,baseRevision,beforeDriverHash:sha(records),loadId,driverLogin,
      start:nextLoad.start,originalTravelJobId:travel.jobId,retainedPickupPhotos:originalPickup.photo_data_urls.length,
      stops:nextLoad.stops.map(stop=>({id:stop.id,type:stop.type,location:stop.location,orderId:stop.orderId,orderRefs:stop.orderRefs})),details};
    if(preview) return {...report,preview:true};
    const counts=dispatchPlanBoard(next);
    const history=(await query(`INSERT INTO dispatch_plan_snapshot_history(plan_id,plan_date,revision,orders,trucks,summary,
      original_saved_at,archive_reason,session_id,schema_version,plan_digest,order_count,truck_count,load_count,stop_count)
      SELECT plan_id,$2::date,$3,orders,trucks,summary,saved_at,'po_count_route_repair','codex-po-count-20261019',
        schema_version,plan_digest,order_count,truck_count,load_count,stop_count
      FROM dispatch_plan_snapshots WHERE plan_id=$1 RETURNING id`,[planId,planDate,baseRevision])).rows[0];
    assert.ok(history);
    const updated=await query('UPDATE dispatch_plans SET revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$2 RETURNING revision',[planId,baseRevision]);
    assert.equal(updated.rowCount,1);
    await query(`UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb,saved_at=now(),plan_digest=$4,
      order_count=$5,truck_count=$6,load_count=$7,stop_count=$8 WHERE plan_id=$1`,
      [planId,JSON.stringify(next.orders),JSON.stringify(next.trucks),digestDispatchPlan(next),next.orders.length,counts.truckCount,counts.loadCount,counts.stopCount]);
    await syncDispatchPlanOrderAssignments(next);await syncDispatchPlanRelationEdges(next);
    await query(`UPDATE dispatch_plan_load_assignments SET started=true,completed=false,planned_finish_minute=NULL,updated_at=now()
      WHERE plan_id=$1 AND load_id=$2`,[planId,loadId]);
    const afterRecords=(await query('SELECT * FROM driver_job_records WHERE plan_id=$1 ORDER BY id',[planId])).rows;
    assert.deepEqual(afterRecords,records,'Every driver job, timestamp and photo must remain unchanged');
    const stored=(await query('SELECT orders,trucks,summary FROM dispatch_plan_snapshots WHERE plan_id=$1',[planId])).rows[0];
    assert.deepEqual(stored.orders.filter(order=>![groupRef,poRef].includes(order.id)),before.orders.filter(order=>![groupRef,poRef].includes(order.id)));
    assert.deepEqual(stored.trucks.map(t=>({...t,loads:t.loads.filter(l=>l.id!==loadId)})),before.trucks.map(t=>({...t,loads:t.loads.filter(l=>l.id!==loadId)})));
    assert.deepEqual(stored.summary,before.summary);
    const route=(await getDriverPlanRoutesForDate(planDate)).routes.find(route=>route.driverLogin===driverLogin).jobs.filter(job=>job.loadId===loadId);
    assert.equal(route[0].jobId,travel.jobId);assert.equal(route[0].status,'complete');
    assert.deepEqual(route.filter(job=>job.stopType==='pickup').map(job=>job.pickupLocation),[vendor]);
    assert.equal(route.find(job=>job.stopType==='pickup').retainedPhotoCount,originalPickup.photo_data_urls.length);
    const audit=await writeDispatchAudit({action:'dispatch.po_count_route_repaired',entityType:'load',entityId:loadId,planId,planDate,
      loadId,truckId:truck.id,orderId:groupRef,sessionId:'codex-po-count-20261019',source:'authorized-maintenance',
      before:{revision:baseRevision,load},after:{revision:next.revision,load:nextLoad},details:{...report,historyId:history.id,driverRecordsUnchanged:true}});
    return {...report,revision:next.revision,historyId:history.id,auditId:audit.id,afterDriverHash:sha(afterRecords),applied:true,
      route:route.map(job=>({jobId:job.jobId,stopType:job.stopType,status:job.status,address:job.address,orderRefs:job.orderRefs,orders:job.orders}))};
  });
}

if(process.env.DISPATCH_PO_COUNT_REPAIR_RUN==='1') {
  try {
    const result=await repairLinkedPoLoad({planId:363,planDate:'2026-10-19',baseRevision:Number(process.env.DISPATCH_PO_COUNT_REVISION),
      groupRef:'GOB-122755-122934',poRef:'#3022301585',loadId:'T7-L1792353708578-e25b724de7272',driverLogin:'sety',
      originalPickupId:6785,originalDropId:6795,preview:process.env.DISPATCH_PO_COUNT_PREVIEW==='1'});
    console.log(JSON.stringify(result,null,2));
  } finally {await closeDb();}
}
