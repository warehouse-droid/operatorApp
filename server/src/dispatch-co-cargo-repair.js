import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { query, withTransaction, hasActiveTransaction } from "./db.js";
import { applyLocalCoCargo } from "./dispatch-local-co-cargo.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";
import { assertDispatchExecutedPrefixPreserved } from "./dispatch-executed-prefix-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";
import { digestDispatchPlan, dispatchPlanBoard } from "./dispatch-planner-performance.js";
import { compactDispatchOrderCard } from "./dispatch-planner-optimization.js";
import { materializeDispatchPickupVisits } from "./dispatch-pickup-visits.js";
import { syncDispatchPlanOrderAssignments, syncDispatchPlanRelationEdges } from "./dispatch-planner-v2-repository.js";
import { syncDispatchPlanLoadAssignments } from "./dispatch-load-assignment-repository.js";

const executed = (value) => ["in_progress", "complete", "completed"].includes(String(value || "").toLowerCase());
const references = (stop, ref) => stop.orderId === ref || (stop.orderRefs || []).includes(ref);
const requireState = (condition, message) => {
  if (!condition) throw Object.assign(new Error(`CO cargo repair refused: ${message}`), { code: "CO_CARGO_REPAIR_REFUSED" });
};
const lineIdentity = (lines) => lines.map((line) => [line.id,line.line_id,line.item_id,line.quantity,line.pallet_qty].map(Number));

async function readState(target, apply) {
  const suffix = apply ? " FOR UPDATE" : "";
  const plan = (await query(`SELECT p.id,p.plan_date::text AS "planDate",p.status,p.revision,
    s.orders,s.trucks,s.summary,s.saved_at FROM dispatch_plans p
    JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1${suffix}`, [target.planId])).rows[0];
  const co = (await query(`SELECT * FROM local_co_orders WHERE co_ref=$1${suffix}`, [target.coRef])).rows[0];
  requireState(plan && co, "target plan or CO is missing");
  const lines = (await query(`SELECT * FROM local_co_order_lines WHERE co_id=$1 ORDER BY id${apply ? " FOR SHARE" : ""}`, [co.id])).rows;
  const global = (await query(`SELECT * FROM dispatch_global_order_groups WHERE group_ref=$1${suffix}`, [target.coRef])).rows[0];
  const jobs = (await query(`SELECT job_id,status,order_refs FROM driver_job_records
    WHERE plan_id=$1 AND (load_id=$2 OR order_refs ? $3) ORDER BY job_id`, [target.planId,target.loadId,target.coRef])).rows;
  return { plan, co, lines, global, jobs };
}

function repairCandidate(state, target) {
  const { plan, co, lines, jobs } = state;
  requireState(plan.planDate === target.planDate && plan.status === "confirmed", "plan date or status changed");
  requireState(co.source_order_ref === target.sourceOrderRef && co.from_location === target.fromYard && co.to_location === target.toYard, "CO route or source changed");
  requireState(isDeepStrictEqual(lineIdentity(lines), lineIdentity(target.lines)) && lines.length > 0, "unexpected source cargo");
  requireState(co.status === "pending_load" && !co.loaded_at && !co.received_at && !co.preparing_started_at && !jobs.some((job) => executed(job.status)), "executed cargo or load");
  const candidate = structuredClone(plan);
  const order = candidate.orders.find((entry) => entry.id === target.coRef);
  requireState(order && candidate.orders.filter((entry) => entry.id === target.coRef).length === 1, "expected one direct CO snapshot");
  const owners = candidate.trucks.flatMap((truck) => (truck.loads || []).filter((load) => (load.stops || []).some((stop) => references(stop, target.coRef))));
  requireState(owners.length === 1 && owners[0].id === target.loadId && owners[0].driverLogin === target.driverLogin, "CO load ownership changed");
  const load = owners[0];
  requireState(!load.completed && !load.stops.some((stop) => executed(stop.status)), "executed target-load evidence");
  const drops = load.stops.filter((stop) => stop.type === "drop" && references(stop, target.coRef));
  const pickups = load.stops.filter((stop) => stop.type === "pick" && references(stop, target.coRef));
  requireState(drops.length === 1 && pickups.length <= 1, "unexpected CO stops");
  const restored = applyLocalCoCargo(order, { coRef: co.co_ref, cargoLines: lines, details: co.details });
  candidate.orders = candidate.orders.map((entry) => entry === order ? restored : entry);
  let pickupAdded = false;
  if (!pickups.length) {
    const id = `co-cargo-repair-${target.planId}-${co.id}-pickup`;
    requireState(!candidate.trucks.some((truck) => (truck.loads || []).some((entry) => entry.stops.some((stop) => stop.id === id))), "pickup ID collision");
    load.stops.splice(load.stops.indexOf(drops[0]), 0, { id, type: "pick", loadId: load.id,
      orderId: target.coRef, orderRefs: [target.coRef], location: target.fromYard });
    delete load.routeEstimate;
    pickupAdded = true;
    if (Number.isFinite(Number(candidate.summary.stops))) candidate.summary.stops = Number(candidate.summary.stops) + 1;
  }
  const validation = materializeDispatchPickupVisits({ ...candidate, orders: [restored], trucks: [{ loads: [{ ...load,
    stops: load.stops.filter((stop) => references(stop, target.coRef)) }] }] });
  requireState(validation.conflicts.length === 0, "CO pickup must precede delivery at the authoritative yard");
  return { candidate, restored, pickupAdded, changed: !isDeepStrictEqual(candidate, plan)
    || Boolean(state.global && !isDeepStrictEqual(state.global.full_order, restored)) };
}

async function persistRepair(state, result, target) {
  const { plan } = state;
  const { candidate, restored } = result;
  await assertDispatchExecutedPrefixPreserved({
    previousPlan: plan,
    nextPlan: candidate
  });
  const beforeCounts = dispatchPlanBoard(plan);
  await query(`INSERT INTO dispatch_plan_snapshot_history
    (plan_id,plan_date,revision,orders,trucks,summary,original_saved_at,archive_reason,session_id,
     schema_version,plan_digest,order_count,truck_count,load_count,stop_count)
    VALUES ($1,$2::date,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,'co_cargo_repair','co-cargo-repair',2,$8,$9,$10,$11,$12)`,
  [plan.id,plan.planDate,plan.revision,JSON.stringify(plan.orders),JSON.stringify(plan.trucks),JSON.stringify(plan.summary),
    plan.saved_at,digestDispatchPlan(plan),plan.orders.length,beforeCounts.truckCount,beforeCounts.loadCount,beforeCounts.stopCount]);
  candidate.revision = Number(plan.revision) + 1;
  const counts = dispatchPlanBoard(candidate);
  await query("UPDATE dispatch_plans SET revision=$2,updated_at=now() WHERE id=$1", [plan.id,candidate.revision]);
  await query(`UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb,summary=$4::jsonb,
    saved_at=now(),schema_version=2,plan_digest=$5,order_count=$6,truck_count=$7,load_count=$8,stop_count=$9 WHERE plan_id=$1`,
  [plan.id,JSON.stringify(candidate.orders),JSON.stringify(candidate.trucks),JSON.stringify(candidate.summary),
    digestDispatchPlan(candidate),candidate.orders.length,counts.truckCount,counts.loadCount,counts.stopCount]);
  await query(`UPDATE dispatch_global_order_groups SET full_order=$2::jsonb,card=$3::jsonb,source_revision=$4,updated_at=now()
    WHERE group_ref=$1`, [target.coRef,JSON.stringify(restored),JSON.stringify(compactDispatchOrderCard(restored)),candidate.revision]);
  await query("UPDATE dispatch_global_order_group_members SET hides_member=false WHERE group_ref=$1", [target.coRef]);
  await syncDispatchPlanOrderAssignments(candidate);
  await syncDispatchPlanRelationEdges(candidate);
  await syncDispatchPlanLoadAssignments(candidate);
  await writeDispatchAudit({ action: "dispatch.co_cargo_repaired", source: "co-cargo-repair", entityType: "order", entityId: target.coRef,
    orderId: target.coRef, planId: plan.id, planDate: plan.planDate, loadId: target.loadId,
    before: plan.orders.find((order) => order.id === target.coRef), after: restored,
    details: { previousRevision: Number(plan.revision), revision: candidate.revision, pickupAdded: result.pickupAdded, sourceLineIds: state.lines.map((line) => line.id) } });
}

/** Narrow operational repair; no API route. Dry run by default; apply requires its exact evidence fingerprint. */
export async function repairDispatchCoCargo({ target, apply = false, expectedRevision, expectedFingerprint } = {}) {
  const nested = hasActiveTransaction();
  return withTransaction(async () => {
    if (apply) await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    else if (!nested) await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const state = await readState(target, apply);
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(state)).digest("hex");
    if (apply) {
      requireState(Number(expectedRevision) === Number(state.plan.revision), "stale revision");
      requireState(expectedFingerprint === fingerprint, "stale fingerprint");
    }
    const result = repairCandidate(state, target);
    if (apply && result.changed) await persistRepair(state, result, target);
    return { applied: apply && result.changed, changed: result.changed, fingerprint,
      revision: Number(result.candidate.revision), pickupAdded: result.pickupAdded,
      cargo: result.restored.items.map((item) => ({ lineId: item.lineId, quantity: item.quantity, pallets: item.pallets })),
      backup: state };
  });
}
