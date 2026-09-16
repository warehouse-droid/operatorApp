import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { pool, query, withTransaction, closeDb } from "../src/db.js";
import { getDeliveryOrder } from "../src/delivery-repository.js";
import { createOperatorYardGuard } from "../src/operator-yard-authorization.js";
import { assertOperatorNetSuitePostingOrderMutable } from "../src/operator-netsuite-posting-controller.js";
pool.options.options = "-c default_transaction_read_only=on -c jit=off -c statement_timeout=45000";
const mode = process.argv[2], directory = "test-artifacts/vrma-confirm-encoding-20260915";
assert(["before", "after"].includes(mode));
const ref = "RP-UNI-AYR-3445-0914-1", key = `VRMA:${ref}`;
async function snapshot() {
  const order = (await query("SELECT * FROM scm_vrma_orders WHERE vrma_ref=$1", [ref])).rows[0];
  assert(order, "Reported VRMA is missing");
  const lines = (await query("SELECT * FROM scm_vrma_order_lines WHERE vrma_order_id=$1 ORDER BY id", [order.id])).rows;
  return { order, lines };
}
async function check(grants, pathname) {
  await query("SAVEPOINT vrma_guard_read");
  try {
    const error = await new Promise((resolve, reject) => {
      createOperatorYardGuard()({ originalUrl: pathname, query: {}, body: {},
        operator: { id: "read-only-verification", role: "operator", roles: ["operator"], operatorYardLocationIds: grants } }, {}, resolve).catch(reject);
    });
    await query("ROLLBACK TO SAVEPOINT vrma_guard_read");
    await query("RELEASE SAVEPOINT vrma_guard_read");
    return error ? { status: error.status || 500, code: error.code, error: error.message } : { status: 200 };
  } catch (error) {
    await query("ROLLBACK TO SAVEPOINT vrma_guard_read");
    throw error;
  }
}
try {
  const report = await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const beforeState = await snapshot(), detail = await getDeliveryOrder(key);
    assert(detail, "Reported VRMA is not available for Operator preparation");
    const encoded = `/api/delivery/orders/${encodeURIComponent(key)}/lines/confirm-page`;
    const assigned = await check([Number(detail.outbound_location_id)], encoded);
    if (mode === "before") {assert.equal(assigned.code, "22P02");}
    else {assert.equal(assigned.status, 200, JSON.stringify(assigned));}
    const foreign = mode === "after" ? await check([Number(detail.outbound_location_id) === 1 ? 28 : 1], encoded) : null;
    if (foreign) {assert.equal(foreign.status, 403);}
    await assertOperatorNetSuitePostingOrderMutable({ functionKey: "delivery_prep", orderId: key, orderType: "vrma_order" });
    assert.deepEqual(await snapshot(), beforeState);
    return { mode, checkedAt: new Date().toISOString(), ref, encoded, assigned, foreign, dataUnchanged: true,
      operatorStatus: detail.operator_status, locationId: detail.outbound_location_id, lines: detail.lines.length, activePostingClaim: false,
      beforeState };
  }, { rollback: true });
  writeFileSync(`${directory}/live-${mode}.json`, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  const { beforeState: _state, ...summary } = report;
  console.log(JSON.stringify(summary));
} finally { await closeDb(); }
