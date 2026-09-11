import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb, query } from "../../../src/db.js";
import { getDispatchPlan, saveDispatchPlanSnapshot } from "../../../src/dispatch-plan-repository.js";
import { applyDispatchV2Command } from "../../../src/dispatch-planner-v2-repository.js";
import { digestDispatchPlan } from "../../../src/dispatch-planner-performance.js";
import crypto from "node:crypto";
import { cancelOrderDependency, validateDispatchPlanDependencies } from "../../../src/order-dependency-repository.js";
import { previewScmDependencyMutation } from "../../../src/scm-dependency-preview-service.js";
import { executeScmDependencyCommand, scmDependencyPayloadHash } from "../../../src/scm-dependency-command-service.js";
import { executionEvidence, rollbackTest, seedTransferDependency, seedTransferJob, unlinkCommand } from "../../support/transfer-unlink-fixture.mjs";

after(closeDb);

test("completed grouped links still require the owning plan", () => rollbackTest(async () => {
  const f = await seedTransferDependency();
  await query("UPDATE order_dependencies SET status='received_local',dispatch_target_kind='group',dispatch_target_ref=$2 WHERE id=$1", [f.dependencyId, `GOB-${f.salesRef}`]);
  await assert.rejects(cancelOrderDependency(f.dependencyId, null, "2098-09-09"), { code: "ORDER_DEPENDENCY_PLAN_MISMATCH" });
  assert.equal((await query("SELECT status FROM order_dependencies WHERE id=$1", [f.dependencyId])).rows[0].status, "received_local");
}));

test("earlier transfer passes both preflight and full save without losing the plan date", () => rollbackTest(async () => {
  const f = await seedTransferDependency();
  assert.deepEqual(await validateDispatchPlanDependencies(f.plan), []);
  const saved = await saveDispatchPlanSnapshot(f.plan.id, { ...f.plan, baseRevision: f.plan.revision });
  assert.equal(saved.planDate, "2098-09-08");
  assert.equal(saved.revision, f.plan.revision + 1);
  assert.deepEqual(saved.trucks, f.plan.trucks);
  assert.deepEqual(saved.orders[0].items, f.plan.orders[0].items);
  const incremental = await applyDispatchV2Command({ planId: saved.id, command: {
    commandId: crypto.randomUUID(), commandType: "update_load", baseRevision: saved.revision,
    baseDigest: digestDispatchPlan(saved), payload: { planDelta: { s: { dependencyDateRegression: true } } }
  } });
  assert.equal(incremental.payload.plan.revision, saved.revision + 1);
}));

for (const evidence of ["driver", "receipt", "dependency"]) {
  test(`completed ${evidence} evidence permits manual unlink and preserves execution history`, () => rollbackTest(async () => {
    const f = await seedTransferDependency();
    if (evidence === "driver") { await seedTransferJob(f); }
    if (evidence === "receipt") { await query("UPDATE transfer_orders SET receiving_status='received' WHERE netsuite_id=$1", [f.transferId]); }
    if (evidence === "dependency") { await query("UPDATE order_dependencies SET status='received_local' WHERE id=$1", [f.dependencyId]); }
    await query("UPDATE order_dependency_lines SET loaded_quantity=10,locally_received_quantity=10 WHERE dependency_id=$1", [f.dependencyId]);
    const before = await executionEvidence(f);
    const command = unlinkCommand(f);
    const preview = await previewScmDependencyMutation(command);
    assert.deepEqual(preview.blockers, []);
    assert.equal(preview.allowed, true);
    command.payloadHash = scmDependencyPayloadHash(command);
    const result = await executeScmDependencyCommand(command);
    assert.equal(result.status, "applied");
    assert.equal((await query("SELECT status FROM order_dependencies WHERE id=$1", [f.dependencyId])).rows[0].status, "cancelled");
    assert.deepEqual(await executionEvidence(f), before);
    const again = await executeScmDependencyCommand(command);
    assert.equal(again.idempotent, true);
    assert.equal((await cancelOrderDependency(f.dependencyId, null, f.plan.planDate)).alreadyCancelled, true);
    assert.equal(Number((await query("SELECT count(*) FROM dispatch_audit_log WHERE action='dispatch.order_dependency.unlinked' AND entity_id=$1", [String(f.dependencyId)])).rows[0].count), 1);
    const saved = await getDispatchPlan(f.plan.id);
    assert.equal(saved.orders.some((o) => (o.orderDependencies || []).some((d) => Number(d.id) === f.dependencyId)), false);
  }));
}

for (const scenario of ["pickup-only", "active-transfer", "started-target", "mode-change"]) {
  test(`${scenario} remains protected`, () => rollbackTest(async () => {
    const f = await seedTransferDependency();
    await seedTransferJob(f, { stopType: scenario === "pickup-only" ? "pickup" : "dropoff" });
    if (scenario === "active-transfer") { await seedTransferJob(f, { status: "in_progress" }); }
    if (scenario === "started-target") { await seedTransferJob(f, { target: true, status: "in_progress" }); }
    const command = unlinkCommand(f);
    if (scenario === "mode-change") { command.action = "change_mode"; command.payload.mode = "direct_to_customer"; }
    const preview = await previewScmDependencyMutation(command);
    assert.equal(preview.allowed, false);
    assert.ok(preview.blockers.some((b) => b.code === "DRIVER_ACTIVITY_STARTED"));
    assert.equal((await query("SELECT status FROM order_dependencies WHERE id=$1", [f.dependencyId])).rows[0].status, "active");
  }));
}

for (const [scenario, code] of [["operator", "OPERATOR_ACTIVITY_STARTED"], ["closed-target", "ORDER_CLOSED"],
  ["revision", "DISPATCH_PLAN_CHANGED"], ["signature", "DISPATCH_TARGET_CHANGED"],
  ["lease", "DISPATCH_EDIT_LEASE_HELD"], ["terminal-plan", "DISPATCH_PLAN_TERMINAL"]]) {
  test(`completed TO does not bypass ${scenario} guard`, () => rollbackTest(async () => {
    const f = await seedTransferDependency();
    await seedTransferJob(f);
    const command = unlinkCommand(f);
    if (scenario === "operator") { await query("UPDATE sales_order_lines SET confirmed=true WHERE id=$1", [f.salesLineId]); }
    if (scenario === "closed-target") { await query("UPDATE sales_orders SET status='H',status_text='Sales Order : Closed' WHERE netsuite_id=$1", [f.salesId]); }
    if (scenario === "revision") { command.expectedPlanRevision -= 1; }
    if (scenario === "signature") { command.targetSignature = "stale"; }
    if (scenario === "lease") {
      await query("INSERT INTO operators (id,username,display_name,password_hash,password_salt,role,roles) VALUES ('other-planner','unlink-test-planner','Other planner','test-hash','test-salt','dispatcher',ARRAY['dispatcher'])");
      await query(`INSERT INTO dispatch_plan_edit_leases (plan_date,operator_id,operator_name,session_id,token_hash,expires_at)
        VALUES ($1,'other-planner','Other planner','other-session','test-only-hash',now()+interval '1 hour')`, [f.plan.planDate]);
    }
    if (scenario === "terminal-plan") { await query("UPDATE dispatch_plans SET status='completed' WHERE id=$1", [f.plan.id]); }
    const preview = await previewScmDependencyMutation(command);
    assert.equal(preview.allowed, false);
    assert.ok(preview.blockers.some((blocker) => blocker.code === code), JSON.stringify(preview.blockers));
  }));
}

test("failed post-unlink validation rolls back relationship, plan, audit and receipt", () => rollbackTest(async () => {
  const f = await seedTransferDependency();
  await seedTransferJob(f);
  const command = unlinkCommand(f);
  command.payloadHash = scmDependencyPayloadHash(command);
  const before = await executionEvidence(f);
  const planBefore = await getDispatchPlan(f.plan.id);
  await assert.rejects(executeScmDependencyCommand(command, {}, { validatePlan() { throw new Error("Injected validation failure"); } }), /Injected validation failure/u);
  assert.deepEqual(await executionEvidence(f), before);
  assert.deepEqual(await getDispatchPlan(f.plan.id), planBefore);
  assert.equal((await query("SELECT status FROM order_dependencies WHERE id=$1", [f.dependencyId])).rows[0].status, "active");
  assert.equal(Number((await query("SELECT count(*) FROM dispatch_audit_log WHERE action='dispatch.order_dependency.unlinked' AND entity_id=$1", [String(f.dependencyId)])).rows[0].count), 0);
  const result = await executeScmDependencyCommand(command);
  assert.equal(result.status, "applied");
}));
