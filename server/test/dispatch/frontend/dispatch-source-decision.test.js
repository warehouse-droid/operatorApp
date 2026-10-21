import test from "node:test";
import assert from "node:assert/strict";
import { cargoFunctions } from "../../support/sales-order-cargo-fixture.mjs";

function ui(overrides = {}) {
  return cargoFunctions("../../public/dispatch.js", ["renderExecutedOrderReviews"], {
    currentPlan: { id: "349" }, executedOrderReviewPlanId: "349",
    executedOrderReviews: [{ token: "a".repeat(64), orderRef: "SOA09704", groupRef: "GOA-9704-9731", acknowledged: true,
      decisionRequired: true, sourceAvailable: true, sourceModifiedAt: "2026-10-06T13:38:00Z", sourceReceivedAt: "2026-10-06T13:38:21Z",
      contexts: [{ driverName: "Aurther", truckPlate: "BL27129", loadName: "Load 2" }], changes: [{ message: "BWS-PW-REG-GM consolidated" }] }],
    executedOrderReviewExpanded: new Set(), executedOrderReviewConfirming: "", executedOrderReviewError: "",
    visibleExecutedOrderReviewHistory: () => [], escapeHtml: value => String(value),
    dispatchEditLeaseIsLocallyActive: () => true, formatSourceReviewTime: value => value,
    ...overrides
  });
}

test("an acknowledged warning without a decision offers both explicit choices and source timestamps", () => {
  const html = ui().renderExecutedOrderReviews();
  assert.match(html, /Protect driver work/);
  assert.match(html, /Accept NetSuite change/);
  assert.match(html, /SOA09704/);
  assert.match(html, /GOA-9704-9731/);
  assert.match(html, /BL27129/);
  assert.match(html, /2026-10-06T13:38:00Z/);
  assert.match(html, /data-review-decision="protect_driver_work"/);
  assert.match(html, /data-review-decision="accept_netsuite_change"/);
});

test("both choices are disabled without an edit lease or when the source is unavailable", () => {
  const html = ui({ dispatchEditLeaseIsLocallyActive: () => false }).renderExecutedOrderReviews();
  assert.equal([...html.matchAll(/data-review-decision="[^"]+"[^>]*disabled/gu)].length, 2);
});

test("an automatically accepted change asks for acknowledgement and offers no conflicting choice", () => {
  const html = ui({ executedOrderReviews: [{ token: "accepted", orderRef: "SOA09704", groupRef: "GOA-9704-9731",
    decision: "accept_netsuite_change", acknowledged: false, decisionRequired: false, sourceAvailable: true,
    contexts: [], changes: [] }] }).renderExecutedOrderReviews();
  assert.match(html, /dispatch acknowledgement needed/);
  assert.match(html, /Acknowledge change/);
  assert.doesNotMatch(html, /Protect driver work/);
});

test("confirmation submits the decision and revision while preserving unrelated browser drafts", async () => {
  const requests = [];
  let patched;
  const original = { id: "SOA09704", items: [{ quantity: 60 }, { quantity: 50 }], salesQty: 110, notes: "unsaved note" };
  const unrelated = { id: "OTHER", items: [{ quantity: 17 }], address: "unsaved address" };
  const replacements = [{ id: "SOA09704", items: [{ quantity: 110 }], salesQty: 110 }];
  const state = { orders: [original, unrelated], orderCatalog: [original, unrelated],
    currentPlan: { id: "349", revision: 12, orders: [original], trucks: [] },
    executedOrderReviews: [{ token: "a".repeat(64), acknowledged: true, decisionRequired: true }],
    executedOrderReviewPlanId: "349", executedOrderReviewConfirming: "", executedOrderReviewError: "",
    dispatchSessionId: "draft-session", localPlanDirty: true, confirmInFlight: false, saveInFlight: false,
    dispatchLeaseRequestPayload: value => value, renderDispatchNoticePatch: () => {}, render: () => {},
    rememberAssignedOrderEvidence: values => { patched = values; }, normalizeOrder: value => value,
    loadExecutedOrderReviews: async () => {},
    fetch: async (_url, init) => { requests.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ reviews: [], orders: replacements,
      plan: { id: "349", revision: 13, digest: "new-digest", savedAt: "2026-10-07T15:00:00Z" } }) }; }
  };
  const api = cargoFunctions("../../public/dispatch.js", ["confirmExecutedOrderReview", "applyDispatchSourceDecisionResult"], state);
  await api.confirmExecutedOrderReview("a".repeat(64), "accept_netsuite_change");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].decision, "accept_netsuite_change");
  assert.equal(requests[0].baseRevision, 12);
  assert.deepEqual(patched[0].items, replacements[0].items);
  assert.equal(patched[0].notes, "unsaved note");
  assert.deepEqual(patched[1], unrelated);
});

test("a failed decision refreshes the warning and leaves the draft untouched", async () => {
  let refreshed = 0;
  let patched = 0;
  const api = cargoFunctions("../../public/dispatch.js", ["confirmExecutedOrderReview", "renderExecutedOrderReviews"], {
    currentPlan: { id: "349", revision: 12 }, executedOrderReviewPlanId: "349",
    executedOrderReviews: [{ token: "stale", orderRef: "SOA09704", acknowledged: false, changes: [] }],
    executedOrderReviewExpanded: new Set(), executedOrderReviewConfirming: "", executedOrderReviewError: "",
    saveInFlight: false, confirmInFlight: false, dispatchSessionId: "session",
    dispatchLeaseRequestPayload: value => value, renderDispatchNoticePatch: () => {}, render: () => {},
    visibleExecutedOrderReviewHistory: () => [], escapeHtml: value => String(value), dispatchEditLeaseIsLocallyActive: () => true,
    applyDispatchSourceDecisionResult: () => { patched += 1; },
    loadExecutedOrderReviews: async () => { refreshed += 1; },
    fetch: async () => ({ ok: false, json: async () => ({ error: "Source changed again" }) })
  });
  await api.confirmExecutedOrderReview("stale", "accept_netsuite_change");
  assert.equal(refreshed, 1);
  assert.equal(patched, 0);
  assert.match(api.renderExecutedOrderReviews(), /Source changed again/);
});

test("a confirmation waits for an in-flight plan save instead of racing it", async () => {
  let requests = 0;
  let notice = 0;
  const api = cargoFunctions("../../public/dispatch.js", ["confirmExecutedOrderReview"], {
    currentPlan: { id: "349" }, executedOrderReviewPlanId: "349",
    executedOrderReviews: [{ token: "busy", acknowledged: false }], executedOrderReviewConfirming: "",
    executedOrderReviewError: "", saveInFlight: true, confirmInFlight: false,
    renderDispatchNoticePatch: () => { notice += 1; }, fetch: () => { requests += 1; }
  });
  await api.confirmExecutedOrderReview("busy", "protect_driver_work");
  assert.equal(requests, 0);
  assert.equal(notice, 1);
});

test("source correction preserves the revision fence when another dispatcher changed the plan", () => {
  const currentPlan = { id: "349", revision: 12, digest: "old", orders: [] };
  const api = cargoFunctions("../../public/dispatch.js", ["applyDispatchSourceDecisionResult"], {
    currentPlan, orders: [{ id: "SOA09704", items: [{ quantity: 60 }, { quantity: 50 }] }], orderCatalog: [],
    rememberAssignedOrderEvidence: () => {}
  });
  const corrected = api.applyDispatchSourceDecisionResult({ orderRefs: ["SOA09704"],
    orders: [{ id: "SOA09704", items: [{ quantity: 110 }] }],
    plan: { id: "349", revision: 17, digest: "other-plan", safeToAdvanceRevision: false } });
  assert.equal(corrected[0].items.length, 1);
  assert.equal(currentPlan.revision, 12);
  assert.equal(currentPlan.digest, "old");
});

test("group correction retains a sibling's unsaved note and preserves nested child identities", () => {
  const sibling = { id: "SOA09731", notes: "unsaved sibling note", items: [{ quantity: 16 }] };
  const group = { id: "GOA-9704-9731", items: [{ quantity: 110 }, { quantity: 50 }, { quantity: 16 }],
    childOrderDetails: [{ id: "SOA09704", items: [{ quantity: 110 }, { quantity: 50 }] }, sibling] };
  const replacement = { ...group, items: [{ quantity: 110 }, { quantity: 16 }],
    childOrderDetails: [{ id: "SOA09704", items: [{ quantity: 110 }] }, { ...sibling, notes: "server note" }] };
  const api = cargoFunctions("../../public/dispatch.js", ["applyDispatchSourceDecisionResult"], {
    currentPlan: { id: "349" }, orders: [group], orderCatalog: [group], rememberAssignedOrderEvidence: () => {}
  });
  const corrected = api.applyDispatchSourceDecisionResult({ orderRefs: ["SOA09704"], orders: [replacement] });
  assert.equal(corrected[0].items.length, 2);
  assert.equal(corrected[0].childOrderDetails[0].items.length, 1);
  assert.deepEqual(corrected[0].childOrderDetails[1], sibling);
});

test("a response for a plan that was closed cannot change the current draft", async () => {
  const currentPlan = { id: "349", revision: 12 };
  let patched = 0;
  const api = cargoFunctions("../../public/dispatch.js", ["confirmExecutedOrderReview"], {
    currentPlan, executedOrderReviewPlanId: "349", executedOrderReviews: [{ token: "one", acknowledged: false }],
    executedOrderReviewConfirming: "", executedOrderReviewError: "", saveInFlight: false, confirmInFlight: false,
    dispatchSessionId: "session", dispatchLeaseRequestPayload: value => value, renderDispatchNoticePatch: () => {}, render: () => {},
    applyDispatchSourceDecisionResult: () => { patched += 1; },
    fetch: async () => { currentPlan.id = "350"; return { ok: true, json: async () => ({ orders: [], reviews: [] }) }; }
  });
  await api.confirmExecutedOrderReview("one", "accept_netsuite_change");
  assert.equal(patched, 0);
  assert.equal(currentPlan.id, "350");
});
