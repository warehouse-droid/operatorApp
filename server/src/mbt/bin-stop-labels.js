// @ts-check
import { query } from "../db.js";
import { binVisitDisplayReference } from "./bin-order-workflow-repository.js";

/** @param {any} visit @param {any} stop */
export function binStopAssetId(visit,stop) {
  if (stop.assetId) {return stop.assetId;}
  if (/^(pickup|dump|return)/u.test(stop.actionCode) && visit.incoming_asset_id) {return visit.incoming_asset_id;}
  return visit.expected_asset_id || visit.outgoing_asset_id || null;
}

/** Resolve physical identity from the assignment being displayed, not today's asset state.
 * @param {any} stop @param {any[]} snapshots
 */
function assignedStop(stop,snapshots) {
  const snapshot=snapshots.find(row=>row.service_visit_id===stop.mbt.visitId
    && row.snapshot?.stops?.some((/** @type {any} */ s)=>s.id===stop.id))?.snapshot;
  const saved=snapshot?.stops.find((/** @type {any} */ s)=>s.id===stop.id) || stop;
  const reservations=snapshot?.assetReservations || [];
  const incoming=reservations.find((/** @type {any} */ r)=>r.reservationSlot==="incoming");
  const outgoing=reservations.find((/** @type {any} */ r)=>r.reservationSlot==="outgoing");
  const assetId=binStopAssetId({incoming_asset_id:incoming?.assetId,outgoing_asset_id:outgoing?.assetId},saved);
  return {assetId,reference:saved.reference,assetCode:saved.assetCode};
}

/** Read-only labels are returned beside a plan and never persisted into frozen stops.
 * @param {any} plan
 */
export async function binStopLabels(plan) {
  const stops=(plan.trucks || []).flatMap((/** @type {any} */ t)=>(t.loads || [])
    .flatMap((/** @type {any} */ l)=>(l.stops || []).filter((/** @type {any} */ s)=>s.mbt?.visitId)));
  if (!stops.length) {return {};}
  const ids=[...new Set(stops.map((/** @type {any} */ s)=>s.mbt.visitId))];
  const snapshots=(await query(`SELECT service_visit_id::text,snapshot FROM mbt_bin_planning_assignments
    WHERE plan_id=$1 AND service_visit_id=ANY($2::uuid[]) ORDER BY generation DESC`,[plan.id,ids])).rows;
  const direct=(await query(`SELECT service_visit_id::text,dispatch_assignment_snapshot AS snapshot
    FROM mbt_service_visits WHERE dispatch_plan_id=$1 AND service_visit_id=ANY($2::uuid[])`,[plan.id,ids])).rows;
  snapshots.push(...direct);
  const resolved=stops.map((/** @type {any} */ stop)=>({stop,...assignedStop(stop,snapshots)}));
  const assets=(await query("SELECT asset_id,asset_code FROM mbt_bin_assets WHERE asset_id=ANY($1::uuid[])",
    [resolved.map((/** @type {any} */ r)=>r.assetId).filter(Boolean)])).rows;
  /** @type {Record<string, any>} */
  const labels={};
  for (const item of resolved) {
    labels[item.stop.id]={reference:item.reference || await binVisitDisplayReference(item.stop.mbt.visitId,item.stop.actionCode)
      || item.stop.mbt.visitReference,
    assetCode:item.assetCode || assets.find((/** @type {any} */ a)=>a.asset_id===item.assetId)?.asset_code || ""};
  }
  return labels;
}
