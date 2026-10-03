import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildExecutedOrderReviews, reviewedExecutionComparison } from "../../../src/dispatch-executed-order-review.js";
import { evaluateExecutedPrefixPolicy } from "../../../src/dispatch-planner-performance.js";
import { preserveDispatchPlanAddresses } from "../../../src/dispatch-address-guard.js";
import { overlayLockedLoadDerivedSchedule } from "../../../src/dispatch-load-assignment.js";

test("the recorded GOA-8930-8931 / TOB01111 incident saves without requiring confirmation", async () => {
  const input = JSON.parse(await readFile(new URL("../fixtures/executed-order-incidents.json", import.meta.url), "utf8"));
  assert.equal(evaluateExecutedPrefixPolicy({ ...input, nextPlan: input.failedDraft }).allowed, false);
  const guarded = preserveDispatchPlanAddresses(input.previousPlan, input.failedDraft);
  assert.equal(guarded.orders.find(order => order.id === "GOA-8930-8931").address, "15 Snowy Meadow Ave, Richmond Hill, ON L4E 3V3");
  assert.ok(guarded.summary.addressWarnings.some(warning => warning.orderRef === "SOA08930"));
  const reviews = buildExecutedOrderReviews(input);
  assert.deepEqual(reviews.map(review => review.orderRef), ["TOB01111"]);
  assert.equal(reviews[0].acknowledged, false);
  const locks = new Set(input.activity.map(record => record.load_id));
  const nextPlan = overlayLockedLoadDerivedSchedule(input.previousPlan, guarded, locks, { activityStatuses: input.activity });
  const comparison = reviewedExecutionComparison({ ...input, nextPlan, reviews });
  assert.equal(evaluateExecutedPrefixPolicy({ previousPlan: comparison, nextPlan, activity: input.activity }).allowed, true);
  const stop = nextPlan.trucks.flatMap(truck => truck.loads).find(load => load.id.startsWith("T4-")).stops.at(-1);
  assert.deepEqual(stop.timing, { arrival: 784, depart: 820 });
});
