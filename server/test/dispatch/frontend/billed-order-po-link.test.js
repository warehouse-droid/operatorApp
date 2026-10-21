import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { cargoFunctions } from "../../support/sales-order-cargo-fixture.mjs";

function actions(order, others = [order]) {
  return cargoFunctions("../../public/dispatch.js", [
    "renderSelectedOrderActions", "isReviewOnlyOrder", "isDispatchPlanningRestricted", "dispatchPlanningRestrictionText"
  ], {
    activeOrderType: "SO", selectedOrder: () => order, selectedOrders: () => others,
    escapeHtml: value => String(value || ""), isScmReconciliationBlocked: () => false,
    groupedOrderTransitCoId: () => "", supportsTransitCoForOrder: () => false,
    displayDateTime: () => "", isSalesOrderReattempt: () => false, canConsolidatePick: () => false
  }).renderSelectedOrderActions();
}

const billed = { id: "SO-BILLING-ONLY", type: "SO", netsuiteStatusText: "Sales Order : Billed",
  operatorStatus: "open", localYardOrderStatus: "Open", fulfillmentStatus: "not_fulfilled",
  dispatchFulfilledSalesPlanningEligible: true, dispatchPlanningRestricted: false,
  dispatchCompletionStatus: "" };

test("billed, unfulfilled delivery exposes Link PO and identifies billing accurately", () => {
  const html = actions(billed);
  assert.match(html, /data-action="open-po-link-modal"/u);
  assert.match(html, /Billed in NetSuite/u);
  assert.doesNotMatch(html, /Loaded\/shipped history/u);
  assert.match(html, /data-action="open-to-link-modal"/u);
});

test("Dispatch completion and restrictions prevent PO linking; external execution labels do not", () => {
  for (const patch of [{ dispatchPlanningRestricted: true },
    { dispatchCompletionStatus: "completed", dispatchFulfilledSalesPlanningEligible: false },
    { type: "PO" }, { type: "TO" }, { type: "CUSTOM" }]) {
    assert.doesNotMatch(actions({ ...billed, ...patch }), /data-action="open-po-link-modal"/u, JSON.stringify(patch));
  }
  for (const patch of [{ dispatchFulfilledSalesPlanningEligible: false }, { dispatchFulfilledSalesPlanningEligible: undefined },
    { operatorStatus: "loaded" }, { operatorStatus: "partial_loaded" }, { localYardOrderStatus: "Loaded" },
    { fulfillmentStatus: "fulfilled" }, { fulfillmentStatus: "shipped" }, { fulfillmentStatus: "partial_fulfilled" },
    { fulfillmentStatus: "partially_fulfilled" }, { netsuiteStatusText: "Sales Order : Pending Billing" }]) {
    assert.match(actions({ ...billed, ...patch }), /data-action="open-po-link-modal"/u, JSON.stringify(patch));
  }
});

test("raw billing and fulfillment metadata do not control Dispatch linking", () => {
  const order = { ...billed, netsuiteStatusText: "", fulfillmentStatus: "",
    raw: { status_text: "Sales Order : Billed", fulfillment_status: "not_fulfilled" } };
  assert.match(actions(order), /data-action="open-po-link-modal"/u);
  assert.match(actions({ ...order, raw: { ...order.raw, fulfillment_status: "partial_fulfilled" } }), /data-action="open-po-link-modal"/u);
});

test("an ordinary open order retains Link PO; a mixed selection cannot bypass Dispatch completion", () => {
  const open = { ...billed, netsuiteStatusText: "Pending Fulfillment", dispatchCompletionStatus: "" };
  assert.match(actions(open), /data-action="open-po-link-modal"/u);
  assert.doesNotMatch(actions(billed, [billed, { ...billed, id: "SO-DELIVERED", dispatchCompletionStatus: "completed", dispatchFulfilledSalesPlanningEligible: false }]), /data-action="open-po-link-modal"/u);
});

test("property: billing and Operator labels do not change Dispatch linking", () => {
  fc.assert(fc.property(fc.constantFrom("Billed", " billed ", "Sales Order: Billed", "SALES ORDER : BILLED"),
    fc.constantFrom("open", "preparing", "packed", "confirmed", "loaded", "partial_loaded", "shipped"),
    fc.boolean(), (label, status, eligible) => {
      const html = actions({ ...billed, netsuiteStatusText: label, operatorStatus: status, dispatchFulfilledSalesPlanningEligible: eligible });
      const expected = true;
      assert.equal(html.includes('data-action="open-po-link-modal"'), expected);
    }), { seed: 20261015, numRuns: 24, examples: [["Billed", "open", false], ["Billed", "loaded", true]] });
});
