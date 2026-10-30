// @ts-check
import {binAvailability,availableBinSource,assertBinAvailabilityDependencies} from "./bin-availability.js";
import { query, afterTransactionCommit } from "../db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../dispatch-fleet-status.js";
import { withDispatchPlanWrite } from "../dispatch-plan-write.js";
import { executeMbtCommand } from "./command-repository.js";
import { binWorkflowAsset, binWorkflowError } from "./bin-order-workflow-repository.js";
import { binSelectionContext } from "./bin-selection-read.js";
import { updateSelectedBin } from "./bin-selection-snapshot.js";
import { refreshBinSelectionRoutes } from "./bin-selection-routing.js";
import { cancelVisit, assignVisit } from "./bin-planning-service.js";
import { publishPlanningAssignments } from "./bin-planning-assignments.js";
import { assertPlanningAccess, readPlanningPlan, lockPlanningVisit, planningLoad,
  persistPlanningPlan, assertPlanningSchedule, syncPlanningProjections } from "./bin-planning-repository.js";
import { assertPlanningCapacity } from "./bin-planning-capacity.js";
import { assertBinWorkflowPlanDependencies } from "./bin-order-workflow-planning.js";
import { getBinOrderWorkflow } from "./bin-order-workflow-service.js";

/** @param {any} context @param {any} input */
function assertSelectionFences(context,input) {
  if (context.reason) {throw binWorkflowError(409,context.reason,"MBT_BIN_SELECTION_LOCKED");}
  if (Number(context.root.workflow_revision)!==input.expectedRevision) {throw binWorkflowError(409,"The BIN workflow changed. Refresh before selecting again.");}
  const expected=Array.isArray(input.expectedVisits) ? input.expectedVisits : [];
  if (expected.length!==context.guards.length || context.guards.some((/** @type {any} */ v)=>
    !expected.some((/** @type {any} */ e)=>e.visitId===v.service_visit_id && e.revision===Number(v.revision)))) {
    throw binWorkflowError(409,"A dependent BIN visit changed. Refresh before selecting again.");
  }
  const plans=Array.isArray(input.plans) ? input.plans : [];
  if (plans.length!==context.plans.length || context.plans.some((/** @type {any} */ p)=>
    !plans.some((/** @type {any} */ e)=>e.planId===p.planId && e.planDate===p.planDate))) {
    throw binWorkflowError(409,"Edit Mode and a current revision are required for every affected plan date.","DISPATCH_PLAN_EDIT_LEASE_REQUIRED");
  }
}

/** @param {any} context @param {any} input */
async function selectedAsset(context,input) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(String(input.assetId || ""))) {
    throw binWorkflowError(400,"Choose a valid physical bin.");
  }
  const asset=await binWorkflowAsset(input.assetId,true);
  if (Number(asset.state_revision)!==input.expectedStateRevision) {throw binWorkflowError(409,"The selected bin moved or changed. Refresh its source before saving.");}
  if (asset.bin_type_id!==context.root.bin_type_id) {throw binWorkflowError(409,"Choose a bin matching this order's bin type.");}
  asset.planningSource=availableBinSource(await binAvailability(asset,{at:context.delivery.scheduled_start_at,latestPickupAt:context.delivery.scheduled_end_at,
    truckId:context.delivery.planned_truck_id,exclude:context.visits.map((/** @type {any} */ v)=>String(v.service_visit_id))}));
  return asset;
}

/** All affected dates share the outer transaction. @param {any} context @param {any} input @param {Function} mutate @param {number} [index] */
async function withAffectedPlans(context,input,mutate,index=0) {
  const identity=context.plans[index];
  if (!identity) {return mutate();}
  const fence=input.plans.find((/** @type {any} */ p)=>p.planId===identity.planId);
  return withDispatchPlanWrite({planId:identity.planId,operation:input.planOperation || "mbt_bin_selection",request:{...fence,
    commandId:`${input.idempotencyKey}:${identity.planId}`,visitId:input.visitId,
    ...(input.assetId ? {assetId:input.assetId} : {}),...(input.window ? {window:input.window} : {})},
    editLease:{planDate:identity.planDate,operatorId:input.actor.operatorId,sessionId:fence.sessionId,token:fence.editLeaseToken}},async()=>{
    const result=await withAffectedPlans(context,input,mutate,index+1);
    return {...result,plan:await readPlanningPlan(identity.planId)};
  });
}

/** @param {any} context @param {any} input */
async function withdrawAffected(context,input) {
  const assigned=[];
  const originalPlans=new Map();
  for (const visit of context.visits.filter((/** @type {any} */ v)=>v.dispatch_plan_id)) {
    const current=(await query(`SELECT released_at FROM mbt_bin_planning_assignments WHERE service_visit_id=$1
      AND withdrawn_at IS NULL ORDER BY generation DESC LIMIT 1`,[visit.service_visit_id])).rows[0];
    if (!originalPlans.has(visit.dispatch_plan_id)) {
      originalPlans.set(visit.dispatch_plan_id,await readPlanningPlan(visit.dispatch_plan_id));
    }
    const plan=originalPlans.get(visit.dispatch_plan_id);
    const load=planningLoad(plan,visit.dispatch_load_id).load;
    assigned.push({visit,plan,released:current ? Boolean(current.released_at) : plan.status==="confirmed",
      stops:load.stops.filter((/** @type {any} */ s)=>s.mbt?.visitId===visit.service_visit_id)});
    await cancelVisit({...input,visitId:visit.service_visit_id,planId:visit.dispatch_plan_id,expectedVisitRevision:Number(visit.revision),
      idempotencyKey:`${input.idempotencyKey}:withdraw:${visit.service_visit_id}`});
  }
  return assigned;
}

/** @param {any[]} assigned @param {any} input @param {any} boundary */
async function rebuildAssignments(assigned,input,boundary) {
  for (const item of assigned) {
    const visit=await lockPlanningVisit(item.visit.service_visit_id);
    const stops=visit.service_snapshot.mandatoryStops;
    const timing=stops.flatMap((/** @type {any} */ s)=>{
      const old=item.stops.find((/** @type {any} */ previous)=>previous.actionCode===s.actionCode);
      return old?.timing ? [{sequence:s.sequence,arrival:old.timing.arrival,depart:old.timing.depart}] : [];
    });
    const overrides=stops.flatMap((/** @type {any} */ s)=>{
      const old=item.stops.find((/** @type {any} */ previous)=>previous.actionCode===s.actionCode);
      return Number.isFinite(old?.stopTimeOverrideMinutes) ? [{sequence:s.sequence,minutes:old.stopTimeOverrideMinutes}] : [];
    });
    await assignVisit({...input,visitId:visit.service_visit_id,planId:item.plan.id,planDate:item.plan.planDate,
      loadId:item.visit.dispatch_load_id,expectedVisitRevision:Number(visit.revision),
      idempotencyKey:`${input.idempotencyKey}:assign:${visit.service_visit_id}`},boundary,overrides,timing,item.visit);
  }
}

/** @param {any[]} assigned @param {any} context @param {any} input @param {any} boundary */
async function finishPlans(assigned,context,input,boundary) {
  const plans=[];
  for (const identity of context.plans) {
    const items=assigned.filter(i=>i.plan.id===identity.planId);
    const previous=await readPlanningPlan(identity.planId),next=structuredClone(previous);
    for (const item of items) {
      const oldLoad=planningLoad(item.plan,item.visit.dispatch_load_id).load;
      const load=planningLoad(next,item.visit.dispatch_load_id).load;
      const rank=new Map(oldLoad.stops.map((/** @type {any} */ s,/** @type {number} */ i)=>[s.mbt?.visitId,i]));
      load.stops.sort((/** @type {any} */ a,/** @type {any} */ b)=>Number(rank.get(a.mbt?.visitId))-Number(rank.get(b.mbt?.visitId)));
    }
    await refreshBinSelectionRoutes(next,items,input,boundary);
    const saved=await persistPlanningPlan(previous,next);
    assertPlanningSchedule(saved);await assertPlanningCapacity(saved);
    const released=items.filter(i=>i.released).map(i=>i.visit.service_visit_id);
    const plan=await publishPlanningAssignments(saved.id,input.actor.operatorId,saved.revision,released);
    await syncPlanningProjections(plan);plans.push(plan);
  }
  for (const item of assigned) {await assertBinWorkflowPlanDependencies(item.visit.service_visit_id,item.released);}
  await assertBinAvailabilityDependencies([...new Set([...context.visits.flatMap((/** @type {any} */ visit)=>
    [visit.expected_asset_id,visit.outgoing_asset_id,visit.incoming_asset_id]),input.assetId].filter(Boolean))]);
  if (boundary.hooks?.beforeCommit) {await boundary.hooks.beforeCommit();}
  for (const plan of plans) {
    const session=input.plans.find((/** @type {any} */ p)=>p.planId===plan.id).sessionId;
    if (boundary.onCommitted) {afterTransactionCommit(()=>boundary.onCommitted({planId:plan.id,planDate:plan.planDate,revision:plan.revision,sourceSessionId:session}));}
  }
  return plans;
}

/** @param {any} input @param {any} boundary */
export async function changeAssignedBin(input,boundary) {
  assertPlanningAccess(input,boundary,true);
  const {actor,idempotencyKey,correlationId,requestId,...payload}=input;
  // A retry may reacquire an expired lease. Credentials authorize a new write;
  // only the operation and revision fences identify its durable receipt.
  payload.plans=(payload.plans || []).map((/** @type {any} */ plan)=>{
    const {sessionId:_session,editLeaseToken:_token,...fence}=plan;
    return fence;
  });
  try {
    return await executeMbtCommand({actor,idempotencyKey,correlationId,requestId,payload,commandName:"mbt.bin_workflow.bin_selection",
      mutation:async()=>{
        await query("SELECT pg_advisory_xact_lock(hashtext($1))",[DISPATCH_FLEET_PLANNING_LOCK]);
        const context=await binSelectionContext(input.visitId,true);
        assertSelectionFences(context,input);
        const asset=await selectedAsset(context,input);
        const result=await withAffectedPlans(context,input,async()=>{
          const assigned=await withdrawAffected(context,input);
          await updateSelectedBin(context,asset,actor.operatorId);
          await rebuildAssignments(assigned,input,boundary);
          const plans=await finishPlans(assigned,context,input,boundary);
          return {workflow:await getBinOrderWorkflow(context.root.service_visit_id),plans};
        });
        const body={workflow:result.workflow,plans:result.plans};
        return {status:200,body,audit:{action:"mbt.bin_workflow.bin_selection",entityType:"mbt_bin_order",entityId:context.root.service_visit_id,
          beforeState:{assetId:context.delivery.expected_asset_id,revision:Number(context.root.workflow_revision)},
          afterState:{assetId:asset.asset_id,revision:body.workflow.revision},reason:input.reason || "Change assigned bin",
          revisionBefore:Number(context.root.workflow_revision),revisionAfter:body.workflow.revision,source:"bin_planning"}};
      }});
  } catch (error) {
    const e=/** @type {any} */ (error);
    if (e.status && e.code) {throw binWorkflowError(e.status,e.message,e.code);}
    throw error;
  }
}

// Shared assignment fencing and republishing for time-window edits.
export { withAffectedPlans, withdrawAffected, rebuildAssignments, finishPlans };
