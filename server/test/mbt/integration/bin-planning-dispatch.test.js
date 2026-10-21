import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { query, closeDb } from "../../../src/db.js";
import { saveDispatchPlanSnapshot } from "../../../src/dispatch-plan-repository.js";
import { applyDispatchV2Command } from "../../../src/dispatch-planner-v2-repository.js";
import { persistedDispatchPlan } from "../../../src/dispatch-plan-fence.js";
import { acquireDispatchPlanEditLease } from "../../../src/dispatch-plan-lease-repository.js";
import { assignMbtBinFrontLeg } from "../../../src/mbt/bin-dispatch-service.js";
import { binAssignmentCommand, binDispatchPlanDate, createBinDispatchFixture, enabledBinDispatchBoundary }
  from "../support/bin-dispatch-fixtures.js";

after(closeDb);
async function stored(id) {
  const result = await query(`SELECT p.*, s.orders, s.trucks, s.summary, s.saved_at
    FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1`, [id]);
  return persistedDispatchPlan(result.rows[0]);
}
async function fixture(offset) {
  const f = await createBinDispatchFixture({ label: "planner-dispatch", planDate: binDispatchPlanDate(offset) });
  await assignMbtBinFrontLeg(binAssignmentCommand(f, "assign"), { capability: enabledBinDispatchBoundary });
  await query(`INSERT INTO operators (id,username,display_name,password_hash,password_salt,role,roles)
    VALUES ('ordinary-dispatch','bin-planning-dispatch','Dispatch','test-hash','test-salt','dispatcher',ARRAY['dispatcher'])
    ON CONFLICT (id) DO NOTHING`);
  const leaseInput = { planDate: f.planDate, operatorId: "ordinary-dispatch", operatorName: "Dispatch", sessionId: crypto.randomUUID() };
  const lease = await acquireDispatchPlanEditLease(leaseInput);
  return { ...f, editLease: { ...leaseInput, token: lease.token } };
}
test("Dispatch legacy save succeeds with BIN present and preserves the whole BIN route", async () => {
  const f = await fixture(1200); const before = await stored(f.planId);
  const trucks = structuredClone(before.trucks);
  trucks[1].loads[0].name = "Ordinary work remains editable";
  await saveDispatchPlanSnapshot(f.planId, { ...before, trucks, baseRevision: before.revision });
  const afterPlan = await stored(f.planId);
  assert.deepEqual(afterPlan.trucks[0].loads[0].stops, before.trucks[0].loads[0].stops);
  assert.equal(afterPlan.trucks[1].loads[0].name, "Ordinary work remains editable");
  assert.equal(afterPlan.revision, before.revision + 1);
});
test("Dispatch V2 saves ordinary changes but cannot remove BIN work", async () => {
  const f = await fixture(1201); let before = await stored(f.planId);
  const trucks = structuredClone(before.trucks);
  trucks[1].loads[0].name = "V2 ordinary edit";
  await applyDispatchV2Command({ planId: f.planId, editLease: f.editLease, actorId: f.editLease.operatorId,
    command: { commandId: crypto.randomUUID(), commandType: "replace_plan", baseRevision: before.revision,
      baseDigest: before.digest, sessionId: f.editLease.sessionId, payload: { ...before, trucks } } });
  const saved = await stored(f.planId);
  assert.equal(saved.trucks[1].loads[0].name, "V2 ordinary edit");
  assert.deepEqual(saved.trucks[0].loads[0].stops, before.trucks[0].loads[0].stops);
  before = saved;
  const removed = structuredClone(before); removed.trucks[0].loads[0].stops = [];
  await assert.rejects(() => applyDispatchV2Command({ planId: f.planId, editLease: f.editLease,
    command: { commandId: crypto.randomUUID(), commandType: "replace_plan", baseRevision: before.revision,
      baseDigest: before.digest, sessionId: f.editLease.sessionId, payload: removed } }),
  e => e.status === 409 && e.code === "MBT_BIN_PLANNING_REQUIRED");
  assert.deepEqual(await stored(f.planId), before);
});
