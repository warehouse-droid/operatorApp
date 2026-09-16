import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pool, query, withTransaction, closeDb } from "../src/db.js";
import { getDeliveryOrder, getDeliveryOrdersBatch, listDeliveryOrders } from "../src/delivery-repository.js";
import { deliveryPackingRemainder } from "../src/delivery-packing-progress.js";

const directory = "test-artifacts/group-underpack-20260915";
assert.equal(process.env.MBT_TEST_ISOLATED, "1");
assert(new URL(process.env.DATABASE_URL).pathname.startsWith("/mbt_test"));
pool.options.options = "-c jit=off -c statement_timeout=60000";
const raw = readFileSync(`${directory}/replay-input.json`), input = JSON.parse(raw), oracle = JSON.parse(readFileSync(`${directory}/replay-oracle.json`, "utf8"));
assert.equal(createHash("sha256").update(raw).digest("hex"), oracle.inputSha256);
assert(input.orders.length >= 1000);
const oracleById = new Map(oracle.orders.map(row => [String(row.id), row]));

async function insert(table, fields, rows) {
  if (!rows.length) {return;}
  assert(fields.every(field => /^[a-z_]+$/.test(field)));
  const columns = fields.join(",");
  await query(`INSERT INTO ${table}(${columns}) SELECT ${columns} FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`, [JSON.stringify(rows)]);
}
async function stateHash() {
  return (await query(`SELECT md5(string_agg(row::text,',' ORDER BY id)) AS hash FROM
    (SELECT id,to_jsonb(l) AS row FROM sales_order_lines l) snapshot`)).rows[0].hash;
}
const positive = value => Math.abs(Number(value) || 0);
try {
  const report = await withTransaction(async () => {
    for (let index = 0; index < input.orders.length; index += 100) {
      const chunk = input.orders.slice(index, index + 100);
      await insert("sales_orders", input.headerFields, chunk);
      await insert("sales_order_lines", input.lineFields, chunk.flatMap(order => order.lines));
    }
    const before = await stateHash(), details = [];
    let lineChecks = 0;
    for (const [index, order] of input.orders.entries()) {
      const expected = oracleById.get(String(order.netsuite_id));
      const detail = await getDeliveryOrder(order.netsuite_id);
      assert(detail, order.tranid);
      assert.equal(detail.underpack_count, expected.afterUnderpack, `${order.tranid} SQL detail`);
      for (const line of order.lines) {
        const wanted = expected.lines.find(row => String(row.lineId) === String(line.id));
        const remaining = deliveryPackingRemainder(Number(wanted.required), Number(wanted.loaded), Number(wanted.packed),
          [line.to_plt, line.to_lyr, line.to_sec, line.to_pcs].map(positive));
        assert.equal(remaining, Number(wanted.remaining), `${order.tranid} line ${line.id}`);
        lineChecks += 1;
      }
      details.push({ ref: order.tranid, id: order.netsuite_id, before: expected.beforeUnderpack, after: detail.underpack_count });
      if ((index + 1) % 200 === 0) {console.log(JSON.stringify({ checkedOrders: index + 1, lineChecks }));}
    }
    const listChecks = {};
    for (const status of ["active", "packed"]) {
      const rows = await listDeliveryOrders({ status });
      for (const row of rows) {
        const expected = oracleById.get(String(row.netsuite_id));
        if (expected) {assert.equal(row.underpack_count, expected.afterUnderpack, `${row.tranid} ${status} list`);}
      }
      listChecks[status] = rows.filter(row => oracleById.has(String(row.netsuite_id))).length;
    }
    const plan = (await query("INSERT INTO dispatch_plans(plan_date) VALUES(current_date) RETURNING id")).rows[0];
    await query(`INSERT INTO dispatch_delivery_groups(group_ref,plan_id,plan_date,order_type)
      SELECT 'GRP-REPLAY-'||netsuite_id,$1,current_date,'sales_order' FROM sales_orders`, [plan.id]);
    await query(`INSERT INTO dispatch_delivery_group_members(group_ref,member_order_ref,position)
      SELECT 'GRP-REPLAY-'||netsuite_id,tranid,0 FROM sales_orders`);
    const groups = await getDeliveryOrdersBatch(input.orders.map(order => `GRP-REPLAY-${order.netsuite_id}`));
    assert.equal(groups.length, input.orders.length);
    for (const group of groups) {
      const expected = oracleById.get(String(group.child_order_ids[0]));
      assert.equal(group.underpack_count, expected.groupUnderpack, `${group.tranid} group`);
    }
    assert.equal(await stateHash(), before, "Packing reads must not rewrite any quantities");
    return { completedAt: new Date().toISOString(), orders: details.length, lines: lineChecks, groups: groups.length,
      listChecks, inputSha256: oracle.inputSha256, unchangedStoredQuantities: true,
      roundingLines: oracle.orders.flatMap(order => order.lines).filter(line => line.roundingCorrection).length,
      correctedOrderCounts: details.filter(row => row.before !== row.after), remainingUnderpackedOrders: details.filter(row => row.after > 0).length,
      failures: 0, details };
  }, { rollback: true });
  writeFileSync(`${directory}/replay-result.json`, JSON.stringify(report, null, 2) + "\n");
  const { details: _details, ...summary } = report;
  console.log(JSON.stringify(summary));
} finally { await closeDb(); }
