import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test, { after as afterAll } from "node:test";
import fc from "fast-check";
import { beginRollbackContext, closeDb, query, pool, withTransaction } from "../../../src/db.js";
import { repairDispatchRetiredConfirm } from "../../../tools/repair-dispatch-retired-confirm.mjs";
import { getDispatchOrderCatalogOrder, listDispatchOrderPool } from "../../../src/dispatch-order-catalog-repository.js";

afterAll(closeDb);
const ref = "CO-GOA-7894-7895";

async function fixture() {
  const plan = (await query("INSERT INTO dispatch_plans(plan_date,status,revision) VALUES ('2096-09-14','draft',1) RETURNING id")).rows[0];
  await query(`INSERT INTO local_co_orders(co_ref,source_order_ref,from_location_id,from_location,to_location_id,to_location,status,updated_at)
    VALUES ($1,'GOA-7894-7895',1,'3445',15,'12441','pending_load','2026-09-01 22:53:17Z')`, [ref]);
  await query(`INSERT INTO local_co_order_lines(co_id,line_id,item_id,item_name,sku,quantity,unit)
    SELECT id,1,817140900,'Regression','REGRESSION',4,'EA' FROM local_co_orders WHERE co_ref=$1`, [ref]);
  const order = { id: ref, type: "CO", sourceTable: "local_co_orders", childOrders: ["SOA07894", "SOA07895"], globalGroupDefinition: true };
  await query(`INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_id,source_plan_date,full_order,card,active,updated_at)
    VALUES ($1,'CO',$2,'2096-09-14',$3::jsonb,'{}',false,'2026-09-01 22:22:47Z')`, [ref, plan.id, JSON.stringify(order)]);
  await query(`INSERT INTO dispatch_global_order_group_members(group_ref,member_order_ref,position,hides_member)
    VALUES ($1,'SOA07894',0,false),($1,'SOA07895',1,false)`, [ref]);
  await query(`INSERT INTO dispatch_audit_log(action,order_id,entity_id,created_at) VALUES
    ('co_cancelled_in_local_db',$1,$1,'2026-09-01 22:22:46Z'),('co_saved_to_local_db',$1,$1,'2026-09-01 22:52:39Z')`, [ref]);
  return plan.id;
}

async function scenario(run) {
  const rollback = await beginRollbackContext();
  const dir = await fs.mkdtemp("/tmp/retired-confirm-repair-");
  try {
    await rollback.run(async () => { await fixture(); await run(`${dir}/before.json`); });
  } finally { await rollback.rollback(); await fs.rm(dir, { recursive: true, force: true }); }
}

async function state() {
  return {
    group: (await query("SELECT * FROM dispatch_global_order_groups WHERE group_ref=$1", [ref])).rows,
    members: (await query("SELECT * FROM dispatch_global_order_group_members WHERE group_ref=$1 ORDER BY position", [ref])).rows,
    co: (await query("SELECT * FROM local_co_orders WHERE co_ref=$1", [ref])).rows,
    audit: (await query("SELECT * FROM dispatch_audit_log WHERE order_id=$1 ORDER BY id", [ref])).rows
  };
}

test("repair rehearses with rollback, applies only the obsolete definition, audits before-image and is idempotent", () => scenario(async backupPath => {
  const before = await state();
  const rehearsal = await repairDispatchRetiredConfirm();
  assert.equal(rehearsal.rolledBack, true);
  assert.deepEqual(await state(), before);
  const applied = await repairDispatchRetiredConfirm({ apply: true, expectedFingerprint: rehearsal.fingerprint, backupPath });
  assert.equal(applied.applied, true);
  const after = await state();
  assert.deepEqual(after.co, before.co);
  assert.deepEqual(after.group, []);
  assert.deepEqual(after.members, []);
  assert.equal(after.audit.length, before.audit.length + 1);
  assert.deepEqual(after.audit.at(-1).before_state.group, JSON.parse(JSON.stringify(before.group[0])));
  assert.deepEqual(JSON.parse(await fs.readFile(backupPath, "utf8")).co, JSON.parse(JSON.stringify(before.co[0])));
  assert.equal((await fs.stat(backupPath)).mode & 0o777, 0o600);
  assert.equal((await repairDispatchRetiredConfirm()).alreadyCorrect, true);
}));

for (const [name, sql] of [
  ["cancelled canonical CO", "UPDATE local_co_orders SET status='cancelled' WHERE co_ref=$1"],
  ["active definition", "UPDATE dispatch_global_order_groups SET active=true WHERE group_ref=$1"],
  ["genuine aggregate CO", "UPDATE dispatch_global_order_groups SET full_order=jsonb_set(full_order,'{childOrders}','[\"CO-SOA07894\",\"CO-SOA07895\"]') WHERE group_ref=$1"],
  ["no subsequent explicit recreation", "DELETE FROM dispatch_audit_log WHERE order_id=$1 AND action='co_saved_to_local_db'"],
  ["later cancellation audit", "INSERT INTO dispatch_audit_log(action,order_id,created_at) VALUES ('co_cancelled_in_local_db',$1,'2026-09-01 23:00Z')"]
]) {
  test(`repair rejects ${name} and leaves all records intact`, () => scenario(async () => {
    await query(sql, [ref]);
    const before = await state();
    await assert.rejects(repairDispatchRetiredConfirm(), /Repair guard:/u);
    assert.deepEqual(await state(), before);
  }));
}

test("changed state after rehearsal requires a fresh fingerprint", () => scenario(async backupPath => {
  const rehearsal = await repairDispatchRetiredConfirm();
  await query("UPDATE local_co_orders SET updated_at=updated_at + interval '1 second' WHERE co_ref=$1", [ref]);
  const before = await state();
  await assert.rejects(repairDispatchRetiredConfirm({ apply: true, expectedFingerprint: rehearsal.fingerprint, backupPath }), /Repair guard:.*changed/u);
  assert.deepEqual(await state(), before);
}));

test("repair makes the recreated canonical CO immediately available in catalog hydration and browse", () => scenario(async backupPath => {
  const rehearsal = await repairDispatchRetiredConfirm();
  await repairDispatchRetiredConfirm({ apply: true, expectedFingerprint: rehearsal.fingerprint, backupPath });
  const co = await getDispatchOrderCatalogOrder(ref);
  assert.equal(co?.id, ref);
  assert.equal(co.sourceTable, "local_co_orders");
  assert.equal(co.items[0].quantity, 4);
  assert.ok((await listDispatchOrderPool({ type: "CO", search: ref })).orders.some(order => order.id === ref));
}));

test("audit failure rolls back deletion of the obsolete definition and members", () => scenario(async backupPath => {
  const rehearsal = await repairDispatchRetiredConfirm();
  await query(`CREATE FUNCTION pg_temp.reject_retired_repair_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='dispatch_retired_direct_co_definition_repaired' THEN RAISE EXCEPTION 'simulated audit write failure'; END IF; RETURN NEW; END $$`);
  await query(`CREATE TRIGGER reject_retired_repair_audit BEFORE INSERT ON dispatch_audit_log
    FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_retired_repair_audit()`);
  const before = await state();
  await assert.rejects(repairDispatchRetiredConfirm({ apply: true, expectedFingerprint: rehearsal.fingerprint, backupPath }), /simulated audit write failure/u);
  assert.deepEqual(await state(), before);
}));

test("property: repair respects active definitions and compare-and-apply fingerprints without changing canonical COs", async () => {
  await fc.assert(fc.asyncProperty(fc.record({ active: fc.boolean(), changed: fc.boolean() }), flags => scenario(async backupPath => {
    if (flags.active) {
      await query("UPDATE dispatch_global_order_groups SET active=true WHERE group_ref=$1", [ref]);
      const before = await state();
      await assert.rejects(repairDispatchRetiredConfirm(), /Repair guard:/u);
      assert.deepEqual(await state(), before);
      return;
    }
    const rehearsal = await repairDispatchRetiredConfirm();
    if (flags.changed) { await query("UPDATE local_co_orders SET updated_at=updated_at + interval '1 second' WHERE co_ref=$1", [ref]); }
    const before = await state();
    if (flags.changed) {
      await assert.rejects(repairDispatchRetiredConfirm({ apply: true, expectedFingerprint: rehearsal.fingerprint, backupPath }), /Repair guard:.*changed/u);
      assert.deepEqual(await state(), before);
    } else {
      const result = await repairDispatchRetiredConfirm({ apply: true, expectedFingerprint: rehearsal.fingerprint, backupPath });
      assert.equal(result.applied, true);
      const after = await state();
      assert.deepEqual(after.co, before.co);
      assert.deepEqual(after.group, []);
      assert.equal((await getDispatchOrderCatalogOrder(ref))?.id, ref);
    }
  })), { seed: 20260914, numRuns: 24 });
});

test("concurrent cancellation blocks the repair, which rechecks the committed status before writing", async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  assert.equal(new URL(process.env.DATABASE_URL).pathname, "/mbt_test");
  assert.equal((await query("SELECT 1 FROM local_co_orders WHERE co_ref=$1", [ref])).rowCount, 0);
  const planId = await withTransaction(fixture);
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("UPDATE local_co_orders SET status='cancelled' WHERE co_ref=$1", [ref]);
    const pid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    const pending = repairDispatchRetiredConfirm().then(result => ({ result }), error => ({ error }));
    let blocked = false;
    const deadline = Date.now() + 3000;
    while (!blocked && Date.now() < deadline) {
      blocked = (await query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid])).rowCount > 0;
      if (!blocked) { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.equal(blocked, true, "Repair must wait for the canonical row lock");
    await blocker.query("COMMIT");
    const outcome = await pending;
    assert.match(outcome.error?.message || "", /Repair guard: canonical CO/u);
    assert.equal((await query("SELECT active FROM dispatch_global_order_groups WHERE group_ref=$1", [ref])).rows[0].active, false);
    assert.equal((await query("SELECT status FROM local_co_orders WHERE co_ref=$1", [ref])).rows[0].status, "cancelled");
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await withTransaction(async () => {
      await query("DELETE FROM dispatch_audit_log WHERE order_id=$1", [ref]);
      await query("DELETE FROM local_co_orders WHERE co_ref=$1", [ref]);
      // Global definitions intentionally survive deletion of their source plan.
      await query("DELETE FROM dispatch_global_order_groups WHERE group_ref=$1", [ref]);
      await query("DELETE FROM dispatch_plans WHERE id=$1", [planId]);
    });
    assert.equal((await query("SELECT 1 FROM dispatch_global_order_groups WHERE group_ref=$1", [ref])).rowCount, 0);
  }
});
