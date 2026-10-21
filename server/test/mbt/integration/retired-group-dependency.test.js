import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { query, withTransaction, closeDb, pool } from "../../../src/db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../../../src/dispatch-fleet-status.js";
import { seedLinkGroup, linkCommand } from "../../support/link-to-fix-fixture.mjs";
import {
  createOrderDependency,
  syncOrderDependenciesFromDispatchPlan,
  updateOrderDependencyMode
} from "../../../src/order-dependency-repository.js";
import { resolveDispatchSalesTarget } from "../../../src/dispatch-order-target-repository.js";

after(closeDb);
const isolated = run => withTransaction(run, { rollback: true });

async function fixture({ normal = true, mode = "yard_replenishment" } = {}) {
  const f = await seedLinkGroup();
  await query("DELETE FROM local_co_orders WHERE co_ref=$1", [f.coRef]);
  const command = await linkCommand(f, { planDate: f.plan.planDate, mode });
  f.dependency = await createOrderDependency({
    dispatchTargetRef: f.groupRef, planDate: f.plan.planDate,
    targetSignature: command.targetSignature, ...command.payload
  });
  if (normal) {
    await query("DELETE FROM order_dependency_lines WHERE dependency_id=$1 AND sales_line_id <> $2",
      [f.dependency.id, f.lines[0].id]);
    await query("UPDATE order_dependencies SET dispatch_target_ref=sales_order_ref,dispatch_target_kind='normal' WHERE id=$1",
      [f.dependency.id]);
    await query("UPDATE order_dependency_lines SET dispatch_target_line_key=$2||'::'||$2||'::'||sales_line_id::text WHERE dependency_id=$1",
      [f.dependency.id, f.members[0]]);
  }
  f.grouped = { id: f.plan.id, planDate: f.plan.planDate, revision: 1, orders: [f.group], trucks: [] };
  f.ungrouped = { ...f.grouped, revision: 2, orders: [], trucks: [] };
  await query("UPDATE dispatch_plans SET revision=1 WHERE id=$1", [f.plan.id]);
  return f;
}

async function state(f) {
  return {
    header: (await query("SELECT * FROM order_dependencies WHERE id=$1", [f.dependency.id])).rows[0],
    lines: (await query("SELECT * FROM order_dependency_lines WHERE dependency_id=$1 ORDER BY id", [f.dependency.id])).rows,
    transfer: (await query("SELECT * FROM transfer_orders WHERE netsuite_id=$1", [f.transferId])).rows[0]
  };
}

async function retire(f) {
  await query("UPDATE dispatch_plans SET revision=2 WHERE id=$1", [f.plan.id]);
  await query("UPDATE dispatch_global_order_groups SET active=false WHERE group_ref=$1", [f.groupRef]);
  await query("UPDATE dispatch_plan_snapshots SET orders='[]',trucks='[]' WHERE plan_id=$1", [f.plan.id]);
}

function allocationEvidence(current) {
  return current.lines.map(({ dispatch_target_line_key: _key, updated_at: _at, ...line }) => line);
}

test("a delayed grouping follow-up cannot attach an original link to a retired group", () => isolated(async () => {
  const f = await fixture();
  await retire(f);
  const before = await state(f);
  await syncOrderDependenciesFromDispatchPlan(f.grouped);
  assert.deepEqual(await state(f), before);
}));

test("compact ungroup follow-up releases an untouched single-source yard link and preserves all allocation evidence", () => isolated(async () => {
  const f = await fixture();
  await syncOrderDependenciesFromDispatchPlan(f.grouped);
  const before = await state(f);
  assert.equal(before.header.dispatch_target_ref, f.groupRef);
  await retire(f);
  const result = await syncOrderDependenciesFromDispatchPlan(f.ungrouped);
  const current = await state(f);
  assert.equal(result.released[0]?.dependencyId, f.dependency.id);
  assert.equal(current.header.dispatch_target_ref, f.members[0]);
  assert.equal(current.header.dispatch_target_kind, "normal");
  assert.deepEqual(allocationEvidence(current), allocationEvidence(before));
  assert.deepEqual(current.transfer, before.transfer);
  assert.ok(current.lines.every(line => line.dispatch_target_line_key.startsWith(`${f.members[0]}::${f.members[0]}::`)));
  await assert.rejects(resolveDispatchSalesTarget({ dispatchTargetRef: f.groupRef }), { code: "DISPATCH_DERIVED_ORDER_RETIRED" });
  const audits = (await query("SELECT action FROM dispatch_audit_log WHERE entity_type='order_dependency' AND entity_id=$1 ORDER BY id",
    [String(f.dependency.id)])).rows.map(row => row.action);
  assert.ok(audits.includes("dispatch.order_dependency.group_target_released"));
  assert.equal((await syncOrderDependenciesFromDispatchPlan(f.ungrouped)).released.length, 0);
  const changed = await updateOrderDependencyMode(f.dependency.id, "direct_to_customer", null, f.plan.planDate);
  assert.equal(changed.dispatchTargetRef, f.members[0]);
}));

test("retirement does not release active groups, direct links, multiple source allocations, or executed material", () => isolated(async () => {
  for (const scenario of ["active-group", "direct", "multiple-sources", "loaded", "delivered", "received"]) {
    await isolated(async () => {
      const f = await fixture({ normal: scenario !== "multiple-sources", mode: scenario === "direct" ? "direct_to_customer" : "yard_replenishment" });
      if (scenario !== "multiple-sources") {
        await syncOrderDependenciesFromDispatchPlan(f.grouped);
      }
      if (scenario !== "active-group") {
        await retire(f);
      }
      const progress = { loaded: "loaded_quantity", delivered: "delivered_quantity", received: "locally_received_quantity" }[scenario];
      if (progress) {
        await query(`UPDATE order_dependency_lines SET ${progress}=1 WHERE dependency_id=$1`, [f.dependency.id]);
      }
      const before = await state(f);
      await syncOrderDependenciesFromDispatchPlan(scenario === "active-group" ? { ...f.grouped, orders: [] } : f.ungrouped);
      assert.deepEqual(await state(f), before, scenario);
    });
  }
}));

test("superseded ungroup follow-ups cannot release a currently active regrouped dependency", () => isolated(async () => {
  const f = await fixture();
  await syncOrderDependenciesFromDispatchPlan(f.grouped);
  await query("UPDATE dispatch_plans SET revision=3 WHERE id=$1", [f.plan.id]);
  const before = await state(f);
  await syncOrderDependenciesFromDispatchPlan(f.ungrouped, {
    allowEstablishedUngroupTargets: [{ sourceOrderRef: f.members[0], groupRef: f.groupRef }]
  });
  assert.deepEqual(await state(f), before);
}));

test("rollback restores the complete dependency after compact retirement repair", () => isolated(async () => {
  const f = await fixture();
  await syncOrderDependenciesFromDispatchPlan(f.grouped);
  await retire(f);
  const before = await state(f);
  await isolated(async () => {
    await syncOrderDependenciesFromDispatchPlan(f.ungrouped);
    assert.equal((await state(f)).header.dispatch_target_ref, f.members[0]);
  });
  assert.deepEqual(await state(f), before);
}));

test("scoped retirement repair changes only the explicitly selected dependency", () => isolated(async () => {
  const selected = await fixture();
  const other = await fixture();
  for (const f of [selected, other]) {
    await syncOrderDependenciesFromDispatchPlan(f.grouped);
  }
  for (const f of [selected, other]) {
    await retire(f);
  }
  const untouched = await state(other);
  const result = await syncOrderDependenciesFromDispatchPlan(selected.ungrouped, {
    dependencyIds: [selected.dependency.id]
  });
  assert.deepEqual(result.released.map(row => row.dependencyId), [selected.dependency.id]);
  assert.equal((await state(selected)).header.dispatch_target_ref, selected.members[0]);
  assert.deepEqual(await state(other), untouched);
}));

test("follow-up ordering is idempotent across old and current revisions", () => isolated(async () => {
  const f = await fixture();
  await syncOrderDependenciesFromDispatchPlan(f.grouped);
  await retire(f);
  const before = await state(f);
  await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), async choices => {
    await isolated(async () => {
      for (const old of choices) {
        await syncOrderDependenciesFromDispatchPlan(old ? f.grouped : f.ungrouped);
      }
      await syncOrderDependenciesFromDispatchPlan(f.ungrouped);
      const current = await state(f);
      assert.equal(current.header.dispatch_target_ref, f.members[0]);
      assert.deepEqual(allocationEvidence(current), allocationEvidence(before));
      assert.deepEqual(current.transfer, before.transfer);
    });
  }), { seed: 68626863, numRuns: 12 });
}));

test("a follow-up waiting on a concurrent plan save checks the committed revision before writing", async () => {
  const f = await withTransaction(() => fixture());
  const blocker = await pool.connect();
  let running;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    const before = await state(f);
    running = syncOrderDependenciesFromDispatchPlan(f.grouped);
    const lockWait = await pool.connect();
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 80 && !waiting; attempt += 1) {
        waiting = (await lockWait.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted) AS waiting")).rows[0].waiting;
        if (!waiting) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      assert.equal(waiting, true, "follow-up must wait for the same lock as plan saves");
    } finally {
      lockWait.release();
    }
    await blocker.query("UPDATE dispatch_plans SET revision=2 WHERE id=$1", [f.plan.id]);
    await blocker.query("UPDATE dispatch_global_order_groups SET active=false WHERE group_ref=$1", [f.groupRef]);
    await blocker.query("COMMIT");
    await running;
    assert.deepEqual(await state(f), before);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await running?.catch(() => null);
    await query("DELETE FROM dispatch_audit_log WHERE plan_id=$1 OR (entity_type='order_dependency' AND entity_id=$2)",
      [f.plan.id, String(f.dependency.id)]);
    await query("DELETE FROM order_dependencies WHERE id=$1", [f.dependency.id]);
    await query("DELETE FROM dispatch_global_order_groups WHERE group_ref=$1", [f.groupRef]);
    await query("DELETE FROM dispatch_plans WHERE id=$1", [f.plan.id]);
    await query("DELETE FROM transfer_orders WHERE netsuite_id=$1", [f.transferId]);
    await query("DELETE FROM sales_orders WHERE tranid=ANY($1::text[])", [f.members]);
  }
});
