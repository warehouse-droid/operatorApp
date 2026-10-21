import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { cargoFunctions } from "../../support/sales-order-cargo-fixture.mjs";

const functions = cargoFunctions("../../public/dispatch.js", ["isReviewOnlyOrder"]);
const order = { type: "SO", netsuiteStatusText: "Sales Order : Billed", operatorStatus: "open", localYardOrderStatus: "Open",
  fulfillmentStatus: "not_fulfilled", localOrderReopened: true, dispatchFulfilledSalesPlanningEligible: true, dispatchPlanningRestricted: false };

test("audited local reopen restores normal Dispatch actions despite NetSuite Billed", () => {
  assert.equal(functions.isReviewOnlyOrder(order), false);
  assert.equal(functions.isReviewOnlyOrder({ ...order, localOrderReopened: false }), false);
});

test("property: billing review follows Dispatch restrictions independently of Operator execution", () => {
  fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.boolean(),
    fc.constantFrom("open", "preparing", "confirmed", "packed", "loaded", "partial_loaded", "shipped"),
    (reopened, eligible, restricted, status) => {
      const actual = functions.isReviewOnlyOrder({ ...order, localOrderReopened: reopened,
        dispatchFulfilledSalesPlanningEligible: eligible, dispatchPlanningRestricted: restricted, operatorStatus: status });
      assert.equal(actual, restricted);
    }), { seed: 20261015, numRuns: 100, examples: [[true, true, false, "open"]] });
});

const empty = () => "";
const presentation = {
  shortageQty: () => 0, hasUsableDispatchAddress: () => true, transitBlockMessage: empty,
  orderAssignment: () => ({}), isOrderPlannedOutsideCurrentPlan: () => false,
  isScmReconciliationBlocked: order => order.reconciliationBlocked === true,
  isReviewOnlyOrder: functions.isReviewOnlyOrder, packedUnitText: empty, orderExecutionStatus: () => "pending",
  orderPlannedElsewhereText: empty, poSourceReferenceText: empty, selectedOrderIds: new Set(),
  escapeHtml: value => String(value || ""), movementText: empty, orderPickupText: empty,
  orderUnitText: empty, orderFootprintPallets: () => 1, formatLbs: empty, orderWeightLbs: () => 1,
  isSalesOrderReattempt: () => false, reviewOnlyText: () => "Loaded", canConsolidatePick: () => false,
  scmReconciliationBlockText: empty
};
const { renderOrderCard } = cargoFunctions("../../public/dispatch.js", [
  "renderOrderCard", "isDispatchPlanningRestricted", "dispatchPlanningRestrictionText"
], presentation);

test("reopened card shows local Open without a completed billing badge", () => {
  const html = renderOrderCard({ ...order, id: "SO-LOCAL-OPEN" });
  assert.match(html, /Open locally/u);
  assert.doesNotMatch(html, /Completed · delivery pending/u);
  assert.match(html, /draggable="true"/u);
});
