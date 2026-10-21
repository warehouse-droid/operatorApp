// @ts-check
import crypto from "node:crypto";
import { query } from "../db.js";
import { binWorkflowAsset, binWorkflowError } from "./bin-order-workflow-repository.js";
import { binLocalDate } from "./bin-order-workflow-domain.js";

/** @param {string} visitId @param {string} assetId */
async function connectedAssetVisits(visitId, assetId) {
  const {rows} = await query(`WITH RECURSIVE edges(a,b) AS (
    SELECT d.dependent_visit_id,d.prerequisite_visit_id FROM mbt_bin_workflow_dependencies d
    JOIN mbt_bin_order_parts p ON p.visit_id=d.dependent_visit_id
    JOIN mbt_bin_order_parts q ON q.visit_id=d.prerequisite_visit_id WHERE p.asset_id=$2 AND q.asset_id=$2
  ), ancestors(id) AS (SELECT $1::uuid UNION SELECT b FROM edges JOIN ancestors ON a=id),
     descendants(id) AS (SELECT $1::uuid UNION SELECT a FROM edges JOIN descendants ON b=id)
    SELECT id FROM ancestors UNION SELECT id FROM descendants`,[visitId,assetId]);
  return new Set(rows.map((/** @type {any} */ r)=>String(r.id)));
}

/** @param {any} visit @param {any} asset @param {string} truckId */
async function assertWorkflowCustody(visit, asset, truckId) {
  const prior = await query(`SELECT s.status FROM mbt_bin_workflow_dependencies d
    JOIN mbt_bin_order_parts p ON p.visit_id=d.prerequisite_visit_id
    JOIN mbt_visit_steps s ON s.service_visit_id=p.visit_id AND s.action_code=d.prerequisite_action_code
    WHERE d.dependent_visit_id=$1 AND p.asset_id=$2`,[visit.service_visit_id,asset.asset_id]);
  if (prior.rows.some((/** @type {any} */ r)=>r.status !== "completed")) {return;}
  if (asset.location_kind === "truck") {
    if (String(asset.truck_id) !== String(truckId)) {
      throw binWorkflowError(409,"This bin is on another truck. Record its physical handoff before assigning this truck.");
    }
    if (!visit.actual_started_at && visit.service_snapshot.binWorkflow.role === "delivery"
        && !/dump|empty/u.test(String(asset.movement_type))) {
      throw binWorkflowError(409,"The bin aboard this truck has no confirmed empty-bin movement or completed dump.");
    }
    return;
  }
  if (visit.actual_started_at) {return;} // Each remaining driver action rechecks exact custody.
  const workflow=visit.service_snapshot.binWorkflow;
  const source=workflow.role === "collection"
    ? {kind:"customer_site",id:String(visit.customer_site_profile_id)} : workflow.source;
  const identities=/** @type {Record<string,any>} */ ({yard:asset.yard_id,customer_site:asset.customer_site_profile_id,
    dump_site:asset.dump_site_id,truck:asset.truck_id});
  const actualId=identities[asset.location_kind];
  if (!source || source.kind !== asset.location_kind || String(source.id) !== String(actualId)) {
    throw binWorkflowError(409,"The bin has moved since this route was configured. Refresh its pickup location.");
  }
}

/** @param {any} visit @param {any} assignment @param {string} truckId @param {any} input */
export async function reserveBinWorkflowAsset(visit, assignment, truckId, input) {
  const asset=await binWorkflowAsset(assignment.assetId,true);
  if (String(asset.bin_type_id) !== String(visit.bin_type_id)) {throw binWorkflowError(409,"The physical bin type changed.");}
  const legacy=await query("SELECT 1 FROM mbt_bin_asset_reservations WHERE asset_id=$1 AND released_at IS NULL",[asset.asset_id]);
  if (legacy.rowCount) {throw binWorkflowError(409,"The bin is reserved by another issued or legacy visit.");}
  const connected=await connectedAssetVisits(String(visit.service_visit_id),String(asset.asset_id));
  const claims=await query("SELECT * FROM mbt_bin_workflow_claims WHERE asset_id=$1 AND released_at IS NULL FOR UPDATE",[asset.asset_id]);
  if (claims.rows.some((/** @type {any} */ r)=>!connected.has(String(r.visit_id)))) {
    throw binWorkflowError(409,"The bin is reserved by an unrelated order.");
  }
  await assertWorkflowCustody(visit,asset,truckId);
  const reservationId=crypto.randomUUID();
  await query(`INSERT INTO mbt_bin_workflow_claims(claim_id,asset_id,visit_id,truck_id,reserved_from,reserved_until,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,[reservationId,asset.asset_id,visit.service_visit_id,truckId,
    input.reservationStartAt || visit.scheduled_start_at,input.reservationEndAt || visit.scheduled_end_at,input.actor.operatorId]);
  return {reservationId};
}

/** @param {any} visit @param {any} assignment */
export async function validateBinWorkflowClaims(visit, assignment) {
  const {rows}=await query(`SELECT c.*,a.tare_weight_kg,b.maximum_payload_kg FROM mbt_bin_workflow_claims c
    JOIN mbt_bin_assets a ON a.asset_id=c.asset_id JOIN mbt_bin_types b ON b.bin_type_id=a.bin_type_id
    WHERE c.visit_id=$1 AND c.released_at IS NULL FOR UPDATE OF c`,[visit.service_visit_id]);
  const expected=assignment.assetReservations || [];
  if (rows.length !== 1 || expected.length !== 1 || String(rows[0].claim_id) !== expected[0].reservationId
      || String(rows[0].asset_id) !== expected[0].assetId || String(rows[0].truck_id) !== String(visit.planned_truck_id)) {
    throw binWorkflowError(409,"The BIN route reservation changed. Refresh before confirming.");
  }
  const asset=await binWorkflowAsset(String(rows[0].asset_id),true);
  await assertWorkflowCustody(visit,asset,String(visit.planned_truck_id));
  return {requiredWeightLbs:(Number(rows[0].tare_weight_kg)+
    (visit.service_snapshot.binWorkflow.role === "collection" ? Number(rows[0].maximum_payload_kg) : 0))*2.2046226218};
}

/** A load edit must move the logical claim with its visit without moving the bin.
 * @param {any} visit @param {any} load @param {string} truckId @param {string} planDate */
export async function updateBinWorkflowClaim(visit, load, truckId, planDate) {
  if (!visit.service_snapshot?.binWorkflow) {return;}
  const asset=await binWorkflowAsset(String(visit.expected_asset_id),true);
  await assertWorkflowCustody(visit,asset,truckId);
  await query(`UPDATE mbt_bin_workflow_claims SET truck_id=$2,
    reserved_from=(($3::date+$4::int*interval '1 minute') AT TIME ZONE 'America/Toronto'),
    reserved_until=(($3::date+$5::int*interval '1 minute') AT TIME ZONE 'America/Toronto')
    WHERE visit_id=$1 AND released_at IS NULL`,
  [visit.service_visit_id,truckId,planDate,load.plannedStartMinute,load.plannedFinishMinute]);
}

/** @param {any} visit @param {string} action @param {boolean} finish */
async function plannedAction(visit, action, finish) {
  const snapshot=visit.dispatch_assignment_snapshot;
  if (!snapshot || !visit.dispatch_plan_id) {return null;}
  const plan=(await query(`SELECT p.plan_date::text,s.trucks FROM dispatch_plans p
    JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1`,[visit.dispatch_plan_id])).rows[0];
  const truck=plan.trucks.find((/** @type {any} */ t)=>String(t.id)===String(visit.planned_truck_id));
  const load=truck?.loads.find((/** @type {any} */ l)=>String(l.id)===String(visit.dispatch_load_id));
  const index=load?.stops.findIndex((/** @type {any} */ s)=>s.mbt?.visitId===String(visit.service_visit_id) && s.actionCode===action);
  if (!load || index < 0) {return null;}
  const stop=load.stops[index];
  const minute=actionMinute(stop,load,finish);
  if (minute === null || minute === undefined) {throw binWorkflowError(409,"Set load times for the linked BIN steps.");}
  const at=(await query(`SELECT (($1::date+$2::int*interval '1 minute') AT TIME ZONE 'America/Toronto') AS at`,
    [plan.plan_date,minute])).rows[0].at;
  return {at,planId:String(visit.dispatch_plan_id),truckId:String(visit.planned_truck_id),loadId:String(load.id),index};
}

/** @param {any} stop @param {any} load @param {boolean} finish */
function actionMinute(stop,load,finish) {
  return (finish ? stop.timing?.depart : stop.timing?.arrival)
    ?? (finish ? load.plannedFinishMinute : load.plannedStartMinute);
}

/** @param {string} visitId @param {boolean} [requireReady] */
export async function assertBinWorkflowPlanDependencies(visitId, requireReady = true) {
  const {rows:edges}=await query(`SELECT d.*,p.asset_id AS dependent_asset,q.asset_id AS prerequisite_asset,
    s.completed_at,s.status,p.display_reference AS dependent_reference,q.display_reference AS prerequisite_reference
    FROM mbt_bin_workflow_dependencies d
    JOIN mbt_bin_order_parts p ON p.visit_id=d.dependent_visit_id
    JOIN mbt_bin_order_parts q ON q.visit_id=d.prerequisite_visit_id
    JOIN mbt_visit_steps s ON s.service_visit_id=q.visit_id AND s.action_code=d.prerequisite_action_code
    WHERE d.dependent_visit_id=$1 OR d.prerequisite_visit_id=$1`,[visitId]);
  for (const edge of edges) {
    await validateDependencyEdge(edge,visitId,requireReady);
  }
}

/** @param {any} edge @param {string} visitId @param {boolean} requireReady */
async function validateDependencyEdge(edge,visitId,requireReady) {
    const {rows}=await query("SELECT * FROM mbt_service_visits WHERE service_visit_id=ANY($1::uuid[])",
      [[edge.dependent_visit_id,edge.prerequisite_visit_id]]);
    const dependent=rows.find((/** @type {any} */ v)=>v.service_visit_id===edge.dependent_visit_id);
    const prerequisite=rows.find((/** @type {any} */ v)=>v.service_visit_id===edge.prerequisite_visit_id);
    if (dependent.status === "completed") {return;}
    const to=await plannedAction(dependent,edge.dependent_action_code,false);
    const from=edge.status === "completed" ? {at:edge.completed_at}
      : await plannedAction(prerequisite,edge.prerequisite_action_code,true);
    const onward=prerequisite.service_snapshot.binWorkflow?.destination?.kind === "delivery";
    const needsTarget=edge.same_day || onward || String(edge.dependent_visit_id)===visitId;
    if (!to || !from) {
      if (requireReady && needsTarget) {throw binWorkflowError(409,`Plan both ${edge.prerequisite_reference} and ${edge.dependent_reference} before releasing this route.`);}
      return;
    }
    await validateDependencyOrder(edge,prerequisite,from,to);
    await validatePrerequisiteRelease(prerequisite,from,to,
      {requireReady,visitId,dependentVisitId:edge.dependent_visit_id});
}

/** @param {any} edge @param {any} prerequisite @param {any} from @param {any} to */
async function validateDependencyOrder(edge,prerequisite,from,to) {
    const sameLoad=from.planId===to.planId && from.truckId===to.truckId && from.loadId===to.loadId;
    if (sameLoad ? from.index >= to.index : new Date(from.at)>new Date(to.at)) {
      throw binWorkflowError(409,`${edge.dependent_reference} must follow ${edge.prerequisite_reference}.`);
    }
    if (edge.same_day) {await validateSameDayPlan(prerequisite,from,to);}
    if (edge.prerequisite_action_code!=="deliver_bin"
        && edge.dependent_asset===edge.prerequisite_asset && from.truckId && from.truckId!==to.truckId) {
      throw binWorkflowError(409,"Keep this connected bin on the same truck until a physical handoff is recorded.");
    }
}

/** @param {any} prerequisite @param {any} from @param {any} to */
async function validateSameDayPlan(prerequisite,from,to) {
  const pickup=(await query(`SELECT completed_at FROM mbt_visit_steps
    WHERE service_visit_id=$1 AND action_code='pickup_bin'`,[prerequisite.service_visit_id])).rows[0];
  const start=pickup?.completed_at || (await plannedAction(prerequisite,"pickup_bin",false))?.at || from.at;
  if (binLocalDate(start)!==binLocalDate(to.at)) {
    throw binWorkflowError(409,"Collection-first delivery must stay on the same Toronto calendar day.");
  }
}

/** @param {any} prerequisite @param {any} from @param {any} to @param {any} context */
async function validatePrerequisiteRelease(prerequisite,from,to,context) {
    if (!context.requireReady || String(context.dependentVisitId)!==context.visitId) {return;}
    if (from.planId && from.planId!==to.planId) {
      const released=await query(`SELECT 1 FROM mbt_bin_planning_assignments WHERE service_visit_id=$1
        AND withdrawn_at IS NULL AND released_at IS NOT NULL`,[prerequisite.service_visit_id]);
      if (!released.rowCount) {throw binWorkflowError(409,"Release the prerequisite BIN route before its dependent delivery.");}
    }
}
