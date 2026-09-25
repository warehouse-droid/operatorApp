import assert from "node:assert/strict";
import fs from "node:fs";
import { query, withTransaction, closeDb } from "../src/db.js";
import { listDispatchPlanOrderAssignmentsProjection } from "../src/dispatch-planner-v2-repository.js";
import { conflictHarness } from "../test/support/dispatch-split-date-conflict-harness.mjs";

try {
  await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await query("SET LOCAL statement_timeout='30s'");
    const snapshot = (await query(`SELECT h.id,h.plan_id,h.plan_date::text,h.orders,h.trucks,h.summary,
      md5(h.orders::text||h.trucks::text||h.summary::text) AS digest
      FROM dispatch_plan_snapshot_history h WHERE h.id=17497`)).rows[0];
    assert.ok(snapshot, "The user's exact failed draft must exist");
    assert.ok(snapshot.summary.saveRecovery.validationIssues.some(issue => issue.code === "DISPATCH_ORDER_ALREADY_PLANNED"));
    const plan = { id: String(snapshot.plan_id), planId: String(snapshot.plan_id), planDate: snapshot.plan_date,
      orders: snapshot.orders, trucks: snapshot.trucks };
    const sourcePath = process.argv.slice(2).find(arg => !arg.startsWith("--"));
    const harness = conflictHarness(listDispatchPlanOrderAssignmentsProjection, sourcePath ? fs.readFileSync(sourcePath, "utf8") : undefined);
    const conflicts = await harness.conflicts(plan);
    if (process.argv.includes("--expect-blocked")) {
      assert.ok(conflicts.some(row => row.orderRef === "SOA08404-S2" && row.planId === "322"));
    } else {
      assert.deepEqual(conflicts, [], "The exact failed draft must clear the false date conflict");
    }
    const unchanged = (await query("SELECT md5(orders::text||trucks::text||summary::text) AS digest FROM dispatch_plan_snapshot_history WHERE id=$1", [snapshot.id])).rows[0];
    assert.equal(unchanged.digest, snapshot.digest);
    console.log(JSON.stringify({ check: "failed_snapshot_replay", snapshotId: snapshot.id, planId: snapshot.plan_id,
      planDate: snapshot.plan_date, orderCount: snapshot.orders.length, conflicts, snapshotUnchanged: true, readOnly: true }));
  }, { rollback: true });
} finally { await closeDb(); }
