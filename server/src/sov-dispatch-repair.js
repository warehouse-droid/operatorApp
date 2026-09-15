import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { query, withTransaction } from "./db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";
import { saveDispatchPlanSnapshot } from "./dispatch-plan-repository.js";
import { invalidateLoadRoute } from "./dispatch-plan-order-projection.js";
import { reconcileDependencyManagedPickups } from "./scm-dependency-plan-reconciler.js";
import { dispatchDependencyOrderRefs } from "./yard-dependency-structure.js";
import { dispatchLoadProtectedBoundary } from "./dispatch-pickup-visits.js";
import { overlayLockedLoadDerivedSchedule } from "./dispatch-load-assignment.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";

const text = value => String(value ?? "").trim();
export const sovDispatchSourceRefs = order => [...new Set(dispatchDependencyOrderRefs(order)
  .filter(ref => /^SOV/iu.test(ref)).map(ref => ref.replace(/-S\d+$/iu, "")))];
const sovRefs = sovDispatchSourceRefs;
const loads = plan => (plan.trucks || []).flatMap(truck => truck.loads || []);
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function lockedState(planId) {
  await query("SET LOCAL lock_timeout='5s'");
  await query("SET LOCAL statement_timeout='60s'");
  await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
  const row = (await query(`SELECT p.id,p.plan_date::text,p.status,p.revision,s.orders,s.trucks,s.summary
    FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id
    WHERE p.id=$1 FOR UPDATE OF p,s`, [planId])).rows[0];
  if (!row) {
    throw new Error("SOV repair plan was not found.");
  }
  const plan = { id: String(row.id), planDate: row.plan_date, status: row.status, revision: Number(row.revision),
    orders: row.orders, trucks: row.trucks, summary: row.summary };
  const activity = (await query("SELECT * FROM driver_job_records WHERE plan_id=$1 ORDER BY id FOR UPDATE", [planId])).rows;
  const completed = (await query("SELECT load_id FROM dispatch_plan_load_assignments WHERE plan_id=$1 AND completed=true FOR UPDATE", [planId])).rows;
  const refs = [...new Set(plan.orders.flatMap(sovRefs).map(ref => ref.toUpperCase()))];
  const sources = (await query(`SELECT netsuite_id,tranid,status,sales_order_type,netsuite_active FROM sales_orders
    WHERE upper(tranid)=ANY($1::text[]) ORDER BY netsuite_id FOR SHARE`, [refs])).rows;
  return { plan, activity, completedLoadIds: completed.map(row => row.load_id), sources };
}

function eligibleTargets(state) {
  const eligible = new Set(state.sources.filter(row => row.netsuite_active === true
    && ["B", "D", "E"].includes(row.status) && row.sales_order_type === "Delivery")
    .map(row => row.tranid.toUpperCase()));
  return state.plan.orders.filter(order => {
    const refs = sovRefs(order);
    return text(order.type).toUpperCase() === "SO" && refs.length > 0
      && refs.every(ref => eligible.has(ref.toUpperCase()));
  }).map(order => order.id);
}

function protectedTargets(state, targets) {
  const wanted = new Set(targets);
  return [...new Set(loads(state.plan).flatMap(load => {
    const boundary = state.completedLoadIds.includes(load.id)
      ? (load.stops || []).length - 1
      : dispatchLoadProtectedBoundary(load, state.activity);
    return (load.stops || []).slice(0, boundary + 1)
      .filter(stop => stop.type === "drop" && wanted.has(stop.orderId)).map(stop => stop.orderId);
  }))];
}

function proposeRepair(state, targets) {
  const plan = state.plan;
  const candidate = reconcileDependencyManagedPickups({ plan, affectedTargetRefs: targets, activity: state.activity,
    preservedPoOrderRefs: new Set(plan.orders.filter(order => order.type === "PO").map(order => order.id)) });
  const previousLoads = new Map(loads(plan).map(load => [load.id, load]));
  const changedLoadIds = [];
  candidate.trucks = candidate.trucks.map(truck => ({ ...truck, loads: truck.loads.map(load => {
    const before = previousLoads.get(load.id);
    if (state.completedLoadIds.includes(load.id) || hash(load.stops) === hash(before.stops)) {
      return before;
    }
    changedLoadIds.push(load.id);
    return invalidateLoadRoute(load);
  }) }));
  const next = overlayLockedLoadDerivedSchedule(plan, candidate, new Set(), { activityStatuses: state.activity });
  return { next, changedLoadIds };
}

function comparableOrders(orders) {
  // The normal save strips empty relationship projections; absent and zero
  // allocations describe identical cargo. Nonzero allocations remain protected.
  return JSON.parse(JSON.stringify(orders, (key, value) =>
    /^poAllocated(?:Layers|Pallets|Pieces|SalesQty|Sections)$/u.test(key) && value === 0 ? undefined : value));
}

function assertRepairScope(before, after, targets) {
  assert.deepEqual(comparableOrders(after.orders), comparableOrders(before.orders), "Pickup repair changed order cargo");
  const targetSet = new Set(targets);
  const nextLoads = new Map(loads(after).map(load => [load.id, load]));
  for (const load of loads(before)) {
    const next = nextLoads.get(load.id);
    assert.ok(next, "Pickup repair removed a load");
    const originalIds = new Set((load.stops || []).map(stop => stop.id));
    assert.deepEqual(next.stops.filter(stop => originalIds.has(stop.id)).map(stop => stop.id),
      load.stops.map(stop => stop.id), "Pickup repair removed or reordered an existing stop");
    for (const stop of next.stops.filter(stop => !originalIds.has(stop.id))) {
      assert.ok(stop.type === "pick" && targetSet.has(stop.orderId), "Pickup repair added unrelated work");
    }
  }
}

async function backupState(backupPath, state) {
  assert.ok(backupPath, "Applying a repair requires a private backup path");
  await fs.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(backupPath, JSON.stringify(state), { flag: "wx", mode: 0o600 });
}

/** Real transactional rehearsal by default. The driver command's fleet lock covers the entire operation. */
export async function repairSovDispatchPlan({ planId, apply = false, expectedFingerprint = "", backupPath = "", eligibleOrderRefs = null } = {}) {
  if (!/^[1-9]\d*$/u.test(text(planId))) {
    throw new Error("A positive dispatch plan ID is required.");
  }
  return withTransaction(async () => {
    const state = await lockedState(planId);
    state.eligibleOrderRefs = eligibleOrderRefs === null ? null : [...new Set(eligibleOrderRefs.map(ref => text(ref).toUpperCase()))].sort();
    const liveEligible = state.eligibleOrderRefs === null ? null : new Set(state.eligibleOrderRefs);
    const targets = ["draft", "confirmed"].includes(state.plan.status) ? eligibleTargets(state).filter(ref =>
      !liveEligible || sovRefs(state.plan.orders.find(order => order.id === ref)).every(child => liveEligible.has(child.toUpperCase()))) : [];
    const fingerprint = hash(state);
    const protectedOrderRefs = protectedTargets(state, targets);
    if (!targets.length) {
      return { planId, changed: false, fingerprint, protectedOrderRefs };
    }
    const { next, changedLoadIds } = proposeRepair(state, targets);
    if (!changedLoadIds.length) {
      return { planId, changed: false, fingerprint, protectedOrderRefs };
    }
    assertRepairScope(state.plan, next, targets);
    if (apply && expectedFingerprint !== fingerprint) {
      throw Object.assign(new Error("Plan or driver activity changed; rehearse the SOV repair again."), { code: "SOV_REPAIR_STALE" });
    }
    if (apply) {
      await backupState(backupPath, state);
    }
    const summary = { ...next.summary, ownYardCodes: [...new Set([...(next.summary?.ownYardCodes || ["3445", "2967", "12441", "150"]), "195"])] };
    const saved = await saveDispatchPlanSnapshot(planId, { orders: next.orders, trucks: next.trucks, summary,
      planDate: state.plan.planDate, baseRevision: state.plan.revision, sessionId: "sov-pickup-repair" });
    assertRepairScope(state.plan, saved, targets);
    for (const before of loads(state.plan)) {
      const after = loads(saved).find(load => load.id === before.id);
      if (!changedLoadIds.includes(before.id)) {
        assert.deepEqual(after.stops, before.stops, "Pickup repair changed unrelated or completed stops");
      }
      const boundary = dispatchLoadProtectedBoundary(before, state.activity);
      assert.deepEqual(after.stops.slice(0, boundary + 1), before.stops.slice(0, boundary + 1),
        "Pickup repair changed started work");
    }
    assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE plan_id=$1 ORDER BY id", [planId])).rows,
      state.activity, "Pickup repair changed driver activity");
    const completedAfter = new Set((await query("SELECT load_id FROM dispatch_plan_load_assignments WHERE plan_id=$1 AND completed=true", [planId])).rows.map(row => row.load_id));
    assert.ok(state.completedLoadIds.every(id => completedAfter.has(id)), "Pickup repair reopened a completed load");
    const addedPickupCount = loads(saved).reduce((sum, load) => sum + load.stops.filter(stop => stop.type === "pick").length, 0)
      - loads(state.plan).reduce((sum, load) => sum + load.stops.filter(stop => stop.type === "pick").length, 0);
    await writeDispatchAudit({ action: "dispatch.sov_pending_pickups_repaired", entityType: "plan", entityId: String(planId),
      planId, planDate: state.plan.planDate, source: "sov-pickup-repair", operatorName: "system:authorized-dispatch-repair",
      before: { revision: state.plan.revision }, after: { revision: saved.revision },
      details: { fingerprint, changedLoadIds, addedPickupCount, protectedOrderRefs, backupPath: apply ? backupPath : "rollback rehearsal" } });
    return { planId, changed: true, applied: apply, rolledBack: !apply, fingerprint, changedLoadIds, addedPickupCount,
      protectedOrderRefs, previousRevision: state.plan.revision, revision: saved.revision };
  }, { rollback: !apply });
}
