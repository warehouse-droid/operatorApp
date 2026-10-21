import test from "node:test";
import assert from "node:assert/strict";
import { cargoFunctions } from "../../support/sales-order-cargo-fixture.mjs";

test("re-plan notices request review of remaining work while keeping source updates and saves available", () => {
  const reviews = [{ token: "test", orderRef: "SOA09413", groupRef: "GOA-9413-9434", acknowledged: false,
    replanRequested: true, contexts: [], changes: [{ message: "quantity: 25 → 26" }] }];
  const api = cargoFunctions("../../public/dispatch.js", ["renderExecutedOrderReviews"], {
    currentPlan: { id: "340" }, executedOrderReviewPlanId: "340", executedOrderReviews: reviews,
    executedOrderReviewExpanded: new Set(), executedOrderReviewConfirming: "", executedOrderReviewError: "",
    visibleExecutedOrderReviewHistory: () => [], escapeHtml: value => String(value), dispatchEditLeaseIsLocallyActive: () => true
  });
  assert.match(api.renderExecutedOrderReviews(), /source update — re-plan requested/u);
  assert.match(api.renderExecutedOrderReviews(), /Source updates and planning saves continue/u);
  assert.match(api.renderExecutedOrderReviews(), /remaining work/u);
  reviews[0].replanRequested = false;
  assert.doesNotMatch(api.renderExecutedOrderReviews(), /re-plan requested/u);
  assert.match(api.renderExecutedOrderReviews(), /review needed/u);
});

test("source refresh requests fresh notices without waiting for acknowledgement or delaying the order feed", async () => {
  const events = [];
  const api = cargoFunctions("../../public/dispatch.js", ["runQueuedDispatchOrderPoolRefresh"], {
    orderPoolRefreshInFlight: false, orderPoolRefreshTrailing: false, orderPoolRefreshReason: "Order data updated.",
    modalType: "", modalOrderId: "", routeNotice: "",
    loadExecutedOrderReviews: ({ force }) => { events.push(["notice", force]); return new Promise(() => {}); },
    loadDispatchOrders: async () => { events.push(["feed"]); return true; },
    renderDispatchNoticePatch: () => {}, renderDispatchOrderPoolPatch: () => {}
  });
  await api.runQueuedDispatchOrderPoolRefresh();
  assert.deepEqual(events, [["notice", true], ["feed"]]);
});
