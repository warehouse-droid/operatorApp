// Operational application of the user's requested decision, with evidence
// checks inside the same fleet lock used by Dispatch and driver completion.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { query, withTransaction, closeDb } from "./src/db.js";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
try {
  const result = await withTransaction(async () => {
    await query("SET LOCAL lock_timeout='5s'");
    await query("SET LOCAL statement_timeout='30s'");
    await query("SELECT pg_advisory_xact_lock(hashtext('dispatch_fleet_planning_mutation'))");
    const previous = (await query("SELECT orders,trucks,summary FROM dispatch_plan_snapshots WHERE plan_id=349")).rows[0];
    const jobs = (await query("SELECT * FROM driver_job_records WHERE plan_id=349 ORDER BY id FOR SHARE")).rows;
    const { getDispatchSourceReviewPayload } = await import("./src/dispatch-executed-order-review-repository.js");
    const response = await getDispatchSourceReviewPayload(349, { baseRevision: 110 });
    const review = response.reviews.find(row => row.orderRef === "SOA09704");
    assert.ok(review, "The requested source update must remain visible to dispatch");
    assert.equal(review.decision, "accept_netsuite_change");
    assert.equal(review.sourceReceiptVerified, true);
    const next = (await query("SELECT orders,trucks,summary FROM dispatch_plan_snapshots WHERE plan_id=349")).rows[0];
    assert.deepEqual(next.trucks, previous.trucks);
    assert.deepEqual(next.summary, previous.summary);
    assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE plan_id=349 ORDER BY id")).rows, jobs);
    const group = next.orders.find(order => order.id === "GOA-9704-9731");
    const child = group.childOrderDetails.find(order => order.id === "SOA09704");
    assert.equal(child.items.some(item => Number(item.lineId) === 5074433), false);
    assert.equal(child.items.find(item => Number(item.lineId) === 5074432).quantity, 110);
    assert.equal(group.salesQty, 1246);
    return { accepted: true, planId: "349", planDate: "2026-10-07", orderRef: "SOA09704", groupRef: group.id,
      sourceModifiedAt: review.sourceModifiedAt, sourceReceivedAt: review.sourceReceivedAt,
      sourceAppliedAt: review.sourceAppliedAt, dispatchAcknowledgementPending: !review.acknowledged,
      groupQuantity: group.salesQty, orderQuantity: child.salesQty, consolidatedQuantity: 110,
      removedLineAbsent: true, driverRecords: jobs.length, driverEvidenceHash: hash(jobs),
      routeHash: hash(next.trucks), driverEvidenceUnchanged: true, routeUnchanged: true,
      revision: (await query("SELECT revision FROM dispatch_plans WHERE id=349")).rows[0].revision };
  });
  console.log(JSON.stringify(result));
} finally {await closeDb();}
