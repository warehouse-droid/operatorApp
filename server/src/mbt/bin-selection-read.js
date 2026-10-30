// @ts-check
import { query } from "../db.js";
import { binWorkflowOrder, binWorkflowParts } from "./bin-order-workflow-repository.js";
import { readPlanningPlan } from "./bin-planning-repository.js";

/** Follow only the selected physical bin's future work, never an exchange's old bin.
 * @param {any} root @param {any} delivery */
async function affectedVisits(root, delivery) {
  if (!delivery) {return [];}
  const assetId=delivery.expected_asset_id || delivery.outgoing_asset_id;
  return (await query(`WITH RECURSIVE edges(a,b) AS (
      SELECT d.prerequisite_visit_id,d.dependent_visit_id FROM mbt_bin_workflow_dependencies d
      JOIN mbt_service_visits v ON v.service_visit_id=d.dependent_visit_id
      WHERE COALESCE(v.expected_asset_id,v.outgoing_asset_id)=$3
      UNION SELECT $1::uuid,v.service_visit_id FROM mbt_service_visits v
      WHERE v.predecessor_visit_id=$2 AND v.expected_asset_id=$3 AND v.service_line_id=$4
        AND NOT EXISTS(SELECT 1 FROM mbt_bin_order_parts p WHERE p.order_id=v.service_visit_id)
    ), chain(id) AS (SELECT $1::uuid UNION SELECT e.b FROM edges e JOIN chain c ON c.id=e.a)
    SELECT v.*,p.order_id,p.part_role FROM chain c JOIN mbt_service_visits v ON v.service_visit_id=c.id
    LEFT JOIN mbt_bin_order_parts p ON p.visit_id=v.service_visit_id ORDER BY v.service_visit_id`,
  [delivery.service_visit_id,root.service_visit_id,assetId,root.service_line_id])).rows;
}

/** @param {string} visitId @param {boolean} [lock] */
export async function binSelectionContext(visitId, lock=false) {
  const root=await binWorkflowOrder(visitId,lock),parts=await binWorkflowParts(root.service_visit_id);
  const part=parts.find((/** @type {any} */ p)=>p.part_role==="delivery");
  const deliveryId=part?.visit_id || (!parts.length && root.order_kind!=="collection" ? root.service_visit_id : null);
  const delivery=deliveryId ? (await query("SELECT * FROM mbt_service_visits WHERE service_visit_id=$1",[deliveryId])).rows[0] : null;
  const visits=await affectedVisits(root,delivery);
  const rootIds=[...new Set([root.service_visit_id,...visits.map((/** @type {any} */ v)=>v.order_id || v.service_visit_id)])];
  const guards=(await query(`SELECT v.* FROM mbt_service_visits v WHERE v.service_visit_id=ANY($1::uuid[])
      OR v.service_visit_id IN (SELECT visit_id FROM mbt_bin_order_parts WHERE order_id=ANY($2::uuid[]))
      ORDER BY v.service_visit_id ${lock ? "FOR UPDATE OF v" : ""}`,
  [[...new Set([...rootIds,...visits.map((/** @type {any} */ v)=>v.service_visit_id)])],rootIds])).rows;
  const started=(await query(`SELECT 1 FROM mbt_visit_steps WHERE service_visit_id=ANY($1::uuid[])
    AND (started_at IS NOT NULL OR status IN ('in_progress','completed')) LIMIT 1`,[guards.map((/** @type {any} */ v)=>v.service_visit_id)])).rowCount;
  const linked=delivery && (await query("SELECT 1 FROM mbt_bin_order_parts WHERE linked_delivery_visit_id=$1 LIMIT 1",[deliveryId])).rowCount;
  const reason=selectionReason({visitId,root,parts,delivery,guards,started,linked});
  const plans=[];
  for (const id of [...new Set(visits.map((/** @type {any} */ v)=>v.dispatch_plan_id).filter(Boolean))]) {
    const p=await readPlanningPlan(id);
    plans.push({planId:p.id,planDate:p.planDate,baseRevision:p.revision,baseDigest:p.digest});
  }
  plans.sort((a,b)=>a.planDate.localeCompare(b.planDate) || a.planId.localeCompare(b.planId));
  return {root,delivery,visits,guards,plans,reason};
}

/** @param {any} context */
function selectionReason({visitId,root,parts,delivery,guards,started,linked}) {
  const targetReason=selectionTargetReason(visitId,root,delivery);
  if (targetReason) {return targetReason;}
  if (!parts.length && root.order_kind==="exchange") {return "Plan the exchange's delivery and collection route before changing its replacement bin.";}
  if (linked || linkedSource(root,delivery)) {
    return "This delivery is linked to a collection and dump. Keep the linked physical bin.";
  }
  if (started || guards.some((/** @type {any} */ v)=>v.actual_started_at || ["in_progress","evidence_pending","completed","cancelled"].includes(v.status))) {
    return "A BIN stop in this order or its dependent work has started. The assigned bin is locked.";
  }
  return root.rental_status==="closed" ? "This BIN rental is closed." : null;
}

/** @param {any} context @param {any[]} assets */
export async function binSelectionOptions(context,assets) {
  const choices=assets.filter(a=>a.bin_type_id===context.root.bin_type_id && a.availability?.available
    && (a.availability.location.kind!=="truck" || !context.delivery?.planned_truck_id
      || String(a.availability.location.id)===String(context.delivery.planned_truck_id)));
  return {eligible:!context.reason,reason:context.reason,
    visitId:context.delivery?.service_visit_id || null,
    currentAssetId:context.delivery?.expected_asset_id || context.delivery?.outgoing_asset_id || null,
    expectedVisits:context.guards.map((/** @type {any} */ v)=>({visitId:v.service_visit_id,revision:Number(v.revision)})),
    plans:context.plans,choices};
}

/** @param {any} root @param {any} delivery */
function linkedSource(root,delivery) {
  return root.configuration?.reuse==="same_bin" || (delivery.service_snapshot?.binWorkflow?.source?.planned
    && !delivery.service_snapshot.binWorkflow.source.availabilityPredecessorId);
}

/** @param {string} visitId @param {any} root @param {any} delivery */
function selectionTargetReason(visitId,root,delivery) {
  if (!delivery || ![String(root.service_visit_id),String(delivery.service_visit_id)].includes(visitId)) {
    return "The collection keeps its physical bin. Select the delivery to change its assigned bin.";
  }
  return !delivery.expected_asset_id && !delivery.outgoing_asset_id
    ? "Choose the initial bin in Plan delivery before changing its assignment." : null;
}
