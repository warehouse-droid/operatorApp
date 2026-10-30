// @ts-check
import crypto from 'node:crypto';
import {query} from '../db.js';
import {DISPATCH_FLEET_PLANNING_LOCK} from '../dispatch-fleet-status.js';
import {getDispatchCustomOrderForUpdate} from '../dispatch-custom-order-repository.js';
import {executeMbtCommand} from './command-repository.js';
import {binWorkflowOrder,binWorkflowParts,binWorkflowSite,mandatoryStop} from './bin-order-workflow-repository.js';
import {getBinOrderWorkflow} from './bin-order-workflow-service.js';
import {assertPlanningAccess,readPlanningPlan} from './bin-planning-repository.js';
import {withAffectedPlans,withdrawAffected,rebuildAssignments,finishPlans} from './bin-selection-service.js';
import {updateBinWorkflowSteps} from './bin-selection-snapshot.js';
import {normalizeBinCargo,binCargoSteps} from './bin-cargo-domain.js';
import {cargoError,orderedBinCargo,binCargoYards,savedBinCargo,assertBinCargoPayload,assertCustomOrderNotInBin,binCargoDraft} from './bin-cargo-repository.js';

/** @param {string} visitId @param {boolean} [lock] */
async function cargoContext(visitId,lock=false) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(String(visitId))) {throw cargoError('Choose a valid BIN visit.',400);}
  const root=await binWorkflowOrder(visitId,lock),parts=await binWorkflowParts(root.service_visit_id);
  const {target,role}=await cargoTarget(root,parts,visitId,lock);
  const guards=[root,...(target && target.service_visit_id!==root.service_visit_id?[target]:[])];
  const started=(await query(`SELECT 1 FROM mbt_visit_steps WHERE service_visit_id=$1 AND (started_at IS NOT NULL OR status IN ('in_progress','completed')) LIMIT 1`,[target?.service_visit_id || root.service_visit_id])).rowCount;
  const final=target?.service_snapshot.mandatoryStops.filter((/** @type {any} */ s)=>!s.actionCode.startsWith('cargo_')).at(-1);
  return {root,target,role,guards,reason:cargoLockReason(root,target,role,final,started),plans:await cargoPlans(target),visits:target?[target]:[],
    destination:final?.location || binWorkflowSite(root)};
}
/** @param {any} root @param {any[]} parts @param {string} visitId @param {boolean} lock */
async function cargoTarget(root,parts,visitId,lock) {
  const part=parts.find((/** @type {any} */ p)=>p.visit_id===visitId)
    || parts.find((/** @type {any} */ p)=>p.part_role===(root.order_kind==='collection'?'collection':'delivery'));
  const target=part ? (await query(`SELECT * FROM mbt_service_visits WHERE service_visit_id=$1 ${lock?'FOR UPDATE':''}`,[part.visit_id])).rows[0] : null;
  const role=part?.part_role || (root.order_kind==='collection'?'collection':'delivery');
  return {target,role};
}
/** @param {any} visit */
function linkedTransportCargo(visit) {return Boolean(visit.service_snapshot?.binWorkflow?.source?.transportTripId);}
/** @param {any} root @param {any} target @param {string} role @param {any} final @param {any} started */
function cargoLockReason(root,target,role,final,started) {
  const visit=target || root;
  let reason=null;
  if (linkedTransportCargo(visit)) {reason='This delivery is linked to a transport trip. Remove that link in Plan transport before changing its cargo.';}
  if (started || visit.actual_started_at || ['completed','cancelled','in_progress','evidence_pending'].includes(visit.status)) {reason='This BIN work has started or finished. Its cargo route is locked.';}
  if (root.status==='cancelled' || root.rental_status==='closed') {reason='This BIN order is closed.';}
  if (role==='collection' && (!final || final.actionCode!=='return_bin')) {reason='Add cargo in the receiving Plan Delivery, or configure a return yard first.';}
  return reason;
}
/** @param {any} target */
async function cargoPlans(target) {
  const plans=[];
  if (target?.dispatch_plan_id) {const p=await readPlanningPlan(target.dispatch_plan_id);plans.push({planId:p.id,planDate:p.planDate,baseRevision:p.revision,baseDigest:p.digest});}
  return plans;
}
/** @param {any} context */
async function customChoices(context) {
  return (await query(`SELECT c.id::text,c.ref_number AS "refNumber",c.order_details AS "orderDetails",
    c.pickup_location AS "pickupLocation",c.dropoff_location AS "dropoffLocation",c.weight_lbs::float AS "weightLbs",c.updated_at AS "updatedAt"
    FROM dispatch_custom_orders c WHERE c.status='open' AND NOT c.system_managed AND c.order_kind='custom'
      AND c.mbt_source IS DISTINCT FROM 'frontdesk_aggregate'
      AND NOT EXISTS (SELECT 1 FROM mbt_bin_cargo_plans b WHERE b.custom_order_id=c.id AND b.completed_at IS NULL
        AND (b.order_id<>$1 OR b.part_role<>$2))
      AND NOT EXISTS (SELECT 1 FROM local_co_orders co WHERE co.source_order_ref=c.ref_number AND co.status<>'cancelled')
      AND NOT EXISTS (SELECT 1 FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id,
        jsonb_array_elements(s.trucks) t,jsonb_array_elements(t->'loads') l,jsonb_array_elements(l->'stops') stop
        WHERE p.status<>'cancelled' AND lower(stop->>'orderId')=lower(c.ref_number))
    ORDER BY c.updated_at DESC,c.id DESC LIMIT 500`,[context.root.service_visit_id,context.role])).rows;
}
/** @param {string} visitId */
export async function getBinCargoOptions(visitId) {
  const context=await cargoContext(visitId),{root,target,role}=context;
  const orderedMaterials=await orderedBinCargo(root,role),saved=await savedBinCargo(root.service_visit_id,role);
  const cargo=binCargoDraft(saved?.plan,orderedMaterials);
  return JSON.parse(JSON.stringify({orderId:root.service_visit_id,visitId:target?.service_visit_id || root.service_visit_id,
    reference:target?.service_snapshot.binWorkflow.reference || root.display_reference,role,
    revision:Number(root.workflow_revision),expectedVisits:context.guards.map((/** @type {any} */ v)=>({visitId:v.service_visit_id,revision:Number(v.revision)})),
    editable:!context.reason,reason:context.reason,plans:context.plans,orderedMaterials,cargo,
    destination:context.destination,yards:await binCargoYards(),customOrders:await customChoices(context),
    steps:target?.service_snapshot.mandatoryStops || [],
    window:{startAt:(target || root).scheduled_start_at,endAt:(target || root).scheduled_end_at}}));
}
/** @param {any} context @param {any} input */
function assertFences(context,input) {
  if (context.reason) {throw cargoError(context.reason);}
  if (input.expectedRevision!==Number(context.root.workflow_revision)) {throw cargoError('The BIN cargo workflow changed. Refresh before saving.');}
  const visits=Array.isArray(input.expectedVisits)?input.expectedVisits:[];
  if (visits.length!==context.guards.length || context.guards.some((/** @type {any} */ v)=>!visits.some((/** @type {any} */ e)=>e.visitId===v.service_visit_id && e.revision===Number(v.revision)))) {
    throw cargoError('A BIN visit changed. Refresh before saving its cargo.');
  }
  const plans=Array.isArray(input.plans)?input.plans:[];
  if (plans.length!==context.plans.length || context.plans.some((/** @type {any} */ p)=>!plans.some((/** @type {any} */ e)=>e.planId===p.planId && e.planDate===p.planDate))) {
    throw cargoError('A current edit lease and revision are required for every affected plan.');
  }
}
/** @param {any} context @param {any} input */
async function selectedCustomOrder(context,input) {
  const custom=input.cargo?.custom;
  if (input.cargo?.mode!=='custom' || custom?.source!=='existing') {return null;}
  if (!/^\d+$/u.test(String(custom.orderId))) {throw cargoError('Choose an existing Custom Order.',400);}
  const order=await getDispatchCustomOrderForUpdate(custom.orderId);
  assertOpenCustom(order);
  if (Date.parse(custom.expectedUpdatedAt)!==new Date(order.updatedAt).getTime()) {throw cargoError('The Custom Order changed. Refresh its details.');}
  await assertCustomOrderNotInBin(order.id,context.root.service_visit_id,context.role);
  if (!(await customChoices(context)).some((/** @type {any} */ o)=>o.id===order.id)) {throw cargoError('This Custom Order is already planned or has an active transit order.');}
  return order;
}
/** @param {any} order @returns {asserts order} */
function assertOpenCustom(order) {
  if (!order || order.status!=='open' || order.systemManaged || order.orderKind!=='custom') {throw cargoError('Choose an open, independently editable Custom Order.');}
}
/** @param {any} root @param {string} role @param {any} cargo @param {string} actorId */
async function storeCargoPlan(root,role,cargo,actorId) {
  await query(`INSERT INTO mbt_bin_cargo_plans(order_id,part_role,plan,custom_order_id,created_by,updated_by)
    VALUES ($1,$2,$3::jsonb,$4,$5,$5) ON CONFLICT(order_id,part_role) DO UPDATE SET plan=EXCLUDED.plan,
    custom_order_id=EXCLUDED.custom_order_id,updated_by=EXCLUDED.updated_by,updated_at=now(),completed_at=NULL`,
  [root.service_visit_id,role,JSON.stringify(cargo),cargo.custom?.orderId || null,actorId]);
}
/** Runs inside the workflow command transaction, before its steps are rebuilt.
 * @param {any} root @param {any} flow @param {any} input */
export async function saveWorkflowCargo(root,flow,input) {
  const selectedRole=input.cargoRole || (root.order_kind==='collection'?'collection':'delivery');
  if (input.cargo!==undefined && !flow.parts.some((/** @type {any} */ p)=>p.role===selectedRole)) {throw cargoError('Choose a valid cargo part.',400);}
  for (const part of flow.parts) {await saveWorkflowPartCargo(root,part,input,selectedRole);}
}
/** @param {any} root @param {any} part @param {any} input @param {string} selectedRole */
async function saveWorkflowPartCargo(root,part,input,selectedRole) {
  const ordered=await orderedBinCargo(root,part.role),saved=await savedBinCargo(root.service_visit_id,part.role);
  const supplied=input.cargo!==undefined && selectedRole===part.role;
  if (!supplied && !saved?.plan && !ordered.length) {return;}
  const draft=supplied ? input.cargo : binCargoDraft(saved?.plan,ordered);
  const customOrder=await selectedCustomOrder({root,role:part.role},{cargo:draft});
  let cargo;
  try {
    cargo=normalizeBinCargo(draft,{orderedMaterials:ordered,yards:await binCargoYards(),destination:part.steps.at(-1).location,customOrder});
    binCargoSteps(part.steps,cargo);
  } catch(error) {throw cargoError(error instanceof Error?error.message:String(error),400);}
  await assertBinCargoPayload(part.binTypeId,cargo);
  await storeCargoPlan(root,part.role,cargo,String(input.actor.operatorId));
}
/** @param {any} context @param {any} cargo @param {string} actorId */
async function persistCargo(context,cargo,actorId) {
  const {root,target,role}=context;
  await storeCargoPlan(root,role,cargo,actorId);
  let configuration=root.configuration;
  if (target) {
    const steps=binCargoSteps(target.service_snapshot.mandatoryStops,cargo).map((s,i)=>mandatoryStop(
      {...s,stopId:s.stopId || `${target.service_visit_id}:${s.actionCode}`},target.service_visit_id,i,target.expected_asset_id));
    const snapshot={...target.service_snapshot,cargoPlan:cargo,mandatoryStops:steps};
    await updateBinWorkflowSteps(target,snapshot,target.expected_asset_id,{asset_id:target.expected_asset_id});
    await query(`UPDATE mbt_service_visits SET service_snapshot=$2::jsonb,revision=revision+1,updated_by=$3,updated_at=now() WHERE service_visit_id=$1`,[target.service_visit_id,JSON.stringify(snapshot),actorId]);
    configuration={...configuration,parts:configuration.parts.map((/** @type {any} */ p)=>p.visitId===target.service_visit_id?{...p,cargoPlan:cargo,steps}:p)};
  }
  await query('UPDATE mbt_bin_orders SET configuration=$2::jsonb,revision=revision+1 WHERE order_id=$1',[root.service_visit_id,configuration?JSON.stringify(configuration):null]);
}
/** @param {any} input @param {any} boundary */
export async function saveBinCargo(input,boundary) {
  input={...input,reason:'Dispatcher updated cargo route'};
  assertPlanningAccess(input,boundary,true);
  const {actor,idempotencyKey,correlationId,requestId,...payload}=input;
  payload.plans=(payload.plans || []).map((/** @type {any} */ p)=>{const {sessionId:_session,editLeaseToken:_token,...fence}=p;return fence;});
  return executeMbtCommand({actor,idempotencyKey,correlationId,requestId,payload,commandName:'mbt.bin_workflow.cargo',mutation:async()=>{
    await query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
    const context=await cargoContext(input.visitId,true);assertFences(context,input);
    const customOrder=await selectedCustomOrder(context,input);
    let cargo;
    try {cargo=normalizeBinCargo(input.cargo,{orderedMaterials:await orderedBinCargo(context.root,context.role),
      yards:await binCargoYards(),destination:context.destination,customOrder});}
    catch(error) {throw cargoError(error instanceof Error?error.message:String(error),400);}
    await assertBinCargoPayload(context.target?.bin_type_id || context.root.bin_type_id,cargo);
    const result=await withAffectedPlans(context,{...input,planOperation:'mbt_bin_cargo'},async()=>{
      const assigned=await withdrawAffected(context,input);
      await persistCargo(context,cargo,actor.operatorId);
      await rebuildAssignments(assigned,input,boundary);
      const plans=await finishPlans(assigned,context,input,boundary);
      return {plans,workflow:await getBinOrderWorkflow(context.root.service_visit_id)};
    });
    await query(`INSERT INTO mbt_bin_workflow_events(event_id,order_id,visit_id,action,details) VALUES($1,$2,$3,'cargo_changed',$4::jsonb)`,
    [crypto.randomUUID(),context.root.service_visit_id,context.target?.service_visit_id || null,JSON.stringify({actorId:actor.operatorId,role:context.role,cargo})]);
    return {status:200,body:{workflow:result.workflow,plans:result.plans},audit:{action:'mbt.bin_workflow.cargo',entityType:'mbt_bin_order',
      entityId:context.root.service_visit_id,beforeState:{revision:Number(context.root.workflow_revision)},afterState:{cargo,revision:result.workflow.revision},
      reason:'Dispatcher updated cargo route',revisionBefore:Number(context.root.workflow_revision),revisionAfter:result.workflow.revision,source:'bin_planning'}};
  }});
}
