import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { cargoFunctions } from "../../support/sales-order-cargo-fixture.mjs";

function actions(order) {
  return cargoFunctions("../../public/dispatch.js", ["renderSelectedOrderActions", "isReviewOnlyOrder",
    "isDispatchPlanningRestricted", "dispatchPlanningRestrictionText"], {
    activeOrderType: "SO", selectedOrder: () => order, selectedOrders: () => [order],
    escapeHtml: String, isScmReconciliationBlocked: () => false, groupedOrderTransitCoId: () => "",
    supportsTransitCoForOrder: () => false, displayDateTime: () => "", isSalesOrderReattempt: () => false,
    canConsolidatePick: () => false
  }).renderSelectedOrderActions();
}

const base = { id: "SO-INDEPENDENT", type: "SO", dispatchCompletionStatus: "", dispatchPlanningRestricted: false };

test("Pending Billing with synced loaded quantities retains Dispatch Link PO", () => {
  const html = actions({ ...base, netsuiteStatusText: "Sales Order : Pending Billing", operatorStatus: "loaded",
    localYardOrderStatus: "Loaded", fulfillmentStatus: "fulfilled", dispatchFulfilledSalesPlanningEligible: true });
  assert.match(html, /data-action="open-po-link-modal"/u);
  assert.match(html, /data-action="open-to-link-modal"/u);
  assert.doesNotMatch(html, /Dispatch completed|Loaded\/shipped history/u);
});

test("property: Dispatch actions depend on Dispatch completion, independently of external execution labels", () => {
  fc.assert(fc.property(fc.constantFrom("Pending Fulfillment", "Pending Billing", "Billed", "Fulfilled"),
    fc.constantFrom("open", "preparing", "packed", "partial_loaded", "loaded", "shipped"), fc.boolean(),
    (label, operator, completed) => {
      const html = actions({ ...base, netsuiteStatusText: label, operatorStatus: operator,
        localYardOrderStatus: "Loaded", fulfillmentStatus: "fulfilled", dispatchCompletionStatus: completed ? "completed" : "" });
      assert.equal(html.includes('data-action="open-po-link-modal"'), !completed);
      assert.equal(html.includes('data-action="open-to-link-modal"'), !completed);
    }), { seed: 20261015, numRuns: 80 });
});

test("an authoritative Dispatch restriction hides actions even if a cached eligibility flag says true", () => {
  const html = actions({ ...base, dispatchFulfilledSalesPlanningEligible: true, dispatchPlanningRestricted: true,
    dispatchPlanningRestrictionReason: "Delivery is completed locally." });
  assert.doesNotMatch(html, /data-action="open-po-link-modal"/u);
  assert.match(html, /Delivery is completed locally/u);
});

test("review-only labels describe Dispatch delivery or the actual restriction", () => {
  const { reviewOnlyText } = cargoFunctions("../../public/dispatch.js", ["reviewOnlyText", "dispatchPlanningRestrictionText"]);
  assert.equal(reviewOnlyText({ ...base, operatorStatus: "loaded", dispatchCompletionStatus: "completed" }), "Delivery completed");
  assert.equal(reviewOnlyText({ ...base, dispatchPlanningRestricted: true,
    dispatchPlanningRestrictionReason: "Order identity needs review." }), "Order identity needs review.");
});
