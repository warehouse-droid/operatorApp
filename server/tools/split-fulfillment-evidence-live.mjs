// Run through docker exec -i in the live application, never in a test container.
import assert from "node:assert/strict";
import { pool, query } from "./src/db.js";
import { getSalesOrderAutoFulfillmentCandidate } from "./src/sales-order-auto-fulfillment-repository.js";
import { fetchSalesOrderFulfillmentStateFromNetSuite } from "./src/netsuite.js";
import { salesOrderAutoFulfillmentNetSuiteAdapter } from "./src/sales-order-auto-fulfillment-netsuite-adapter.js";
import { withOperatorNetSuitePriority } from "./src/operator-netsuite-request-pool.js";

pool.options.options = "-c jit=off -c default_transaction_read_only=on -c statement_timeout=15000";
const id = "d384fb57-93ed-4f55-ab84-ecb0c63b0765";
try {
  const candidate = await getSalesOrderAutoFulfillmentCandidate(id);
  assert.equal(candidate.dispatchOrderRef, "SOA09948-S1");
  assert.equal(candidate.sourceSalesOrderId, 1046936);
  const live = await withOperatorNetSuitePriority(() =>
    fetchSalesOrderFulfillmentStateFromNetSuite(1046936, { includeAllSourceLines: true }));
  let fulfillment = null;
  if (candidate.netSuiteTransactionId) {
    const record = await withOperatorNetSuitePriority(() =>
      salesOrderAutoFulfillmentNetSuiteAdapter.fetchById(candidate, candidate.netSuiteTransactionId));
    const verified = salesOrderAutoFulfillmentNetSuiteAdapter.verify(candidate, record, candidate.payload);
    fulfillment = { id: verified.id, reference: verified.transactionRef, verified: true };
    const selected = candidate.payload.item.items.filter(line => line.itemReceive)
      .map(line => ({ orderLine: Number(line.orderLine), quantity: Number(line.quantity) }))
      .sort((a, b) => a.orderLine - b.orderLine);
    assert.deepEqual(selected, [{ orderLine: 1, quantity: 947.73 }, { orderLine: 4, quantity: 11 }]);
  }
  const attempts = (await query(`SELECT attempt_number,outcome,error,started_at,finished_at
    FROM dispatch_sales_order_if_attempts WHERE candidate_id=$1 ORDER BY attempt_number`, [id])).rows;
  const activity = (await query(`SELECT action,created_at FROM dispatch_sales_order_if_audit_events
    WHERE candidate_id=$1 ORDER BY id DESC LIMIT 8`, [id])).rows;
  console.log(JSON.stringify({
    readOnly: true, checkedAt: new Date().toISOString(), candidate: {
      id, ref: candidate.dispatchOrderRef, sourceRef: candidate.sourceSalesOrderRef,
      status: candidate.status, attemptCount: candidate.attemptCount, error: candidate.lastError,
      completedAt: candidate.completedAt, externalId: candidate.externalId,
      lineSnapshot: candidate.lineSnapshot, fulfillment
    },
    live: { sourceId: live.id, sourceRef: live.tranid, status: live.status, statusText: live.statusText,
      lines: (live.lines || []).map(line => ({ orderLine: line.orderLine, itemId: line.itemId,
        quantity: line.quantity, remainingQuantity: line.remainingQuantity,
        fulfilledQuantity: line.fulfilledQuantity, location: line.location })) },
    attempts, activity
  }));
} finally {
  await pool.end();
}
