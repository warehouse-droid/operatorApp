import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const mode = process.env.RETIRED_GROUP_MODE || "inspect";
assert.ok(["inspect", "repair", "verify"].includes(mode));
const source = name => pathToFileURL(path.resolve("src", name)).href;
const { query, withTransaction, pool, closeDb } = await import(source("db.js"));
const { DISPATCH_FLEET_PLANNING_LOCK } = await import(source("dispatch-fleet-status.js"));
pool.options.options = "-c jit=off -c statement_timeout=20000"
  + (mode === "repair" ? "" : " -c default_transaction_read_only=on");
const expected = process.env.RETIRED_GROUP_EXPECTED ? JSON.parse(process.env.RETIRED_GROUP_EXPECTED) : null;

async function state() {
  const dependency = (await query("SELECT * FROM order_dependencies WHERE id=272")).rows[0];
  const lines = (await query("SELECT * FROM order_dependency_lines WHERE dependency_id=272 ORDER BY id")).rows;
  const group = (await query("SELECT group_ref,active,full_order->'childOrders' AS members FROM dispatch_global_order_groups WHERE group_ref='GOM-6862-6863'")).rows[0];
  const sources = (await query("SELECT tranid,netsuite_active FROM sales_orders WHERE tranid IN ('SOM06862','SOM06863') ORDER BY tranid")).rows;
  const hashes = (await query(`SELECT
    (SELECT md5(to_jsonb(t)::text) FROM transfer_orders t WHERE tranid='TOB01194') AS transfer,
    (SELECT md5(COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]')::text)
       FROM transfer_order_lines l JOIN transfer_orders t ON t.netsuite_id=l.transfer_order_id WHERE t.tranid='TOB01194') AS transfer_lines,
    (SELECT md5(COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]')::text) FROM order_dependencies d WHERE d.id<>272) AS other_dependencies,
    (SELECT md5(COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]')::text) FROM order_dependency_lines l WHERE l.dependency_id<>272) AS other_allocations,
    (SELECT md5(to_jsonb(p)::text) FROM dispatch_plans p WHERE id=349) AS plan,
    (SELECT md5(to_jsonb(s)::text) FROM dispatch_plan_snapshots s WHERE plan_id=349) AS snapshot`)).rows[0];
  return JSON.parse(JSON.stringify({ dependency, lines, group, sources, hashes }));
}

function unchangedEvidence(before, after) {
  const stripped = lines => lines.map(({ dispatch_target_line_key: _key, updated_at: _at, ...line }) => line);
  assert.deepEqual(stripped(after.lines), stripped(before.lines));
  assert.deepEqual(after.hashes, before.hashes);
  assert.deepEqual(after.group, before.group);
  assert.deepEqual(after.sources, before.sources);
  const headerEvidence = ({ dispatch_target_ref: _ref, dispatch_target_kind: _kind, updated_at: _at, ...header }) => header;
  assert.deepEqual(headerEvidence(after.dependency), headerEvidence(before.dependency));
}

try {
  const result = await withTransaction(async () => {
    if (mode === "repair") {
      await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
      await query("SELECT id FROM order_dependencies WHERE id=272 FOR UPDATE");
    } else {
      await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    }
    const before = await state();
    assert.equal(before.dependency.sales_order_ref, "SOM06863");
    assert.equal(before.dependency.transfer_order_ref, "TOB01194");
    assert.equal(before.dependency.dependency_mode, "yard_replenishment");
    assert.equal(before.dependency.status, "active");
    assert.equal(before.group.active, false);
    assert.equal(before.lines.length, 1);
    assert.equal(before.lines[0].line_role, "sales_allocation");
    assert.equal(Number(before.lines[0].allocated_quantity), 15);
    assert.ok(before.sources.every(row => row.netsuite_active === true));
    for (const line of before.lines) {
      assert.equal(Number(line.loaded_quantity), 0);
      assert.equal(Number(line.delivered_quantity), 0);
      assert.equal(Number(line.locally_received_quantity), 0);
    }
    if (mode === "inspect") { return { mode, before }; }
    assert.ok(expected, "a captured expected state is required");
    const { resolveDispatchSalesTarget } = await import(source("dispatch-order-target-repository.js"));
    if (mode === "verify") {
      assert.equal(before.dependency.dispatch_target_ref, "SOM06863");
      assert.equal(before.dependency.dispatch_target_kind, "normal");
      unchangedEvidence(expected.before, before);
      const resolved = await resolveDispatchSalesTarget({ dispatchTargetRef: "SOM06863", planDate: "2026-10-07" });
      assert.equal(resolved.target.kind, "normal");
      return { mode, repaired: true, target: resolved.target.ref, quantitiesPreserved: true, unrelatedRecordsPreserved: true };
    }
    assert.deepEqual(before, expected.before, "live state changed since inspection; inspect again before repair");
    assert.equal(before.dependency.dispatch_target_ref, "GOM-6862-6863");
    assert.equal(before.dependency.dispatch_target_kind, "group");
    const row = (await query(`SELECT p.id,p.plan_date::text AS "planDate",p.revision,s.orders,s.trucks
      FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=349 FOR UPDATE OF p`)).rows[0];
    const { syncOrderDependenciesFromDispatchPlan } = await import(source("order-dependency-repository.js"));
    const changed = await syncOrderDependenciesFromDispatchPlan(row, { dependencyIds: [272] });
    assert.deepEqual(changed.released.map(entry => Number(entry.dependencyId)), [272]);
    const after = await state();
    assert.equal(after.dependency.dispatch_target_ref, "SOM06863");
    assert.equal(after.dependency.dispatch_target_kind, "normal");
    unchangedEvidence(before, after);
    const resolved = await resolveDispatchSalesTarget({ dispatchTargetRef: "SOM06863", planDate: "2026-10-07" });
    assert.equal(resolved.target.kind, "normal");
    return { mode, repaired: true, dependencyId: 272, transferOrderRef: "TOB01194", target: "SOM06863",
      quantitiesPreserved: true, unrelatedRecordsPreserved: true, after };
  });
  console.log(JSON.stringify(result));
} finally {
  await closeDb();
}
