import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, withTransaction, closeDb } from "../src/db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../src/dispatch-fleet-status.js";
import { listDispatchOrders } from "../src/dispatch-repository.js";
import { upsertDispatchOrderCatalog } from "../src/dispatch-order-catalog-repository.js";
import { compactDispatchOrderCard, dispatchOrderSearchText } from "../src/dispatch-planner-optimization.js";
import { digestDispatchPlan, dispatchPlanBoard } from "../src/dispatch-planner-performance.js";
import { syncDispatchPlanOrderAssignments, syncDispatchPlanRelationEdges } from "../src/dispatch-planner-v2-repository.js";
import { writeDispatchAudit } from "../src/dispatch-audit-repository.js";

const target = { planId: 323, planDate: "2026-09-11", orderId: 986406, orderRef: "SOB119965", groupRef: "GOB-119964-119965", auditId: 20096 };
const expectedLines = [[4928727,3632,735.04],[4928728,8472,61.25],[4928729,1256,37],[4928730,1219,4],[4928731,1142,4],[4928732,1134,12],[4928733,1987,1]];
const cargoFields = ["items", "pallets", "layers", "sections", "pieces", "salesQty", "salesQuantities", "weight", "totalWeightLbs", "unloadMinutes"];
const itemIdentity = (items) => items.map((item) => [Number(item.lineId), Number(item.itemId), Number(item.quantity)]).sort((a, b) => a[0] - b[0]);
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function restoreCargo(current, source) {
  assert.equal(current.id, source.id, "Cargo source identity changed");
  const result = structuredClone(current);
  for (const field of cargoFields) {
    if (Object.hasOwn(source, field)) { result[field] = structuredClone(source[field]); }
  }
  if (current.childOrderDetails?.length) {
    result.childOrderDetails = current.childOrderDetails.map((child) => {
      const fresh = source.childOrderDetails.find((candidate) => candidate.id === child.id);
      assert.ok(fresh, `Missing child ${child.id}`);
      // SOB119964 is not being repaired; preserve its full current snapshot.
      return child.id === target.orderRef ? restoreCargo(child, fresh) : child;
    });
    result.items = result.childOrderDetails.flatMap((child) => child.items);
  }
  result.catalogHydrated = true;
  return result;
}

async function lockedState() {
  await query("SET LOCAL lock_timeout='5s'");
  await query("SET LOCAL statement_timeout='30s'");
  await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
  await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`dispatch-global-source-refresh:${target.orderRef.toLowerCase()}`]);
  const plan = (await query(`SELECT p.id,p.plan_date::text AS "planDate",p.revision,p.status,
    s.orders,s.trucks,s.summary,s.saved_at FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id
    WHERE p.id=$1 FOR UPDATE OF p,s`, [target.planId])).rows[0];
  assert.ok(plan, "Target plan missing");
  assert.equal(plan.planDate, target.planDate);
  assert.equal(plan.status, "confirmed");
  const header = (await query("SELECT * FROM sales_orders WHERE netsuite_id=$1 FOR UPDATE", [target.orderId])).rows[0];
  assert.equal(header?.tranid, target.orderRef);
  const lines = (await query("SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY line_id FOR UPDATE", [target.orderId])).rows;
  assert.deepEqual(lines.map((line) => [Number(line.line_id), Number(line.item_id), Number(line.quantity)]), expectedLines, "Source ordered quantities changed");
  const global = (await query("SELECT * FROM dispatch_global_order_groups WHERE group_ref=$1 FOR UPDATE", [target.groupRef])).rows[0];
  assert.equal(global?.active, true);
  const audit = (await query("SELECT after_state FROM dispatch_audit_log WHERE id=$1", [target.auditId])).rows[0];
  const original = audit?.after_state?.orders?.find((order) => order.id === target.groupRef);
  assert.ok(original, "Original confirmed manifest missing");
  assert.equal(original.pallets, 8);
  assert.equal(original.layers, 5);
  assert.equal(original.items.length, 9);
  assert.deepEqual(itemIdentity(original.childOrderDetails.find((child) => child.id === target.orderRef).items), expectedLines);
  const jobs = (await query("SELECT * FROM driver_job_records WHERE plan_id=$1 ORDER BY job_id FOR SHARE", [target.planId])).rows;
  return { plan, header, lines, global, original, jobs };
}

async function persistPlan(state, restored) {
  const { plan } = state;
  const orders = plan.orders.map((order) => order.id === target.groupRef ? restored : order);
  const candidate = { ...plan, orders, revision: Number(plan.revision) + 1 };
  const counts = dispatchPlanBoard(plan);
  await query(`INSERT INTO dispatch_plan_snapshot_history
    (plan_id,plan_date,revision,orders,trucks,summary,original_saved_at,archive_reason,session_id,
     schema_version,plan_digest,order_count,truck_count,load_count,stop_count)
    VALUES ($1,$2::date,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,'sales_order_cargo_repair','repair:SOB119965:20260911',
      2,$8,$9,$10,$11,$12)`, [plan.id,plan.planDate,plan.revision,JSON.stringify(plan.orders),JSON.stringify(plan.trucks),
    JSON.stringify(plan.summary),plan.saved_at,digestDispatchPlan(plan),plan.orders.length,counts.truckCount,counts.loadCount,counts.stopCount]);
  await query("UPDATE dispatch_plans SET revision=$2,updated_at=now() WHERE id=$1", [plan.id,candidate.revision]);
  await query(`UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,saved_at=now(),schema_version=2,plan_digest=$3,
    order_count=$4,truck_count=$5,load_count=$6,stop_count=$7 WHERE plan_id=$1`,
  [plan.id,JSON.stringify(orders),digestDispatchPlan(candidate),orders.length,counts.truckCount,counts.loadCount,counts.stopCount]);
  await syncDispatchPlanOrderAssignments(candidate);
  await syncDispatchPlanRelationEdges(candidate);
  return candidate;
}

async function verifyPreservedState(state, candidate) {
  const afterPlan = (await query("SELECT orders,trucks,summary FROM dispatch_plan_snapshots WHERE plan_id=$1", [target.planId])).rows[0];
  assert.deepEqual(afterPlan.trucks, state.plan.trucks, "Stops or assignments changed");
  assert.deepEqual(afterPlan.summary, state.plan.summary, "Unrelated plan metadata changed");
  assert.deepEqual(afterPlan.orders, candidate.orders);
  const withoutTarget = (orders) => orders.filter((order) => order.id !== target.groupRef);
  assert.deepEqual(withoutTarget(afterPlan.orders), withoutTarget(state.plan.orders));
  const jobs = (await query("SELECT * FROM driver_job_records WHERE plan_id=$1 ORDER BY job_id", [target.planId])).rows;
  assert.deepEqual(jobs, state.jobs, "Driver progress changed");
  const header = (await query("SELECT * FROM sales_orders WHERE netsuite_id=$1", [target.orderId])).rows[0];
  assert.deepEqual(header, state.header, "Order header changed");
  const lines = (await query("SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY line_id", [target.orderId])).rows;
  assert.deepEqual(lines, state.lines.map((line) => ({ ...line, netsuite_active: true })), "A source quantity or operational field changed");
}

/** Default invocation executes the whole repair and rolls back. No NetSuite writes. */
export async function repairSob119965Cargo({ apply = false, expectedRevision = null, backupPath = "" } = {}) {
  return withTransaction(async () => {
    const state = await lockedState();
    const current = state.plan.orders.filter((order) => order.id === target.groupRef);
    assert.equal(current.length, 1, "Target group occurrence changed");
    assert.deepEqual([...current[0].childOrders].sort(), ["SOB119964", "SOB119965"]);
    assert.deepEqual([...state.global.full_order.childOrders].sort(), ["SOB119964", "SOB119965"]);
    const complete = state.lines.every((line) => line.netsuite_active)
      && hash(itemIdentity(current[0].items)) === hash(itemIdentity(state.original.items))
      && hash(itemIdentity(state.global.full_order.items)) === hash(itemIdentity(state.original.items))
      && current[0].pallets === 8 && current[0].layers === 5;
    if (complete) { return { applied: false, alreadyCorrect: true, revision: Number(state.plan.revision) }; }
    if (apply) {
      assert.equal(Number(expectedRevision), Number(state.plan.revision), "Plan revision changed; rehearse again");
      assert.ok(backupPath, "Applying requires a private backup path");
      await fs.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(backupPath, JSON.stringify(state), { flag: "wx", mode: 0o600 });
    }
    await query("UPDATE sales_order_lines SET netsuite_active=true WHERE sales_order_id=$1 AND netsuite_active=false", [target.orderId]);
    const sources = await listDispatchOrders({ type: "SO", exactOrderRefs: [target.orderRef] });
    assert.equal(sources.length, 1);
    assert.deepEqual(itemIdentity(sources[0].items), expectedLines);
    await upsertDispatchOrderCatalog({ orders: sources, source: "repair:SOB119965:20260911" });
    const freshGlobal = (await query("SELECT full_order FROM dispatch_global_order_groups WHERE group_ref=$1", [target.groupRef])).rows[0].full_order;
    assert.deepEqual(itemIdentity(freshGlobal.items), itemIdentity(state.original.items));
    assert.equal(freshGlobal.pallets, 8);
    assert.equal(freshGlobal.layers, 5);
    const restored = restoreCargo(current[0], freshGlobal);
    const candidate = await persistPlan(state, restored);
    const globalCargo = restoreCargo(state.global.full_order, freshGlobal);
    await query(`UPDATE dispatch_global_order_groups SET full_order=$2::jsonb,card=$3::jsonb,search_text=$4,
      source_revision=$5,updated_at=now() WHERE group_ref=$1`, [target.groupRef,JSON.stringify(globalCargo),
      JSON.stringify(compactDispatchOrderCard(globalCargo)),dispatchOrderSearchText(globalCargo),candidate.revision]);
    await verifyPreservedState(state, candidate);
    const audit = await writeDispatchAudit({ action: "dispatch.sales_order_cargo_repaired", entityType: "order", entityId: target.groupRef,
      orderId: target.orderRef, planId: target.planId, planDate: target.planDate, source: "sales-order-cargo-repair",
      operatorName: "system:authorized-cargo-repair", before: current[0], after: restored,
      details: { originalConfirmationAuditId: target.auditId, previousRevision: Number(state.plan.revision), revision: candidate.revision,
        reactivatedLineIds: state.lines.filter((line) => !line.netsuite_active).map((line) => Number(line.line_id)),
        driverEvidenceHash: hash(state.jobs), backupPath: apply ? backupPath : "rollback rehearsal" } });
    return { applied: apply, rolledBack: !apply, previousRevision: Number(state.plan.revision), revision: candidate.revision,
      itemCount: restored.items.length, pallets: restored.pallets, layers: restored.layers, auditId: audit.id,
      reactivatedLines: state.lines.filter((line) => !line.netsuite_active).length, driverJobsPreserved: state.jobs.length };
  }, { rollback: !apply });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
    console.log(JSON.stringify(await repairSob119965Cargo({ apply: process.argv.includes("--apply"),
      expectedRevision: process.argv.includes("--revision") ? value("--revision") : null,
      backupPath: process.argv.includes("--backup") ? value("--backup") : "" })));
  } finally { await closeDb(); }
}
