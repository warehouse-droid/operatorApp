import assert from "node:assert/strict";
import test from "node:test";
import { cargoFunctions } from "../../support/sales-order-cargo-fixture.mjs";

const empty = () => "";
const presentation = {
  shortageQty: () => 0, hasUsableDispatchAddress: () => true, transitBlockMessage: empty,
  orderAssignment: () => ({}), isOrderPlannedOutsideCurrentPlan: () => false,
  isScmReconciliationBlocked: order => order.reconciliationBlocked === true,
  isReviewOnlyOrder: () => true, packedUnitText: empty, orderExecutionStatus: () => "pending",
  orderPlannedElsewhereText: empty, poSourceReferenceText: empty, selectedOrderIds: new Set(),
  escapeHtml: value => String(value || ""), movementText: empty, orderPickupText: empty,
  orderUnitText: empty, orderFootprintPallets: () => 1, formatLbs: empty, orderWeightLbs: () => 1,
  isSalesOrderReattempt: () => false, reviewOnlyText: () => "Loaded", canConsolidatePick: () => false,
  scmReconciliationBlockText: empty
};
const { renderOrderCard } = cargoFunctions("../../public/dispatch.js", [
  "renderOrderCard", "isDispatchPlanningRestricted", "dispatchPlanningRestrictionText"
], presentation);

test("fulfilled SO card shows Completed with delivery pending and remains draggable", () => {
  const html = renderOrderCard({ id: "SO-FULFILLED", type: "SO", dispatchCompletionStatus: "completed",
    dispatchFulfilledSalesPlanningEligible: true, dispatchPlanningRestricted: false, scm: { status: "Completed" } });
  assert.match(html, /draggable="true"/);
  assert.match(html, /Completed · delivery pending/);
});

test("locally delivered SO stays search-only even with a stale eligibility flag", () => {
  const html = renderOrderCard({ id: "SO-DELIVERED", type: "SO", dispatchCompletionStatus: "completed",
    dispatchFulfilledSalesPlanningEligible: true, dispatchPlanningRestricted: true, scm: { status: "Completed" } });
  assert.match(html, /draggable="false"/);
  assert.match(html, /Completed · search only/);
  assert.doesNotMatch(html, /Completed · delivery pending/);
});
