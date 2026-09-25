import assert from "node:assert/strict";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { pool, query, withTransaction, closeDb } from "/app/src/db.js";
import { getDeliveryOrder } from "/app/src/delivery-repository.js";
import { assertNoCoSourcePacking } from "/app/src/co-source-packing-handoff.js";

pool.options.options = "-c jit=off -c default_transaction_read_only=on -c statement_timeout=10000";
let headerQuery;
pool.on("connect", client => {
  const original = client.query.bind(client);
  client.query = (...args) => {
    if (/^\s*WITH delivery_order_source/u.test(String(args[0]))) {headerQuery = args;}
    return original(...args);
  };
});
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const flatten = node => [node, ...(node.Plans || []).flatMap(flatten)];
try {
  const result = await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const timings = [], states = {};
    for (let run = 0; run < 3; run += 1) {
      for (const id of ["994321", "994340", "GOB-120487-120489"]) {
        const start = performance.now();
        const order = await getDeliveryOrder(id, { includeNetSuiteClosed: true });
        assert.ok(order);
        const readMs = performance.now() - start;
        const guardStart = performance.now();
        await assertNoCoSourcePacking(order);
        timings.push({ run, id, readMs, guardMs: performance.now() - guardStart });
        states[id] = hash(order);
      }
    }
    const [sql, parameters] = headerQuery;
    const explained = (await query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, parameters)).rows[0]["QUERY PLAN"][0];
    const materialized = flatten(explained.Plan).find(node => node["Subplan Name"] === "CTE delivery_line_source");
    return { checkedAt: new Date().toISOString(), states, timings,
      queryPlan: { materializedRows: materialized["Actual Rows"], executionMs: explained["Execution Time"],
        tempWrittenBlocks: explained.Plan["Temp Written Blocks"], tempReadBlocks: explained.Plan["Temp Read Blocks"] } };
  }, { rollback: true });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeDb();
}
