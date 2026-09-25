import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { performance } from "node:perf_hooks";
import fc from "fast-check";
import { pool, query, withTransaction, closeDb } from "../../../src/db.js";
import { getDeliveryOrder, recordDeliveryLoad } from "../../../src/delivery-repository.js";
import { packingOrder, packingGroup } from "../../support/group-underpack-fixture.mjs";
import { describeIsolatedTestDatabase } from "../../support/test-database-isolation.mjs";

describeIsolatedTestDatabase(process.env.DATABASE_URL);
after(async () => {
  try {
    await query("DELETE FROM sales_order_lines WHERE sales_order_id BETWEEN 997000001 AND 997013000");
    await query("DELETE FROM sales_orders WHERE netsuite_id BETWEEN 997000001 AND 997013000");
    await query("DELETE FROM transfer_order_lines WHERE transfer_order_id BETWEEN 996000001 AND 996002000");
    await query("DELETE FROM transfer_orders WHERE netsuite_id BETWEEN 996000001 AND 996002000");
  } finally {
    await closeDb();
  }
});
const rollback = run => withTransaction(run, { rollback: true });
let headerQuery;
pool.on("connect", client => {
  const original = client.query.bind(client);
  client.query = (...args) => {
    if (/^\s*WITH delivery_order_source/u.test(String(args[0]))) {headerQuery = args;}
    return original(...args);
  };
});

before(async () => {
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,netsuite_active)
    SELECT 997000000+n,'PERF-SO-'||n,true FROM generate_series(1,13000) n`);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_description,item_type,
    quantity,unit,netsuite_active,packed_sales_qty,sync_exception)
    SELECT 997000001+(n%13000),n,1784,'Unrelated cargo',repeat('Unrelated cargo ',12),'InvtPart',20,'PC',true,5,'unrelated'
    FROM generate_series(1,30000) n`);
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,from_location_id,netsuite_active)
    SELECT 996000000+n,'PERF-TO-'||n,1,true FROM generate_series(1,2000) n`);
  await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_id,line_stage,item_id,item_name,item_description,
    item_type,quantity,unit,netsuite_active,packed_sales_qty,sync_exception)
    SELECT 996000001+(n%2000),n,CASE WHEN n%2=0 THEN 'outbound' ELSE 'inbound' END,1784,'Unrelated transfer',
    repeat('Unrelated cargo ',12),'InvtPart',20,'PC',true,5,'unrelated' FROM generate_series(1,6800) n`);
  for (const table of ["sales_orders", "sales_order_lines", "transfer_orders", "transfer_order_lines"]) {
    await query(`ANALYZE ${table}`);
  }
});

function plans(node) {
  return [node, ...(node.Plans || []).flatMap(plans)];
}

for (const transfer of [false, true]) {
  test(`${transfer ? "TO" : "SO"} progress query reads only the requested outbound lines`, () => rollback(async () => {
    const order = await packingOrder({ transfer, salesOnly: true, quantity: 10, packed: 4 });
    await query(`UPDATE ${order.lineTable} SET sync_exception='target warning' WHERE id=$1`, [order.lineId]);
    if (transfer) {
      await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_id,line_stage,item_id,item_type,quantity,
        packed_sales_qty,netsuite_active,sync_exception) VALUES($1,2,'inbound',1784,'InvtPart',20,2,true,'inbound warning')`, [order.id]);
    }
    const detail = await getDeliveryOrder(order.id);
    assert.equal(detail.warning_count, 1);
    assert.equal(detail.underpack_count, 1);
    assert.deepEqual(detail.lines.map(line => String(line.id)), [String(order.lineId)]);
    const [sql, parameters] = headerQuery;
    const result = await query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, parameters);
    const plan = result.rows[0]["QUERY PLAN"][0];
    const materialized = plans(plan.Plan).find(node => node["Subplan Name"] === "CTE delivery_line_source");
    assert.ok(materialized, "The real PostgreSQL plan must expose the progress CTE");
    assert.equal(materialized["Actual Rows"], 1, "Progress must not scan unrelated orders or inbound lines");
    assert.equal(plan.Plan["Temp Written Blocks"], 0, "One order's progress must not spill to disk");
  }));
}

test("a two-child local group load stays below one second at the live order population", async t => {
  const timings = [];
  for (let run = 0; run < 3; run += 1) {
    await rollback(async () => {
      const children = [await packingOrder(), await packingOrder({ salesOnly: true, quantity: 28, packed: 28 })];
      const groupId = await packingGroup(children);
      const photos = ["r2://load-performance/proof-1.jpg", "r2://load-performance/proof-2.jpg"];
      const start = performance.now();
      const result = await recordDeliveryLoad(groupId, null, { photoDataUrls: photos });
      const elapsed = performance.now() - start;
      timings.push(Number(elapsed.toFixed(2)));
      assert.equal(result.groupLoad, true);
      assert.equal(result.sourceLoadRecords.length, 2);
      assert.equal(result.localYardOrderStatus, "Loaded");
      assert.equal(result.remainingLines, 0);
      for (const [index, child] of children.entries()) {
        const line = (await query("SELECT loaded_qty,packed_sales_qty,packed_layer_qty FROM sales_order_lines WHERE id=$1", [child.lineId])).rows[0];
        assert.equal(Number(line.loaded_qty), index ? 28 : 93.26);
        assert.equal(Number(line.packed_sales_qty), 0);
        assert.equal(Number(line.packed_layer_qty), 0);
      }
      const records = (await query("SELECT photo_data_urls FROM operator_load_records WHERE id=ANY($1::bigint[])",
        [result.sourceLoadRecords.map(row => row.id)])).rows;
      assert.equal(records.length, 2);
      assert.ok(records.every(record => JSON.stringify(record.photo_data_urls) === JSON.stringify(photos)));
      t.diagnostic(`group load ${run + 1}: ${elapsed.toFixed(2)} ms`);
      assert.ok(elapsed < 1000, `Local grouped load took ${elapsed.toFixed(2)} ms; budget is under 1000 ms`);
    });
  }
  t.diagnostic(`complete load timings: ${JSON.stringify(timings)}`);
});

test("property: requested SO/TO progress counts preserve partial, full and empty packing", () => rollback(async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.integer({ min: 0, max: 10 }), fc.boolean(),
    async (transfer, packed, warning) => {
      const order = await packingOrder({ transfer, salesOnly: true, quantity: 10, packed });
      await query(`UPDATE ${order.lineTable} SET sync_exception=$2 WHERE id=$1`, [order.lineId, warning ? "target warning" : null]);
      const detail = await getDeliveryOrder(order.id);
      assert.equal(detail.warning_count, warning && packed > 0 ? 1 : 0);
      assert.equal(detail.underpack_count, packed > 0 && packed < 10 ? 1 : 0);
      assert.deepEqual(detail.lines.map(line => String(line.id)), [String(order.lineId)]);
    }), { seed: 20260917, numRuns: 25, examples: [[false, 0, true], [true, 10, true], [false, 4, false], [true, 4, true]] });
}));
