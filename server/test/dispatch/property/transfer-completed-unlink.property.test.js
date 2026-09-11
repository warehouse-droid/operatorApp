import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { closeDb, query } from "../../../src/db.js";
import { saveDispatchPlanSnapshot } from "../../../src/dispatch-plan-repository.js";
import { completedOrderDependencyUnlinkAllowed, validateDispatchPlanDependencies } from "../../../src/order-dependency-repository.js";
import { completedTransferUnlinkAllowed } from "../../../src/scm-dependency-management-policy.js";
import { rollbackTest, seedTransferDependency, seedTransferJob } from "../../support/transfer-unlink-fixture.mjs";

after(closeDb);

test("1000 completion-policy combinations permit exactly finished unlink operations", () => {
  fc.assert(fc.property(fc.record({ action: fc.constantFrom("unlink_to", "change_mode", "link_to", "unlink_po", ""),
    receiptComplete: fc.boolean(), completedDrop: fc.boolean(), activeDriverWork: fc.boolean() }), (input) => {
    const finished = input.receiptComplete || input.completedDrop;
    assert.equal(completedTransferUnlinkAllowed(input), input.action === "unlink_to" && finished && !input.activeDriverWork);
  }), { seed: 957, numRuns: 1000 });
  assert.equal(completedTransferUnlinkAllowed(), false);
});

test("database completion properties distinguish pickup, drop, receipt and active work", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), async (drop, receipt, active, completed) => {
    await rollbackTest(async () => {
      const f = await seedTransferDependency();
      await seedTransferJob(f, { stopType: drop ? "dropoff" : "pickup", status: completed ? "complete" : "in_progress" });
      if (receipt) { await query("UPDATE transfer_orders SET receiving_status='received' WHERE netsuite_id=$1", [f.transferId]); }
      if (active) { await seedTransferJob(f, { status: "in_progress" }); }
      assert.equal(await completedOrderDependencyUnlinkAllowed(f.dependencyId), !active && completed && (receipt || drop));
      assert.equal(await completedOrderDependencyUnlinkAllowed(-1), false);
    });
  }), { seed: 118670, numRuns: 64, examples: Array.from({ length: 16 }, (_, value) =>
    [Boolean(value & 1), Boolean(value & 2), Boolean(value & 4), Boolean(value & 8)]) });
});

test("date-order properties make preflight and full save agree, without stale-flag bypasses", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 14 }), fc.boolean(), async (day, cancelled) => {
    await rollbackTest(async () => {
      const f = await seedTransferDependency({ priorDate: `2098-09-${String(day).padStart(2, "0")}` });
      if (cancelled) { await query("UPDATE dispatch_plans SET status='cancelled' WHERE id=$1", [f.prior.id]); }
      await query("UPDATE transfer_orders SET dispatch_planned=true,dispatch_plan_date='2098-08-01' WHERE netsuite_id=$1", [f.transferId]);
      const expected = day < 8 && !cancelled;
      const conflicts = await validateDispatchPlanDependencies(f.plan);
      assert.equal(conflicts.length === 0, expected);
      if (expected) {
        const saved = await saveDispatchPlanSnapshot(f.plan.id, { ...f.plan, baseRevision: f.plan.revision });
        assert.equal(saved.planDate, f.plan.planDate);
        assert.equal(saved.revision, f.plan.revision + 1);
      } else {
        await assert.rejects(saveDispatchPlanSnapshot(f.plan.id, { ...f.plan, baseRevision: f.plan.revision }), { code: "DISPATCH_ORDER_DEPENDENCY_CONFLICT" });
        assert.equal(Number((await query("SELECT revision FROM dispatch_plans WHERE id=$1", [f.plan.id])).rows[0].revision), f.plan.revision);
      }
    });
  }), { seed: 957, numRuns: 24, examples: [[1, false], [7, false], [8, false], [14, false], [1, true]] });
});
