import assert from 'node:assert/strict';
import {query,withTransaction} from '../src/db.js';
import {DISPATCH_FLEET_PLANNING_LOCK} from '../src/dispatch-fleet-status.js';
import {enrichDispatchOrdersWithPoTargetAllocations} from '../src/dispatch-repository.js';
import {stripDispatchRelationshipProjections} from '../src/dispatch-plan-order-projection.js';
import {dispatchRequiredPickupVisitLocations} from '../src/dispatch-pickup-visits.js';
import {persistedDispatchPlan} from '../src/dispatch-plan-fence.js';
import {digestDispatchPlan,dispatchPlanBoard} from '../src/dispatch-planner-performance.js';
import {compactDispatchOrderCard,dispatchOrderSearchText} from '../src/dispatch-planner-optimization.js';
import {syncDispatchPlanLoadProjection,syncDispatchPlanOrderAssignments,syncDispatchPlanRelationEdges} from '../src/dispatch-planner-v2-repository.js';
import {writeDispatchAudit} from '../src/dispatch-audit-repository.js';

const ref='GOB-122647-122650-122835-123218';
const planId=367;
const loadId='T5-L1792753570068-aa81f1d2f81b98';
const stopId='stop-cbbe6b8f-7721-46bc-aac0-e04d671257fd';
const authorization='User confirmed the driver only pressed continue and explicitly authorized removing the empty 3445 pickup.';

export async function repairGob122647EmptyPickup({apply=false,expectedRevision=null}={}) {
 return withTransaction(async()=>{
  await query("SET LOCAL lock_timeout='3s'");
  await query("SET LOCAL statement_timeout='20s'");
  await query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
  const row=(await query(`SELECT p.*,s.orders,s.trucks,s.summary,s.saved_at FROM dispatch_plans p
    JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1 FOR UPDATE OF p,s`,[planId])).rows[0];
  assert.ok(row,'Missing incident plan');
  const before=persistedDispatchPlan(row);
  const load=before.trucks.flatMap(t=>t.loads||[]).find(l=>l.id===loadId);
  assert.ok(load,'Missing incident load');
  const stop=load.stops.find(s=>s.id===stopId);
  const records=(await query('SELECT * FROM driver_job_records WHERE plan_id=$1 ORDER BY id FOR UPDATE',[planId])).rows;
  const job=records.find(j=>j.load_id===loadId&&j.stop_id===stopId);
  if(!stop){assert.equal(job?.status,'superseded');return {alreadyCorrect:true,revision:before.revision};}
  if(expectedRevision!==null)assert.equal(before.revision,Number(expectedRevision),'Plan revision changed');
  assert.equal(stop.type,'pick');assert.equal(stop.location,'3445');assert.equal(stop.orderId,ref);
  assert.deepEqual(stop.orderRefs,[ref]);
  assert.equal(job?.status,'complete','Expected only the completed continue action');
  assert.equal(job.stop_type,'pickup');
  assert.equal(job.job_details?.pickupLocation||job.job_details?.location,'3445');
  assert.ok(Array.isArray(job.job_details?.orders),'Missing recorded cargo evidence');
  assert.ok(job.job_details.orders.every(o=>Array.isArray(o.items)&&o.items.length===0),'Pickup contains recorded cargo');
  assert.equal(Number((await query('SELECT count(*) AS n FROM dispatch_so_po_allocation_execution_events WHERE driver_job_record_id=$1',[job.id])).rows[0].n),0,'Pickup has supply execution evidence');
  const original=before.orders.find(o=>o.id===ref);assert.ok(original);
  const [projected]=await enrichDispatchOrdersWithPoTargetAllocations(stripDispatchRelationshipProjections([original]));
  assert.deepEqual(dispatchRequiredPickupVisitLocations(projected,before),['TECHO BLOC Vaughan'],'Source pickup still has cargo');
  const cargo=items=>(items||[]).map(({poAllocatedSalesQty:_q,poAllocatedPallets:_p,poAllocatedLayers:_l,poAllocatedSections:_s,poAllocatedPieces:_pc,dispatchServiceFee:_fee,...item})=>item);
  assert.deepEqual(cargo(projected.items),cargo(original.items),'Source cargo changed');
  const next=structuredClone(before);
  const target=next.trucks.flatMap(t=>t.loads||[]).find(l=>l.id===loadId);
  target.stops=target.stops.filter(s=>s.id!==stopId);
  for(const key of ['routeEstimate','routeEstimateId','routeSignature','timing','plannedFinishMinute'])delete target[key];
  next.orders=next.orders.map(o=>o.id===ref?projected:o);
  const definition=(await query('SELECT * FROM dispatch_global_order_groups WHERE group_ref=$1 FOR UPDATE',[ref])).rows[0];
  assert.ok(definition,'Missing group definition');
  const refreshed={...definition.full_order,...projected,globalGroupDefinition:true};
  await query(`INSERT INTO dispatch_plan_snapshot_history
    (plan_id,plan_date,revision,orders,trucks,summary,original_saved_at,archive_reason,session_id)
    VALUES($1,$2::date,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,'authorized_empty_pickup_correction','gob122647-repair')`,
   [planId,before.planDate,before.revision,JSON.stringify(before.orders),JSON.stringify(before.trucks),JSON.stringify(before.summary),before.savedAt]);
  const correctedJob=(await query(`UPDATE driver_job_records SET status='superseded',mbt_assignment_withdrawn_at=now(),
    job_details=job_details||$2::jsonb WHERE id=$1 RETURNING *`,[job.id,JSON.stringify({supportCorrection:{reason:'empty_duplicate_pickup',authorization,removedStopId:stopId,previousStatus:job.status}})])).rows[0];
  next.revision=Number((await query('UPDATE dispatch_plans SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING revision',[planId])).rows[0].revision);
  const counts=dispatchPlanBoard(next);
  await query(`UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb,plan_digest=$4,saved_at=now(),
    order_count=$5,truck_count=$6,load_count=$7,stop_count=$8 WHERE plan_id=$1`,
   [planId,JSON.stringify(next.orders),JSON.stringify(next.trucks),digestDispatchPlan(next),next.orders.length,counts.truckCount,counts.loadCount,counts.stopCount]);
  await syncDispatchPlanLoadProjection(next);
  await syncDispatchPlanOrderAssignments(next);
  await syncDispatchPlanRelationEdges(next);
  await query('UPDATE dispatch_global_order_groups SET full_order=$2::jsonb,card=$3::jsonb,search_text=$4,updated_at=now() WHERE group_ref=$1',
   [ref,JSON.stringify(refreshed),JSON.stringify(compactDispatchOrderCard(refreshed)),dispatchOrderSearchText(refreshed)]);
  await query('UPDATE dispatch_order_catalog_state SET generation=generation+1,updated_at=now() WHERE singleton=true');
  const afterRecords=(await query('SELECT * FROM driver_job_records WHERE plan_id=$1 ORDER BY id',[planId])).rows;
  assert.deepEqual(afterRecords.filter(j=>j.id!==job.id),records.filter(j=>j.id!==job.id),'Other driver progress changed');
  const audit=await writeDispatchAudit({action:'dispatch.empty_pickup_corrected',entityType:'dispatch_plan',entityId:String(planId),
   orderId:ref,loadId,planId,planDate:before.planDate,source:'support',sessionId:'gob122647-repair',
   before:{revision:before.revision,stop,driverJob:job,groupDefinition:definition.full_order},
   after:{revision:next.revision,driverJob:correctedJob,requiredPickups:['TECHO BLOC Vaughan']},details:{authorization}});
  return {applied:apply,rolledBack:!apply,planId,ref,beforeRevision:before.revision,revision:next.revision,
   removedStopId:stopId,driverRecordId:job.id,auditId:audit.id,requiredPickups:['TECHO BLOC Vaughan'],otherProgressPreserved:true};
 },{rollback:!apply});
}
