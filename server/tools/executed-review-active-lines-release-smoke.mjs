// Run through `docker exec -i ... node --input-type=module` in the deployed app.
import assert from "node:assert/strict";
import { query, withTransaction, closeDb } from "./src/db.js";
import { persistedDispatchPlan } from "./src/dispatch-plan-fence.js";
import { listDispatchOrders } from "./src/dispatch-repository.js";
import { buildPlannedOrderReviews, executedSourceDigest } from "./src/dispatch-executed-order-review.js";

try {
  await withTransaction(async () => {
    await query("SET TRANSACTION READ ONLY");
    await query("SET LOCAL statement_timeout='20s'");
    const row = (await query(`SELECT p.id,p.plan_date,p.status,p.revision,p.note,s.orders,s.trucks,s.summary,s.saved_at
      FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=340`)).rows[0];
    const previousPlan = persistedDispatchPlan(row);
    const activity = (await query("SELECT * FROM driver_job_records WHERE plan_id=340 AND status IN ('in_progress','complete')")).rows;
    const sourceOrders = await listDispatchOrders({ exactOrderRefs: ["SOA09413"], includeHiddenScm: true,
      includeFulfilledSalesDeliveries: true, includeInactiveSalesOrderLines: false,
      includeAllDiscoverableScmPurchaseOrders: true, unboundedPerType: true });
    const current = sourceOrders.find(order => order.id === "SOA09413");
    assert.equal(current.items.length, 3);
    assert.equal(current.salesQty, 1426.64);
    assert.equal(current.weight, 50321.73);
    const reviews = buildPlannedOrderReviews({ previousPlan, activity, sourceOrders });
    assert.deepEqual(reviews, []);
    const ledger = (await query(`SELECT source_digest,acknowledged_at FROM dispatch_executed_order_reviews
      WHERE plan_id=340 AND order_ref='SOA09413' ORDER BY observed_at`)).rows;
    assert.equal(ledger.filter(entry => entry.source_digest === executedSourceDigest(current)).length, 0);
    const hypotheticalPlan = { orders: [current], trucks: [{ id: "release-check", loads: [{ id: "release-check-load",
      stops: [{ id: "release-check-stop", type: "drop", orderId: current.id }] }] }] };
    const hypotheticalSource = structuredClone(current);
    hypotheticalSource.items[0].quantity = Number(hypotheticalSource.items[0].quantity) + 1;
    const requested = buildPlannedOrderReviews({ previousPlan: hypotheticalPlan, sourceOrders: [hypotheticalSource] });
    assert.equal(requested.length, 1);
    assert.equal(requested[0].replanRequested, true);
    console.log(JSON.stringify({ readOnly: true, planId: 340, revision: previousPlan.revision,
      orderRef: current.id, currentLines: current.items.length, salesQty: current.salesQty, weight: current.weight,
      falseNoticeCount: reviews.length, historicalLedgerRetained: ledger.length,
      hypotheticalPlannedChangeRequestsReplan: requested[0].replanRequested }));
  }, { rollback: true });
} finally {
  await closeDb();
}
