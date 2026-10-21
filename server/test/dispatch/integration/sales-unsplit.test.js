import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb, pool, query } from "../../../src/db.js";
import { resplitUnfinishedSalesOrder, unsplitSalesOrder } from "../../../src/dispatch-sales-resplit-repository.js";
import { deactivateDispatchGlobalOrderDefinitions, syncDispatchGlobalOrderSplitsFromPlan } from "../../../src/dispatch-delivery-group-repository.js";
import { materializeSalesSplitOrder } from "../../../src/delivery-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../../../src/dispatch-fleet-status.js";
import { scenario, seedSalesOrder } from "../support/fulfilled-so-fixture.js";
import { seedUnfinishedSplit } from "../support/unfinished-sales-resplit-fixture.js";

after(closeDb);
const input = (fixture, ref = fixture.source.id) => ({ orderRef: ref, planId: fixture.current.id, planDate: fixture.current.planDate });
async function children(fixture) {
  const parts = [53, 53].map((quantity, index) => ({ items: [
    { ...fixture.source.items[0], quantity }, { ...fixture.source.items[1], quantity: index ? 1 : 2 }
  ] }));
  return (await resplitUnfinishedSalesOrder({ ...input(fixture), expectedItems: fixture.source.items, parts })).orders;
}
async function ungroupFirst(fixture, keepCompletion = false) {
  await deactivateDispatchGlobalOrderDefinitions([fixture.group.id]);
  await query("UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks='[]'::jsonb WHERE plan_id=$1",
    [fixture.historical.id, JSON.stringify([fixture.first, fixture.source])]);
  if (!keepCompletion) {
    await query("DELETE FROM driver_job_records WHERE order_refs ? $1", [fixture.first.id]);
  }
}
async function familyState(fixture) {
  return (await query("SELECT split_ref,active,full_order FROM dispatch_global_order_splits WHERE parent_order_ref=$1 ORDER BY split_ref", [fixture.parent])).rows;
}

async function waitForLockWaiter(client) {
  const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = await query("SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND wait_event='advisory'", [pid]);
    if (waiting.rowCount) { return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Unsplit did not wait for the held PostgreSQL advisory lock.");
}

test("delivered S1 blocks unsplitting S2 to the original SO even when the request omits S1", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit();
  await ungroupFirst(fixture, true);
  const before = await familyState(fixture), history = await fixture.history();
  await assert.rejects(unsplitSalesOrder({ ...input(fixture), splitOrderIds: [fixture.source.id] }), /completed|Driver/iu);
  assert.deepEqual(await familyState(fixture), before);
  assert.deepEqual(await fixture.history(), history);
}));

test("a sibling planned on another date blocks an initial unsplit", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit({ completedFirst: false }), before = await familyState(fixture);
  await assert.rejects(unsplitSalesOrder(input(fixture)), /plan|group/iu);
  assert.deepEqual(await familyState(fixture), before);
}));

for (const manual of [false, true]) {
test(`an inactive ${manual ? "manually completed" : "delivered"} S1 still blocks merging its remaining root siblings`, () => scenario(async () => {
  const fixture = await seedUnfinishedSplit({ completedFirst: !manual });
  if (manual) {
    await query(`INSERT INTO dispatch_order_completion_events(order_kind,order_ref,dispatch_completed_at,
      completion_evidence_type,completion_evidence_id,actor_type,actor_id,reason)
      VALUES('SO',$1,now(),'manual_dispatch',$2,'operator','unsplit-test-operator','Historical manual completion fixture')`,
    [fixture.first.id, 'manual-' + fixture.first.id]);
  }
  await ungroupFirst(fixture, true);
  await deactivateDispatchGlobalOrderDefinitions([fixture.first.id]);
  const second = { ...fixture.source, items: [{ ...fixture.source.items[0], quantity: 53 }, { ...fixture.source.items[1], quantity: 2 }] };
  const third = { ...second, id: fixture.parent + "-S3", items: [{ ...second.items[0] }, { ...second.items[1], quantity: 1 }] };
  await query("UPDATE sales_order_lines SET quantity=CASE WHEN line_id=1 THEN 106 ELSE 3 END WHERE sales_order_id=$1", [fixture.id]);
  await query("UPDATE sales_order_lines SET quantity=CASE WHEN line_id=1 THEN 53 ELSE 2 END WHERE sales_order_id=$1", [-fixture.id]);
  await materializeSalesSplitOrder(third, { netsuite_id: fixture.id });
  await syncDispatchGlobalOrderSplitsFromPlan({ id: fixture.historical.id, planDate: fixture.historical.planDate,
    revision: fixture.historical.revision, orders: [second, third], trucks: [] });
  const before = await familyState(fixture), history = await fixture.history();
  await assert.rejects(unsplitSalesOrder(input(fixture, second.id)), /completed|Driver/iu);
  assert.deepEqual(await familyState(fixture), before);
  assert.deepEqual(await fixture.history(), history);
}));
}

test("unplanned S1/S2 restore their original SO and all original quantities", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit({ completedFirst: false });
  await ungroupFirst(fixture);
  const result = await unsplitSalesOrder(input(fixture));
  assert.equal(result.restoredOrder.id, fixture.parent);
  assert.equal(result.restoredOrder.originalOrderId, "");
  assert.deepEqual(result.deactivated.sort(), [fixture.first.id, fixture.source.id].sort());
  assert.deepEqual(result.restoredOrder.items.map(item => item.quantity), [136, 4]);
  assert.ok((await familyState(fixture)).every(row => !row.active));
}));

test("retired unused parts from an earlier split do not block reversing a fresh root split", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit({ completedFirst: false });
  await ungroupFirst(fixture);
  const first = await unsplitSalesOrder(input(fixture));
  const fresh = [3, 4].map(number => ({ ...first.restoredOrder, id: `${fixture.parent}-S${number}`,
    originalOrderId: fixture.parent, planOwned: true, salesQty: 70,
    items: first.restoredOrder.items.map(item => ({ ...item, quantity: item.lineId === 1 ? 68 : 2 })) }));
  for (const order of fresh) { await materializeSalesSplitOrder(order, { netsuite_id: fixture.id }); }
  await syncDispatchGlobalOrderSplitsFromPlan({ id: fixture.current.id, planDate: fixture.current.planDate,
    revision: fixture.current.revision, orders: fresh, trucks: [] });
  const result = await unsplitSalesOrder(input(fixture, fresh[0].id));
  assert.equal(result.restoredOrder.id, fixture.parent);
  assert.deepEqual(result.restoredOrder.items.map(item => item.quantity), [136, 4]);
  assert.deepEqual(result.deactivated.sort(), fresh.map(order => order.id).sort());
  assert.equal((await query("SELECT netsuite_active FROM sales_orders WHERE tranid=$1", [fixture.source.id])).rows[0].netsuite_active, false);
}));

test("unplanned S3/S4 restore S2 with its identity, quantities, address and delivered S1 history intact", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit(), split = await children(fixture), history = await fixture.history();
  const result = await unsplitSalesOrder(input(fixture, split[0].id));
  assert.equal(result.restoredOrder.id, fixture.source.id);
  assert.equal(result.restoredOrder.originalOrderId, fixture.parent);
  assert.equal(result.restoredOrder.netsuiteId, fixture.source.netsuiteId);
  assert.deepEqual(result.restoredOrder.items, fixture.source.items);
  assert.equal(result.restoredOrder.address, fixture.source.address);
  assert.deepEqual(result.deactivated.sort(), split.map(order => order.id).sort());
  assert.deepEqual(await fixture.history(), history);
  const restored = (await query("SELECT netsuite_active FROM sales_orders WHERE tranid=$1", [fixture.source.id])).rows;
  assert.equal(restored.length, 1);
  assert.equal(restored[0].netsuite_active, true);
  assert.deepEqual((await query("SELECT quantity FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY line_id", [-fixture.id])).rows.map(row => Number(row.quantity)), [106, 3]);
  assert.equal((await query("SELECT count(*)::int AS n FROM dispatch_audit_log WHERE action='order_unsplit' AND order_id=$1", [fixture.source.id])).rows[0].n, 1);
  await assert.rejects(unsplitSalesOrder(input(fixture, split[0].id)), { code: "DISPATCH_UNSPLIT_STALE" });
}));

test("a retired delivered S1 native record does not block S3/S4 restoring S2", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit();
  const firstId = await materializeSalesSplitOrder(fixture.first, { netsuite_id: fixture.id });
  await query("UPDATE sales_orders SET fulfillment_status='fulfilled',fulfilled_at=now() WHERE netsuite_id=$1", [firstId]);
  await query("UPDATE sales_order_lines SET fulfilled_piece_qty=1 WHERE sales_order_id=$1 AND line_id=1", [firstId]);
  await deactivateDispatchGlobalOrderDefinitions([fixture.first.id]);
  const split = await children(fixture), history = await fixture.history();
  const result = await unsplitSalesOrder(input(fixture, split[0].id));
  assert.equal(result.restoredOrder.id, fixture.source.id);
  assert.deepEqual(await fixture.history(), history);
  assert.equal((await query("SELECT active FROM dispatch_global_order_splits WHERE split_ref=$1", [fixture.first.id])).rows[0].active, false);
}));

for (const [name, sql] of [
  ["planned", "UPDATE sales_orders SET dispatch_planned=true,dispatch_plan_date='2097-10-20' WHERE tranid=$1"],
  ["packed", "UPDATE sales_order_lines SET packed_sales_qty=1 WHERE sales_order_id=(SELECT netsuite_id FROM sales_orders WHERE tranid=$1)"],
  ["loaded", "UPDATE sales_order_lines SET loaded_qty=1 WHERE sales_order_id=(SELECT netsuite_id FROM sales_orders WHERE tranid=$1)"],
  ["fulfilled", "UPDATE sales_orders SET fulfillment_status='fulfilled',fulfilled_at=now() WHERE tranid=$1"],
  ["driver completed", "INSERT INTO driver_job_records(job_id,driver_login,stop_type,order_refs,status,started_at,completed_at) VALUES('unsplit-'||$1,'test','dropoff',jsonb_build_array($1::text),'complete',now(),now())"]
]) {
  test(`a ${name} S4 blocks merging S3/S4 and preserves every family member`, () => scenario(async () => {
    const fixture = await seedUnfinishedSplit(), split = await children(fixture);
    await query(sql, [split[1].id]);
    const before = await familyState(fixture), history = await fixture.history();
    await assert.rejects(unsplitSalesOrder(input(fixture, split[0].id)), error => error.status === 409);
    assert.deepEqual(await familyState(fixture), before);
    assert.deepEqual(await fixture.history(), history);
  }));
}

test("further-split S3 prevents merging S4 to S2 until its children are restored", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit(), split = await children(fixture), source = split[0];
  const parts = [26, 27].map(quantity => ({ items: [
    { ...source.items[0], quantity }, { ...source.items[1], quantity: 1 }
  ] }));
  const next = await resplitUnfinishedSalesOrder({ ...input(fixture, source.id), expectedItems: source.items, parts });
  await assert.rejects(unsplitSalesOrder(input(fixture, split[1].id)), { code: "DISPATCH_UNSPLIT_DESCENDANTS" });
  await unsplitSalesOrder(input(fixture, next.orders[0].id));
  const result = await unsplitSalesOrder(input(fixture, split[1].id));
  assert.equal(result.restoredOrder.id, fixture.source.id);
}));

test("a parent restoration failure rolls back child retirement, quantities and history", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit(), split = await children(fixture), before = await familyState(fixture), history = await fixture.history();
  await query(`CREATE FUNCTION pg_temp.reject_unsplit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.tranid = '${fixture.source.id}' AND NEW.netsuite_active THEN RAISE EXCEPTION 'forced parent restoration failure'; END IF;
    RETURN NEW; END $$`);
  await query("CREATE TRIGGER reject_unsplit BEFORE UPDATE ON sales_orders FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_unsplit()");
  await assert.rejects(unsplitSalesOrder(input(fixture, split[0].id)), /forced parent restoration failure/u);
  assert.deepEqual(await familyState(fixture), before);
  assert.deepEqual(await fixture.history(), history);
}));

test("native sibling quantity changes cannot be overwritten by an older split snapshot", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit(), split = await children(fixture), before = await familyState(fixture);
  await query("UPDATE sales_order_lines SET quantity=quantity-1 WHERE sales_order_id=$1 AND line_id=1", [split[1].netsuiteId]);
  await assert.rejects(unsplitSalesOrder(input(fixture, split[0].id)), { code: "DISPATCH_UNSPLIT_STALE" });
  assert.deepEqual(await familyState(fixture), before);
}));

test("unknown selections and a mismatched plan cannot retire any sibling", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit(), split = await children(fixture), before = await familyState(fixture);
  await assert.rejects(unsplitSalesOrder(input(fixture, fixture.parent + "-S99")), { code: "DISPATCH_UNSPLIT_STALE" });
  await assert.rejects(unsplitSalesOrder({ ...input(fixture, split[0].id), planDate: "2097-12-31" }), { code: "DISPATCH_SPLIT_PLAN_MISMATCH" });
  assert.deepEqual(await familyState(fixture), before);
}));

test("a registered source split without a native row can still be restored from its exact saved quantities", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit();
  await query("DELETE FROM dispatch_scm_so_splits WHERE split_so_ref=$1", [fixture.source.id]);
  await query("DELETE FROM sales_order_lines WHERE sales_order_id=$1", [-fixture.id]);
  await query("DELETE FROM sales_orders WHERE netsuite_id=$1", [-fixture.id]);
  const split = await children(fixture), history = await fixture.history();
  const result = await unsplitSalesOrder(input(fixture, split[0].id));
  assert.equal(result.restoredOrder.id, fixture.source.id);
  assert.deepEqual(result.restoredOrder.items, fixture.source.items);
  assert.ok(Number(result.restoredOrder.netsuiteId) < 0);
  assert.deepEqual(await fixture.history(), history);
  assert.equal((await query("SELECT count(*)::int AS n FROM sales_orders WHERE tranid=$1 AND netsuite_active", [fixture.source.id])).rows[0].n, 1);
}));

for (const [name, change] of [
  ["duplicate native identity", async (fixture, split) => { await seedSalesOrder(-fixture.id - 20, split[0].id, { status: "B" }); }],
  ["already active restored parent", async fixture => { await query("UPDATE sales_orders SET netsuite_active=true WHERE tranid=$1", [fixture.source.id]); }],
  ["missing source plan", async fixture => { await query("UPDATE dispatch_global_order_splits SET source_plan_id=NULL WHERE split_ref=$1", [fixture.source.id]); }],
  ["missing current plan snapshot", async fixture => { await query("DELETE FROM dispatch_plan_snapshots WHERE plan_id=$1", [fixture.current.id]); }],
  ["missing original SO", async fixture => { await query("UPDATE sales_orders SET tranid=tranid||'-MISSING' WHERE netsuite_id=$1", [fixture.id]); }],
  ["unregistered native sibling", async fixture => {
    const id = -fixture.id - 20, ref = fixture.parent + "-S99";
    await seedSalesOrder(id, ref, { status: "B" });
    await query("INSERT INTO dispatch_scm_so_splits(source_so_id,source_so_ref,split_so_id,split_so_ref,status) VALUES($1,$2,$3,$4,'active')",
      [fixture.id, fixture.parent, id, ref]);
  }]
]) {
  test(`a ${name} fails without partially retiring the split group`, () => scenario(async () => {
    const fixture = await seedUnfinishedSplit(), split = await children(fixture);
    await change(fixture, split);
    const before = await familyState(fixture);
    await assert.rejects(unsplitSalesOrder(input(fixture, split[0].id)), { code: "DISPATCH_UNSPLIT_STALE" });
    assert.deepEqual(await familyState(fixture), before);
  }));
}

test("unsplit rechecks a sibling's packing after waiting for its operator lock", async () => {
  const fixture = await seedUnfinishedSplit({ date: "2097-10-22" }), split = await children(fixture);
  const siblingId = split[1].netsuiteId, client = await pool.connect();
  let pending;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`operator-delivery-load:${siblingId}`]);
    pending = unsplitSalesOrder(input(fixture, split[0].id));
    void pending.catch(() => undefined);
    await waitForLockWaiter(client);
    const rejected = assert.rejects(pending, /packed|clear/iu);
    await client.query("UPDATE sales_order_lines SET packed_sales_qty=1 WHERE sales_order_id=$1", [siblingId]);
    await client.query("COMMIT");
    await rejected;
    assert.equal((await query("SELECT active FROM dispatch_global_order_splits WHERE split_ref=$1", [split[0].id])).rows[0].active, true);
  } finally {
    await client.query("ROLLBACK"); client.release(); await pending?.catch(() => undefined);
  }
});

test("unsplit rechecks sibling planning after waiting for the fleet lock", async () => {
  const fixture = await seedUnfinishedSplit({ date: "2097-10-23" }), split = await children(fixture), client = await pool.connect();
  let pending;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    pending = unsplitSalesOrder(input(fixture, split[0].id));
    void pending.catch(() => undefined);
    await waitForLockWaiter(client);
    const rejected = assert.rejects(pending, /plan/iu);
    await client.query("UPDATE sales_orders SET dispatch_planned=true WHERE tranid=$1", [split[1].id]);
    await client.query("COMMIT"); await rejected;
  } finally {
    await client.query("ROLLBACK"); client.release(); await pending?.catch(() => undefined);
  }
});
