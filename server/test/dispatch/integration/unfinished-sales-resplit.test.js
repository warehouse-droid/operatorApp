import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { closeDb, pool, query } from "../../../src/db.js";
import { resplitUnfinishedSalesOrder } from "../../../src/dispatch-sales-resplit-repository.js";
import { getNextDispatchSplitSuffix } from "../../../src/delivery-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../../../src/dispatch-fleet-status.js";
import { scenario } from "../support/fulfilled-so-fixture.js";
import { seedUnfinishedSplit, seedResplitPoLink } from "../support/unfinished-sales-resplit-fixture.js";

after(closeDb);
const request = fixture => ({ orderRef: fixture.source.id, planId: fixture.current.id, planDate: fixture.current.planDate,
  expectedItems: fixture.source.items, parts: fixture.parts });

test("replace S2 atomically while keeping completed grouped S1, route, assignment and photos byte-for-byte", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit(), before = await fixture.history();
  const result = await resplitUnfinishedSalesOrder(request(fixture));
  assert.deepEqual(result.orders.map(order => order.id), [3, 4, 5].map(number => `${fixture.parent}-S${number}`));
  assert.deepEqual(result.retiredGlobalOrderRefs, [fixture.source.id]);
  assert.deepEqual(await fixture.history(), before);
  const retired = (await query("SELECT active FROM dispatch_global_order_splits WHERE split_ref=$1", [fixture.source.id])).rows[0];
  assert.equal(retired.active, false);
  assert.equal((await query("SELECT netsuite_active FROM sales_orders WHERE tranid=$1", [fixture.source.id])).rows[0].netsuite_active, false);
  assert.equal((await query("SELECT status FROM dispatch_scm_so_splits WHERE split_so_ref=$1", [fixture.source.id])).rows[0].status, "cancelled");
  const children = (await query(`SELECT s.tranid,SUM(l.quantity) AS qty FROM sales_orders s JOIN sales_order_lines l ON l.sales_order_id=s.netsuite_id
    WHERE s.tranid=ANY($1::text[]) AND s.netsuite_active=true GROUP BY s.tranid ORDER BY s.tranid`, [result.orders.map(order => order.id)])).rows;
  assert.deepEqual(children.map(row => Number(row.qty)), [37, 36, 36]);
}));

test("numbering includes retired and global-only siblings, and exact retry cannot reset subsequently packed children", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit();
  await query(`INSERT INTO dispatch_global_order_splits(split_ref,order_type,parent_order_ref,source_plan_date,full_order,card,active)
    VALUES($1,'SO',$2,'2097-10-02','{}','{}',false)`, [`${fixture.parent}-S7`, fixture.parent]);
  assert.equal((await getNextDispatchSplitSuffix({ originalOrderId: fixture.parent, orderType: "SO" })).nextSuffix, 8);
  const input = request(fixture), first = await resplitUnfinishedSalesOrder(input);
  await query("UPDATE sales_order_lines SET packed_sales_qty=quantity,confirmed=true WHERE sales_order_id=(SELECT netsuite_id FROM sales_orders WHERE tranid=$1)", [first.orders[0].id]);
  const before = (await query("SELECT to_jsonb(l) AS value FROM sales_order_lines l WHERE sales_order_id=(SELECT netsuite_id FROM sales_orders WHERE tranid=$1)", [first.orders[0].id])).rows;
  const replay = await resplitUnfinishedSalesOrder(input);
  assert.deepEqual(replay.orders.map(order => order.id), first.orders.map(order => order.id));
  assert.deepEqual((await query("SELECT to_jsonb(l) AS value FROM sales_order_lines l WHERE sales_order_id=(SELECT netsuite_id FROM sales_orders WHERE tranid=$1)", [first.orders[0].id])).rows, before);
  const changed = structuredClone(input); changed.parts[0].items[0].quantity -= 1; changed.parts[1].items[0].quantity += 1;
  await assert.rejects(resplitUnfinishedSalesOrder(changed), { code: "DISPATCH_SPLIT_RETIRED" });
}));

for (const [name, sql] of [
  ["packed", "UPDATE sales_order_lines SET packed_sales_qty=1 WHERE sales_order_id=$1"],
  ["loaded", "UPDATE sales_order_lines SET loaded_qty=1 WHERE sales_order_id=$1"],
  ["fulfilled", "UPDATE sales_order_lines SET fulfilled_piece_qty=1 WHERE sales_order_id=$1"],
  ["planned", "UPDATE sales_orders SET dispatch_planned=true,dispatch_plan_date='2097-10-12' WHERE netsuite_id=$1"],
  ["driver started", "INSERT INTO driver_job_records(job_id,driver_login,stop_type,order_refs,status,started_at) SELECT 'source-'||tranid,'source','pickup',jsonb_build_array(tranid),'in_progress',now() FROM sales_orders WHERE netsuite_id=$1"],
  ["closed", "UPDATE sales_orders SET status='H',status_text='Sales Order : Closed' WHERE netsuite_id=$1"]
]) {
  test(`selected S2 ${name} still blocks without changing completed S1`, () => scenario(async () => {
    const fixture = await seedUnfinishedSplit(); await query(sql, [-fixture.id]);
    const before = await fixture.history();
    await assert.rejects(resplitUnfinishedSalesOrder(request(fixture)), error => error.status === 409 && error.code !== undefined);
    assert.deepEqual(await fixture.history(), before);
    assert.equal((await query("SELECT active FROM dispatch_global_order_splits WHERE split_ref=$1", [fixture.source.id])).rows[0].active, true);
  }));
}

test("stale quantities and invalid allocations cannot retire S2", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit(), input = request(fixture);
  await query("UPDATE dispatch_global_order_splits SET full_order=jsonb_set(full_order,'{items,0,quantity}','105') WHERE split_ref=$1", [fixture.source.id]);
  await assert.rejects(resplitUnfinishedSalesOrder(input), { code: "DISPATCH_SPLIT_STALE" });
  assert.equal((await query("SELECT active FROM dispatch_global_order_splits WHERE split_ref=$1", [fixture.source.id])).rows[0].active, true);
}));

test("a materialization failure rolls back S2 retirement and every new child", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit();
  await query("CREATE FUNCTION pg_temp.reject_resplit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tranid LIKE '%-S4' THEN RAISE EXCEPTION 'forced resplit materialization failure'; END IF; RETURN NEW; END $$");
  await query("CREATE TRIGGER reject_resplit BEFORE INSERT ON sales_orders FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_resplit()");
  await assert.rejects(resplitUnfinishedSalesOrder(request(fixture)), /forced resplit materialization failure/u);
  assert.equal((await query("SELECT active FROM dispatch_global_order_splits WHERE split_ref=$1", [fixture.source.id])).rows[0].active, true);
  assert.equal((await query("SELECT count(*)::int AS n FROM dispatch_global_order_splits WHERE parent_order_ref=$1", [fixture.parent])).rows[0].n, 2);
  assert.equal((await query("SELECT SUM(quantity) AS qty FROM sales_order_lines WHERE sales_order_id=$1", [-fixture.id])).rows[0].qty, "109");
}));

test("property: arbitrary remaining splits preserve completed grouped history and all source quantities", () => scenario(async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 200 }), { minLength: 2, maxLength: 5 }), async values => {
    await scenario(async () => {
      const fixture = await seedUnfinishedSplit(), before = await fixture.history();
      const quantities = values.map(value => value * 106 / values.reduce((sum, count) => sum + count, 0));
      const rounded = quantities.map(value => Math.floor(value * 1000000) / 1000000);
      rounded[rounded.length - 1] = 106 - rounded.slice(0, -1).reduce((sum, value) => sum + value, 0);
      const input = request(fixture); input.parts = rounded.map((value, index) => ({ items: [
        { ...fixture.source.items[0], quantity: value }, ...(index === 0 ? [{ ...fixture.source.items[1], quantity: 3 }] : [])] }));
      const result = await resplitUnfinishedSalesOrder(input);
      assert.equal(result.orders.length, values.length);
      assert.deepEqual(result.orders.map(order => order.id), values.map((_value, index) => `${fixture.parent}-S${3 + index}`));
      assert.ok(Math.abs(result.orders.flatMap(order => order.items).filter(item => item.lineId === 1).reduce((sum, item) => sum + item.quantity, 0) - 106) < 0.000001);
      assert.deepEqual(await fixture.history(), before);
    });
  }), { seed: 20261012, numRuns: 12 });
}));

test("resplit rechecks source packing after waiting for the shared operator lock", async () => {
  const fixture = await seedUnfinishedSplit({ date: "2097-10-13" });
  const client = await pool.connect(); let pending;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`operator-delivery-load:${-fixture.id}`]);
    pending = resplitUnfinishedSalesOrder(request(fixture));
    const rejection = assert.rejects(pending, /packed/iu);
    await client.query("SELECT pg_sleep(0.1)");
    await client.query("UPDATE sales_order_lines SET packed_sales_qty=1 WHERE sales_order_id=$1", [-fixture.id]);
    await client.query("COMMIT"); await rejection;
    assert.equal((await query("SELECT active FROM dispatch_global_order_splits WHERE split_ref=$1", [fixture.source.id])).rows[0].active, true);
  } finally { await client.query("ROLLBACK"); client.release(); await pending?.catch(() => undefined); }
});

test("resplit rechecks selected Driver completion after waiting for the fleet lock", async () => {
  const fixture = await seedUnfinishedSplit({ date: "2097-10-14" });
  const client = await pool.connect(); let pending;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    pending = resplitUnfinishedSalesOrder(request(fixture));
    const rejection = assert.rejects(pending, /Driver|completed/iu);
    await client.query("SELECT pg_sleep(0.1)");
    await client.query(`INSERT INTO driver_job_records(job_id,driver_login,stop_type,order_refs,status,started_at,completed_at)
      VALUES($1,'race','dropoff',$2::jsonb,'complete',now(),now())`, [`race-${fixture.source.id}`, JSON.stringify([fixture.source.id])]);
    await client.query("COMMIT"); await rejection;
  } finally { await client.query("ROLLBACK"); client.release(); await pending?.catch(() => undefined); }
});


test("native S2 quantity changes cannot be hidden by a stale global definition", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit();
  await query("UPDATE sales_order_lines SET quantity=105 WHERE sales_order_id=$1 AND line_id=1", [-fixture.id]);
  await assert.rejects(resplitUnfinishedSalesOrder(request(fixture)), { code: "DISPATCH_SPLIT_STALE" });
  assert.equal((await query("SELECT active FROM dispatch_global_order_splits WHERE split_ref=$1", [fixture.source.id])).rows[0].active, true);
}));

test("malformed plan identity returns a specific conflict before any write", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit(), input = request(fixture); input.planId = "not-a-plan";
  await assert.rejects(resplitUnfinishedSalesOrder(input), { code: "DISPATCH_SPLIT_PLAN_MISMATCH" });
}));


test("the selected S2's PO allocation must be resolved before replacing it", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit(); await seedResplitPoLink(fixture);
  await assert.rejects(resplitUnfinishedSalesOrder(request(fixture)), { code: "DISPATCH_SPLIT_RESERVED" });
  assert.equal((await query("SELECT active FROM dispatch_global_order_splits WHERE split_ref=$1", [fixture.source.id])).rows[0].active, true);
}));

test("a completed S1 PO link stays intact and never blocks replacing S2", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit(); await seedResplitPoLink(fixture, fixture.first.id);
  const links = async () => (await query("SELECT to_jsonb(a) AS value FROM dispatch_so_po_allocations a WHERE dispatch_target_ref=$1", [fixture.first.id])).rows;
  const before = await links();
  await resplitUnfinishedSalesOrder(request(fixture));
  assert.deepEqual(await links(), before);
}));

test("unknown source cannot retire any native or global split", () => scenario(async () => {
  const fixture = await seedUnfinishedSplit(), input = request(fixture); input.orderRef = fixture.parent + '-S99';
  await assert.rejects(resplitUnfinishedSalesOrder(input), { code: "DISPATCH_SPLIT_NOT_FOUND" });
}));
