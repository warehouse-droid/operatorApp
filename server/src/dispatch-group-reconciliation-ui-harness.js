import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/dispatch.js", import.meta.url), "utf8");
const start = source.indexOf("function isReviewOnlyOrder");
const end = source.indexOf("function orderTypeLabel", start);
assert.ok(start >= 0 && end > start, "Dispatch reconciliation presentation helpers were not found.");
const helpers = Function(
  `"use strict"; ${source.slice(start, end)}; return { isReviewOnlyOrder, reviewOnlyText, isScmReconciliationBlocked, scmReconciliationBlockText };`
)();

const completedGroup = {
  id: "GOA-100-200",
  type: "SO",
  childOrders: ["SOA00100", "SOA00200"],
  fulfillmentStatus: "fulfilled",
  localYardOrderStatus: "Open",
  reconciliationApplicationStatus: "Completed"
};
assert.equal(helpers.isReviewOnlyOrder(completedGroup), true);
assert.equal(helpers.reviewOnlyText(completedGroup), "Completed",
  "A completed grouped SO must not render its inherited first-child label as Open.");

const reviewGroup = {
  ...completedGroup,
  fulfillmentStatus: "partial_fulfilled",
  reconciliationApplicationStatus: "Reconcile Review",
  reconciliationStatus: "review",
  reconciliationBlocked: true,
  reconciliationReason: "One child requires review."
};
assert.equal(helpers.isScmReconciliationBlocked(reviewGroup), true,
  "A grouped SO in reconciliation review must expose the same dispatch warning gate as grouped PO/TO work.");
assert.equal(helpers.scmReconciliationBlockText(reviewGroup), "One child requires review.");
assert.equal(helpers.isScmReconciliationBlocked({
  type: "SO",
  childOrders: [],
  reconciliationBlocked: true
}), false, "The grouped-SO repair must not broaden the PO/TO gate to ordinary Sales Orders.");

console.log("Dispatch grouped-order reconciliation UI harness passed.");
