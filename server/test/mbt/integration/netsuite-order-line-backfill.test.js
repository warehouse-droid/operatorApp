import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { query, withTransaction, closeDb } from "../../../src/db.js";
import { planNetSuiteOrderLineBackfill, readOrderLineBackfillRows, applyOrderLineBackfill } from "../../../src/netsuite-order-line-backfill.js";

after(closeDb);
const cases = [
  ["SO", "sales_orders", "sales_order_lines", "sales_order_id"],
  ["PO", "purchase_orders", "purchase_order_lines", "purchase_order_id"],
  ["TO", "transfer_orders", "transfer_order_lines", "transfer_order_id"]
];

test("orderLine migration can run twice and rejects invalid mappings", async () => {
  await withTransaction(async () => {
    const migration = readFileSync("migrations/202_netsuite_order_line.sql", "utf8");
    await query(migration);
    await query(migration);
    for (const [kind, header, table, parent] of cases) {
      await query(`INSERT INTO ${header}(netsuite_id,tranid) VALUES(990920000,'ORDERLINE-MIGRATION')`);
      for (const value of [0, -1, "9007199254740992"]) {
        await assert.rejects(withTransaction(() => query(`INSERT INTO ${table}(${parent},line_id,netsuite_order_line${kind === "TO" ? ",line_stage" : ""}) VALUES(990920000,1,$1${kind === "TO" ? ",'outbound'" : ""})`, [value])),
          error => error.code === "23514");
      }
    }
  }, { rollback: true });
});

for (const [kind, header, table, parent] of cases) {
  test(`${kind} backfill changes mapping only, is idempotent, and rejects stale or mismatched writes`, async () => {
    await withTransaction(async () => {
      const orderId = 990920100;
      await query(`INSERT INTO ${header}(netsuite_id,tranid) VALUES($1,'ORDERLINE-BACKFILL')`, [orderId]);
      await query(`INSERT INTO ${table}(${parent},line_id,item_id,netsuite_active,quantity,piece_qty${kind === "TO" ? ",line_stage" : ""}) VALUES($1,654321,42,true,19,19${kind === "TO" ? ",'outbound'" : ""})`, [orderId]);
      const rows = await readOrderLineBackfillRows(kind, [orderId]);
      assert.equal(rows.length, 1);
      const read = async () => (await query(`SELECT to_jsonb(l)-'netsuite_order_line'-'netsuite_order_line_synced_at' AS data FROM ${table} l WHERE ${parent}=$1`, [orderId])).rows;
      const before = await read();
      const remote = [{ order_id: orderId, line_id: 654321, item_id: 42, netsuite_order_line: 17 }];
      const plan = planNetSuiteOrderLineBackfill(rows, remote);
      assert.equal(plan.updates.length, 1);
      const applied = await applyOrderLineBackfill(kind, plan.updates);
      assert.equal(applied.updated.length, 1);
      assert.equal(applied.conflicts.length, 0);
      assert.deepEqual(await read(), before);
      assert.equal(planNetSuiteOrderLineBackfill(await readOrderLineBackfillRows(kind, [orderId]), remote).updates.length, 0);
      assert.equal((await applyOrderLineBackfill(kind, plan.updates)).conflicts.length, 1, "replayed stale observation does not overwrite");
      const current = await readOrderLineBackfillRows(kind, [orderId]);
      const next = planNetSuiteOrderLineBackfill(current, [{ ...remote[0], netsuite_order_line: 23 }]);
      for (const changed of [{ order_id: orderId + 1 }, { line_id: 123 }, { item_id: 43 }, { expected_synced_at: "2000-01-01" },
        { expected_order_line_synced_at: "2000-01-01" }, { expected_order_line: 2 }]) {
        assert.equal((await applyOrderLineBackfill(kind, [{ ...next.updates[0], ...changed }])).conflicts.length, 1);
      }
      await query(`UPDATE ${table} SET netsuite_order_line=44,netsuite_order_line_synced_at=clock_timestamp() WHERE ${parent}=$1`, [orderId]);
      assert.equal((await applyOrderLineBackfill(kind, next.updates)).conflicts.length, 1, "new webhook observation wins");
      assert.deepEqual(await read(), before);
      await assert.rejects(applyOrderLineBackfill(kind, [{ ...next.updates[0], netsuite_order_line: 0 }]), /positive safe integer/);
      const activeObservation = planNetSuiteOrderLineBackfill(await readOrderLineBackfillRows(kind, [orderId]), remote);
      await query(`UPDATE ${table} SET netsuite_active=false WHERE ${parent}=$1`, [orderId]);
      assert.equal((await applyOrderLineBackfill(kind, activeObservation.updates)).conflicts.length, 1,
        "a concurrent line retirement wins over an older backfill observation");
      const inactive = await readOrderLineBackfillRows(kind, [orderId]);
      assert.equal(inactive.length, 1, "an incomplete source order still needs mappings on its inactive local lines");
      const retiredProgress = await read();
      const inactivePlan = planNetSuiteOrderLineBackfill(inactive, remote);
      assert.equal(inactivePlan.updates.length, 1);
      assert.equal((await applyOrderLineBackfill(kind, inactivePlan.updates)).updated.length, 1);
      assert.deepEqual(await read(), retiredProgress, "caching an authoritative mapping does not reactivate the line");
      assert.equal(planNetSuiteOrderLineBackfill(await readOrderLineBackfillRows(kind, [orderId]), remote).updates.length, 0);
    }, { rollback: true });
  });
}
