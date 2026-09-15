import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { query, withTransaction, closeDb } from "../src/db.js";
import { loadDispatchOrdersForResponse } from "../src/server.js";
import { reconcileDispatchPlanGlobalOrderDefinitions } from "../src/dispatch-delivery-group-repository.js";
import { confirmDispatchPlan, getDispatchPlan, saveDispatchPlanSnapshot } from "../src/dispatch-plan-repository.js";
import { overlayLockedLoadDerivedSchedule } from "../src/dispatch-load-assignment.js";
import { getDispatchOrderCatalogOrder, listDispatchOrderPool } from "../src/dispatch-order-catalog-repository.js";
import { repairDispatchRetiredConfirm } from "./repair-dispatch-retired-confirm.mjs";
import { retiredConfirmBrowser } from "../test/support/retired-confirm-fixture.mjs";

const targets = ["SOA08404-S2", "CO-GOA-7894-7895"];

export async function retiredConfirmWitness() {
  const result = {};
  for (const [name, sql] of Object.entries({
    plans: "SELECT md5(string_agg(row_to_json(p)::text,'|' ORDER BY p.id)) digest FROM dispatch_plans p WHERE id IN (324,326)",
    snapshots: "SELECT md5(string_agg(row_to_json(s)::text,'|' ORDER BY s.plan_id)) digest FROM dispatch_plan_snapshots s WHERE plan_id IN (324,326)",
    recovery: "SELECT count(*) count,md5(string_agg(row_to_json(h)::text,'|' ORDER BY h.id)) digest FROM dispatch_plan_snapshot_history h WHERE plan_id IN (324,326)",
    driverJobs: "SELECT count(*) count,md5(string_agg(row_to_json(j)::text,'|' ORDER BY j.id)) digest FROM driver_job_records j WHERE plan_id IN (324,326)",
    source: "SELECT md5(string_agg(row_to_json(o)::text,'|' ORDER BY o.netsuite_id)) digest FROM sales_orders o WHERE tranid IN ('SOA08404-S2','SOA08404','SOM06255','SOM06256')",
    co: "SELECT md5(row_to_json(c)::text) digest FROM local_co_orders c WHERE co_ref='CO-GOA-7894-7895'"
  })) { result[name] = (await query(sql)).rows; }
  return result;
}

export async function checkRetiredConfirmFeed() {
  const started = Date.now();
  const orders = await loadDispatchOrdersForResponse({ exactOrderRefs: targets });
  assert.equal(orders.some(order => order.id === targets[0]), false, "Retired split leaked through the canonical feed");
  const co = orders.find(order => order.id === targets[1]);
  assert.ok(co, "Explicitly recreated CO is missing");
  assert.equal(co.sourceTable, "local_co_orders");
  const accepted = await reconcileDispatchPlanGlobalOrderDefinitions({ orders, trucks: [] }, { rejectRetiredGlobalOrderRefs: true });
  assert.ok(accepted.orders.some(order => order.id === targets[1]));
  assert.equal(await getDispatchOrderCatalogOrder(targets[0]), null);
  assert.equal((await getDispatchOrderCatalogOrder(targets[1]))?.id, targets[1]);
  assert.ok((await listDispatchOrderPool({ type: "CO", search: targets[1] })).orders.some(order => order.id === targets[1]));
  await assert.rejects(reconcileDispatchPlanGlobalOrderDefinitions({
    orders: [{ id: targets[0], type: "SO" }],
    trucks: [{ id: "check", loads: [{ id: "check", stops: [{ type: "drop", orderId: targets[0] }] }] }]
  }, { rejectRetiredGlobalOrderRefs: true }), error => error.code === "DISPATCH_DERIVED_ORDER_RETIRED");
  return { feedAgreesWithValidator: true, retiredAssignmentRejected: true, elapsedMs: Date.now() - started };
}

function assertExpectedReplayError(draft, error, currentRecordedPoActivity) {
  assert.notEqual(error.code, "DISPATCH_DERIVED_ORDER_RETIRED", "The incident still blocks a corrected payload");
  if (currentRecordedPoActivity && String(draft.id) === "17288") {
    assert.ok(error.conflicts?.some(conflict => conflict.loadId === "T4-L1789349637541-7959d8854096b" && conflict.throughStopIndex === 5),
      "This older draft omits both now-executed PO stops and must retain their exact driver lock");
  } else {
    assert.equal(String(draft.id), "17282", `The latest saved draft must replay successfully: ${error.code} ${JSON.stringify(error.conflicts)}`);
  }
  assert.equal(error.code, "DISPATCH_ACTIVE_LOAD_LOCKED", "Only the known historical driver conflict may remain");
}

export async function replayRetiredConfirm({ currentRecordedPoActivity = false } = {}) {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1", "Replay requires the isolated test environment");
  assert.equal(new URL(process.env.DATABASE_URL).hostname, "replay-db", "Replay writes are restricted to the disposable clone");
  const before = await retiredConfirmWitness();
  const reports = [];
  const dir = await fs.mkdtemp("/tmp/retired-confirm-replay-");
  try {
    await withTransaction(async () => {
      const original = (await query("SELECT * FROM dispatch_plan_snapshot_history WHERE id=17282")).rows[0];
      assert.ok(original, "Original rejected recovery snapshot is missing");
      await assert.rejects(reconcileDispatchPlanGlobalOrderDefinitions({ orders: original.orders, trucks: original.trucks },
        { rejectRetiredGlobalOrderRefs: true }), error => targets.every(ref => error.retiredOrderRefs?.includes(ref)));
      reports.push({ check: "original_failure", reproduced: true, refs: targets });
      const rehearsal = await repairDispatchRetiredConfirm();
      const repaired = await repairDispatchRetiredConfirm({ apply: true, expectedFingerprint: rehearsal.fingerprint, backupPath: `${dir}/before.json` });
      reports.push({ check: "co_repair", ...repaired });
      reports.push({ check: "fresh_feed_to_validator", ...await checkRetiredConfirmFeed() });
      const drafts = (await query(`SELECT h.id,h.plan_id,h.plan_date::text,h.orders,h.trucks,h.summary,p.revision
        FROM dispatch_plan_snapshot_history h JOIN dispatch_plans p ON p.id=h.plan_id
        WHERE h.id IN (17282,17288,17291) OR h.id=(SELECT max(id) FROM dispatch_plan_snapshot_history WHERE archive_reason='recovery_draft' AND plan_id=324)
        ORDER BY h.id`)).rows;
      assert.ok(drafts.length >= 3);
      for (const draft of drafts) {
        const plan = { id: String(draft.plan_id), planDate: draft.plan_date, revision: Number(draft.revision),
          orders: draft.orders, trucks: draft.trucks, summary: draft.summary };
        const payload = retiredConfirmBrowser(plan).planPayload();
        const removed = plan.orders.filter(order => !payload.orders.some(next => next.id === order.id)).map(order => order.id);
        assert.equal(payload.orders.some(order => order.id === targets[0]), false);
        assert.deepEqual(payload.trucks, plan.trucks, "Replay must preserve all physical stops");
        const group = plan.orders.find(order => order.id === "GOM-6255S1-6256S1");
        if (group) { assert.deepEqual(payload.orders.find(order => order.id === group.id)?.items, group.items, "New group cargo was lost"); }
        await reconcileDispatchPlanGlobalOrderDefinitions({ ...plan, orders: payload.orders }, { rejectRetiredGlobalOrderRefs: true });
        // Match the HTTP save handler: refresh the previous plan, then restore
        // its published executed schedule before repository validation.
        const previousPlan = await getDispatchPlan(plan.id);
        const activity = (await query(`SELECT status,load_id,stop_id,stop_type,order_refs,job_details
          FROM driver_job_records WHERE plan_id=$1 AND status IN ('in_progress','complete')`, [plan.id])).rows;
        const prepared = overlayLockedLoadDerivedSchedule(previousPlan, { ...plan, ...payload }, new Set(), { activityStatuses: activity });
        let outcome;
        try {
          await withTransaction(async () => {
            const saved = await saveDispatchPlanSnapshot(plan.id, { ...payload, trucks: prepared.trucks, sessionId: "isolated-retired-confirm-replay" });
            const confirmed = await confirmDispatchPlan(plan.id);
            assert.equal(confirmed.status, "confirmed");
            outcome = { appliedInRollback: true, revision: saved.revision, confirmedInRollback: true, confirmedRevision: confirmed.revision };
          }, { rollback: true });
        } catch (error) {
          assertExpectedReplayError(draft, error, currentRecordedPoActivity);
          outcome = { appliedInRollback: false, code: error.code, message: error.message,
            conflicts: error.conflicts?.map(row => ({ code: row.code, loadId: row.loadId, throughStopIndex: row.throughStopIndex })) };
        }
        if (String(draft.id) === "17291" || (!currentRecordedPoActivity && String(draft.id) === "17288")) { assert.equal(outcome.appliedInRollback, true); }
        if (currentRecordedPoActivity && String(draft.id) === "17288") { assert.equal(outcome.appliedInRollback, false); }
        reports.push({ check: "saved_draft_replay", snapshotId: String(draft.id), planId: plan.id, removedIncidentalRefs: removed,
          newGroupCargoPreserved: Boolean(group), physicalStopsPreserved: true, recordedScheduleRestored: true, ...outcome });
      }
    }, { rollback: true });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
  assert.deepEqual(await retiredConfirmWitness(), before, "Replay modified saved work, driver activity or source orders");
  reports.push({ check: "rollback_postcheck", plansRecoveryDriverAndSourceUnchanged: true, witness: before });
  return reports;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { for (const report of await replayRetiredConfirm()) { console.log(JSON.stringify(report)); } }
  finally { await closeDb(); }
}
