import assert from 'node:assert/strict';
import {query,withTransaction} from '../src/db.js';
import {DISPATCH_FLEET_PLANNING_LOCK} from '../src/dispatch-fleet-status.js';
import {enrichDispatchOrdersWithPoTargetAllocations} from '../src/dispatch-repository.js';
import {stripDispatchPoAllocationProjection,reconcileAuthoritativeDispatchOrderProjection} from '../src/dispatch-plan-order-projection.js';
import {dispatchRequiredPickupVisitLocations,dispatchLoadProtectedBoundary} from '../src/dispatch-pickup-visits.js';
import {overlayLockedLoadDerivedSchedule} from '../src/dispatch-load-assignment.js';
import {persistedDispatchPlan} from '../src/dispatch-plan-fence.js';
import {digestDispatchPlan,dispatchPlanBoard} from '../src/dispatch-planner-performance.js';
import {compactDispatchOrderCard,dispatchOrderSearchText} from '../src/dispatch-planner-optimization.js';
import {syncDispatchPlanLoadProjection,syncDispatchPlanOrderAssignments,syncDispatchPlanRelationEdges} from '../src/dispatch-planner-v2-repository.js';
import {writeDispatchAudit} from '../src/dispatch-audit-repository.js';

const ref='GOM-6894S1-6895S1',planId=371,loadId='T5-L1793132738472-54642beda6e9b';
const stopId='stop-8ee7d1bd-4c91-4764-97f3-0bcad5954b17';
const findLoad=plan=>plan.trucks.flatMap(truck=>truck.loads||[]).find(load=>load.id===loadId);
const cargo=order=>(order.items||[]).map(item=>({line:item.lineRowId,item:item.itemId,quantity:item.quantity,unit:item.unit}));

const affectedFeedRefs=['GOA-10208-10209S1','GOA-9140S1-9143S1','GOA-9948S1-9949S1',
 'GOB-122477-122479S3','GOM-6894S1-6895S1','GOM-6894S2-6895S2'];
export async function repairLinkedPoFeedDefinitions({apply=false,refs=affectedFeedRefs}={}) {
 assert.ok(refs.every(value=>affectedFeedRefs.includes(value)),'Only the confirmed incident definitions may be corrected');
 return withTransaction(async()=>{
  await query("SET LOCAL lock_timeout='3s'");await query("SET LOCAL statement_timeout='20s'");
  await query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
  const rows=(await query("SELECT group_ref,full_order FROM dispatch_global_order_groups WHERE active AND order_type='SO' AND group_ref=ANY($1::text[]) ORDER BY group_ref FOR UPDATE",[refs])).rows;
  assert.equal(rows.length,new Set(refs).size,'A reviewed group is missing or inactive');
  const projected=await enrichDispatchOrdersWithPoTargetAllocations(rows.map(row=>stripDispatchPoAllocationProjection(row.full_order)));
  const corrected=[],audits=[];
  for(const [index,row] of rows.entries()) {
   const next=projected[index];assert.deepEqual(cargo(next),cargo(row.full_order),'Feed cargo changed');
   const missing=next.items.some((item,i)=>Number(item.poAllocatedSalesQty)>0&&!(Number(row.full_order.items?.[i]?.poAllocatedSalesQty)>0));
   if(!missing)continue;
   await query('UPDATE dispatch_global_order_groups SET full_order=$2::jsonb,card=$3::jsonb,search_text=$4,updated_at=now() WHERE group_ref=$1',
    [row.group_ref,JSON.stringify(next),JSON.stringify(compactDispatchOrderCard(next)),dispatchOrderSearchText(next)]);
   const audit=await writeDispatchAudit({action:'dispatch.linked_po_feed_corrected',entityType:'dispatch_global_order_group',entityId:row.group_ref,orderId:row.group_ref,source:'support',sessionId:'linked-po-pickup-20261028',
    before:row.full_order,after:next,details:{reason:'Restore missing active PO sales allocations after split source rebuild; quantities and plan history unchanged'}});
   corrected.push(row.group_ref);audits.push(audit.id);
  }
  if(corrected.length)await query('UPDATE dispatch_order_catalog_state SET generation=generation+1,updated_at=now() WHERE singleton=true');
  return {applied:apply,rolledBack:!apply,corrected,audits};
 },{rollback:!apply});
}

export async function repairLinkedPoPickup({apply=false,expectedRevision=null}={}) {
 return withTransaction(async()=>{
  await query("SET LOCAL lock_timeout='3s'");await query("SET LOCAL statement_timeout='20s'");
  await query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
  const row=(await query(`SELECT p.*,s.orders,s.trucks,s.summary,s.saved_at FROM dispatch_plans p
   JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1 FOR UPDATE OF p,s`,[planId])).rows[0];
  assert.ok(row,'Missing incident plan');const before=persistedDispatchPlan(row);
  if(expectedRevision!==null)assert.equal(before.revision,Number(expectedRevision),'Plan revision changed');
  assert.ok(!apply||expectedRevision!==null,'Apply requires the reviewed revision');
  const load=findLoad(before);assert.ok(load,'Missing incident load');
  const definition=(await query('SELECT * FROM dispatch_global_order_groups WHERE group_ref=$1 FOR UPDATE',[ref])).rows[0];
  assert.ok(definition,'Missing group definition');
  const original=before.orders.find(order=>order.id===ref);assert.ok(original,'Missing plan order');
  const [projected,feed]=await enrichDispatchOrdersWithPoTargetAllocations([original,definition.full_order].map(stripDispatchPoAllocationProjection));
  for(const order of [projected,feed])assert.deepEqual(dispatchRequiredPickupVisitLocations(order,before),['TECHO BLOC Vaughan'],'Source pickup still has cargo');
  assert.deepEqual(cargo(projected),cargo(original),'Plan cargo changed');
  assert.deepEqual(cargo(feed),cargo(definition.full_order),'Feed cargo changed');
  const stop=load.stops.find(entry=>entry.id===stopId);
  if(!stop) {
   assert.deepEqual(dispatchRequiredPickupVisitLocations(definition.full_order,before),['TECHO BLOC Vaughan'],'Feed still needs correction');
   return {alreadyCorrect:true,revision:before.revision};
  }
  assert.equal(stop.type,'pick');assert.equal(stop.location,'150');assert.equal(stop.orderId,ref);assert.deepEqual(stop.orderRefs,[ref]);
  const records=(await query('SELECT * FROM driver_job_records WHERE plan_id=$1 ORDER BY id FOR UPDATE',[planId])).rows;
  const activity=records.filter(record=>['in_progress','complete'].includes(record.status));
  const assignment=(await query('SELECT completed FROM dispatch_plan_load_assignments WHERE plan_id=$1 AND load_id=$2 FOR UPDATE',[planId,loadId])).rows[0];
  assert.notEqual(assignment?.completed,true,'Completed load is protected');
  assert.ok(load.stops.findIndex(entry=>entry.id===stopId)>dispatchLoadProtectedBoundary(load,activity),'Target pickup is protected by started work');
  assert.ok(!records.some(record=>record.stop_id===stopId&&(record.started_at||record.completed_at)),'Target pickup has recorded activity');
  let next=reconcileAuthoritativeDispatchOrderProjection({plan:before,projectedOrders:[projected],activity}).plan;
  next=overlayLockedLoadDerivedSchedule(before,next,new Set(),{activityStatuses:activity});
  const corrected=findLoad(next);
  assert.deepEqual(corrected.stops.map(entry=>entry.id),load.stops.filter(entry=>entry.id!==stopId).map(entry=>entry.id),'Unexpected route change');
  for(const truck of before.trucks)for(const prior of truck.loads||[])if(prior.id!==loadId) {
   assert.deepEqual(next.trucks.flatMap(t=>t.loads||[]).find(l=>l.id===prior.id),prior,'Another load changed');
  }
  const boundary=dispatchLoadProtectedBoundary(load,activity);
  assert.deepEqual(corrected.stops.slice(0,boundary+1),load.stops.slice(0,boundary+1),'Started work changed');
  await query(`INSERT INTO dispatch_plan_snapshot_history(plan_id,plan_date,revision,orders,trucks,summary,original_saved_at,archive_reason,session_id)
   VALUES($1,$2::date,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,'linked_po_feed_pickup_correction','linked-po-pickup-20261028')`,
  [planId,before.planDate,before.revision,JSON.stringify(before.orders),JSON.stringify(before.trucks),JSON.stringify(before.summary),before.savedAt]);
  next.revision=Number((await query('UPDATE dispatch_plans SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING revision',[planId])).rows[0].revision);
  const counts=dispatchPlanBoard(next);
  await query(`UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb,plan_digest=$4,saved_at=now(),order_count=$5,truck_count=$6,load_count=$7,stop_count=$8 WHERE plan_id=$1`,
   [planId,JSON.stringify(next.orders),JSON.stringify(next.trucks),digestDispatchPlan(next),next.orders.length,counts.truckCount,counts.loadCount,counts.stopCount]);
  await syncDispatchPlanLoadProjection(next);await syncDispatchPlanOrderAssignments(next);await syncDispatchPlanRelationEdges(next);
  await query('UPDATE dispatch_global_order_groups SET full_order=$2::jsonb,card=$3::jsonb,search_text=$4,updated_at=now() WHERE group_ref=$1',
   [ref,JSON.stringify(feed),JSON.stringify(compactDispatchOrderCard(feed)),dispatchOrderSearchText(feed)]);
  await query('UPDATE dispatch_order_catalog_state SET generation=generation+1,updated_at=now() WHERE singleton=true');
  assert.deepEqual((await query('SELECT * FROM driver_job_records WHERE plan_id=$1 ORDER BY id',[planId])).rows,records,'Driver evidence changed');
  const audit=await writeDispatchAudit({action:'dispatch.linked_po_feed_pickup_corrected',entityType:'dispatch_plan',entityId:String(planId),orderId:ref,loadId,planId,planDate:before.planDate,source:'support',sessionId:'linked-po-pickup-20261028',
   before:{revision:before.revision,stop,groupDefinition:definition.full_order},after:{revision:next.revision,requiredPickups:['TECHO BLOC Vaughan'],groupDefinition:feed},
   details:{reason:'Split source rebuild retained PO manifest but dropped allocated sales quantities',driverProgressPreserved:true}});
  return {applied:apply,rolledBack:!apply,planId,ref,beforeRevision:before.revision,revision:next.revision,removedStopId:stopId,auditId:audit.id,requiredPickups:['TECHO BLOC Vaughan'],driverProgressPreserved:true};
 },{rollback:!apply});
}
