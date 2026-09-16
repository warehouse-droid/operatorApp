import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pool, query, withTransaction, closeDb } from "../src/db.js";
import { getDeliveryOrder } from "../src/delivery-repository.js";
import { getReceivingOrder } from "../src/receiving-repository.js";
import { loadDispatchOrdersForResponse } from "../src/server.js";
pool.options.options = "-c default_transaction_read_only=on -c jit=off -c statement_timeout=60000";
const directory = process.argv[2], today = JSON.parse(readFileSync(`${directory}/today-read.json`, "utf8"));
const refs = [...new Set([...today.loads.flatMap(load => load.orders), ...today.routes.flatMap(route => route.jobs.flatMap(job => job.orderRefs || []))]
  .map(ref => String(ref).toLowerCase()))];
try {
  const orders = await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const rows = (await query("SELECT netsuite_id,tranid FROM transfer_orders WHERE lower(tranid)=ANY($1::text[]) ORDER BY tranid", [refs])).rows;
    const result = [];
    for (const row of rows) {
      const delivery = await getDeliveryOrder(row.netsuite_id, { includeNetSuiteClosed: true });
      const receiving = await getReceivingOrder(row.netsuite_id, { includeNetSuiteClosed: true });
      const search = await loadDispatchOrdersForResponse({ type: "TO", search: row.tranid, exactOrderRefs: [row.tranid], includeCompletedScmSearch: true });
      const dispatch = search.find(order => order.id === row.tranid);
      assert(delivery && dispatch, `Today's TO is unavailable: ${row.tranid}`);
      assert.equal(delivery.warning_count, 0, row.tranid);
      result.push({ ref: row.tranid, operator: delivery.operator_status, receiving: receiving?.receipt_status || "outside Receiving worklist",
        warnings: delivery.warning_count, dispatchCompleted: dispatch.dispatchCompletionStatus,
        planningRestricted: dispatch.dispatchPlanningRestricted, restrictionReason: dispatch.dispatchPlanningRestrictionReason });
    }
    return result;
  }, { rollback: true });
  const report = { verifiedAt: new Date().toISOString(), date: today.date, orders, blockers: [] };
  writeFileSync(`${directory}/today-transfers.json`, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report));
} finally { await closeDb(); }
