import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const dispatchSource = await readFile(
  new URL("../../../public/dispatch.js", import.meta.url),
  "utf8"
);
const serviceWorkerSource = await readFile(
  new URL("../../../public/service-worker.js", import.meta.url),
  "utf8"
);

function functionBody(name) {
  const marker = `function ${name}(`;
  const start = dispatchSource.indexOf(marker);
  assert.notEqual(start, -1, `Expected ${name} to be implemented.`);
  const parametersOpen = dispatchSource.indexOf("(", start);
  let parameterDepth = 0;
  let parametersClose = -1;
  for (let index = parametersOpen; index < dispatchSource.length; index += 1) {
    if (dispatchSource[index] === "(") {
      parameterDepth += 1;
    }
    if (dispatchSource[index] === ")") {
      parameterDepth -= 1;
    }
    if (!parameterDepth) {
      parametersClose = index;
      break;
    }
  }
  assert.notEqual(parametersClose, -1, `Could not read ${name} parameters.`);
  const open = dispatchSource.indexOf("{", parametersClose);
  let depth = 0;
  for (let index = open; index < dispatchSource.length; index += 1) {
    if (dispatchSource[index] === "{") {
      depth += 1;
    }
    if (dispatchSource[index] === "}") {
      depth -= 1;
    }
    if (!depth) {
      return dispatchSource.slice(start, index + 1);
    }
  }
  throw new Error(`Could not read ${name}.`);
}

test("a compact-plan stop can render before its full catalog order arrives", () => {
  const dropoffForStop = Function(
    "sameDispatchLocation",
    `"use strict"; return (${functionBody("dropoffForStop")});`
  )((left, right) => String(left || "") === String(right || ""));

  assert.equal(
    dropoffForStop(null, { orderId: "RETAINED-ORDER", dropLocation: "12441" }),
    null,
    "A temporarily missing order must fall back to stop-level routing data instead of crashing the planner."
  );
});

test("a grouped CO cannot impersonate one child's transit CO", () => {
  const transitCoSourceRef = Function(
    `"use strict"; return (${functionBody("transitCoSourceRef")});`
  )();

  assert.equal(
    transitCoSourceRef({
      id: "GOA-7510-7512",
      type: "CO",
      childOrders: ["CO-SOA07510", "CO-SOA07512"],
      sourceOrderId: "SOA07510",
      relatedSoId: "SOA07510"
    }),
    "",
    "a grouped transit load must not rewrite SOA07510.transitCo.id to GOA-7510-7512"
  );
  assert.equal(
    transitCoSourceRef({ id: "CO-SOA07512", type: "CO", sourceOrderId: "SOA07512" }),
    "SOA07512",
    "an ordinary transit CO must still reconcile its source SO"
  );
});

test("both supported CO creation paths converge on one CO-GOA identity", () => {
  const groupedDispatchOrderId = Function(
    `"use strict"; return (${functionBody("groupedDispatchOrderId")});`
  )();

  const individualCoFirst = groupedDispatchOrderId([
    { id: "CO-SOA07510", type: "CO" },
    { id: "CO-SOA07512", type: "CO" }
  ]);
  const sourceGroupFirst = `CO-${groupedDispatchOrderId([
    { id: "SOA07510", type: "SO" },
    { id: "SOA07512", type: "SO" }
  ])}`;

  assert.equal(individualCoFirst, "CO-GOA-7510-7512");
  assert.equal(sourceGroupFirst, "CO-GOA-7510-7512");
  assert.equal(individualCoFirst, sourceGroupFirst);
});

test("CO selections reject mixed lifecycles but allow CO plus CO", () => {
  const coGroupSelectionBlockReason = Function(
    `"use strict"; return (${functionBody("coGroupSelectionBlockReason")});`
  )();

  assert.equal(coGroupSelectionBlockReason([
    { id: "CO-SOA07510", type: "CO" },
    { id: "CO-SOA07512", type: "CO" }
  ]), "");
  assert.match(coGroupSelectionBlockReason([
    { id: "CO-SOA07510", type: "CO" },
    { id: "SOA07512", type: "SO" }
  ]), /CO orders can only be grouped with other CO orders/u);
});

test("grouping a CO-of-group preserves the CO identity instead of flattening its source orders", () => {
  const canonicalDispatchOrderType = Function(
    `"use strict"; return (${functionBody("canonicalDispatchOrderType")});`
  )();
  const isAggregateDispatchCoGroup = Function(
    "canonicalDispatchOrderType",
    `"use strict"; return (${functionBody("isAggregateDispatchCoGroup")});`
  )(canonicalDispatchOrderType);
  const flattenDispatchGroupMembers = Function(
    "canonicalDispatchOrderType",
    "isAggregateDispatchCoGroup",
    `"use strict"; return (${functionBody("flattenDispatchGroupMembers")});`
  )(canonicalDispatchOrderType, isAggregateDispatchCoGroup);

  const coOfGroup = {
    id: "CO-GSO-101-102",
    type: "CO",
    childOrders: ["SO-101", "SO-102"],
    childOrderDetails: [
      { id: "SO-101", type: "SO" },
      { id: "SO-102", type: "SO" }
    ]
  };
  const directCo = { id: "CO-SO-103", type: "CO" };
  const grouped = flattenDispatchGroupMembers({
    id: "CO-GSO-101-102-103",
    type: "CO",
    childOrders: [coOfGroup.id, directCo.id],
    childOrderDetails: [coOfGroup, directCo]
  });

  assert.deepEqual(grouped.childOrders, [coOfGroup.id, directCo.id]);
});

test("a completed hidden CO satisfies the source-order drag prerequisite", () => {
  const isTransitCoPlanned = Function(
    "relatedTransitCo",
    "allAssignedOrderIds",
    `"use strict"; return (${functionBody("isTransitCoPlanned")});`
  )(
    () => null,
    () => new Set()
  );

  assert.equal(isTransitCoPlanned({
    id: "SOA07512",
    transitCo: { id: "CO-SOA07512", status: "completed" }
  }), true);
  assert.equal(isTransitCoPlanned({
    id: "SOA07512",
    transitCo: { id: "CO-SOA07512", status: "pending_load" }
  }), false);
  assert.equal(isTransitCoPlanned({
    id: "SOA07512",
    transitCo: { id: "CO-SOA07512" }
  }), false);
});

test("the Aug-14 assigned custom order survives a later feed that omits it", () => {
  const customOrder = {
    id: "3022118075",
    type: "CUSTOM",
    sourceTable: "dispatch_custom_orders",
    pickupAddressOverride: "8375 5 Side Rd, Milton, ON L7J 0A1",
    address: "3445 Kennedy Rd, Scarborough, ON M1V 4Y3"
  };
  const harness = Function(
    "initialOrder",
    "captureOperationalLoadSignatures",
    "activePhysicalOrderEvidence",
    "normalizeOrder",
    "filterDispatchOrderFeedForAppliedPlan",
    "orderMatchesActivityRefs",
    "shouldPreserveDuringFeedRefresh",
    "isOrderAssignedInCurrentPlan",
    "preserveActiveOrderEvidence",
    "reconcileTransitCoSourceOrders",
    "reapplyActiveOrderEvidence",
    "reconcilePickupStopRepresentatives",
    "invalidateRoutesChangedByOrderFeed",
    `"use strict";
      let orders = [initialOrder];
      let orderCatalog = [];
      let currentPlan = { id: "234", planDate: "2026-08-14" };
      let appliedPlanStructure = { planId: "234", planDate: "2026-08-14", orderIds: new Set([initialOrder.id]) };
      let selectedOrderId = initialOrder.id;
      let selectedOrderIds = new Set([initialOrder.id]);
      ${functionBody("applyDispatchOrderFeed")}
      return {
        applyDispatchOrderFeed,
        orders: () => orders
      };`
  )(
    customOrder,
    () => new Map(),
    () => ({ all: new Set(), pickups: new Set(), drops: new Set() }),
    (order) => ({ ...order }),
    (feed) => feed,
    () => false,
    () => false,
    (id) => String(id) === customOrder.id,
    (_previous, refreshed) => refreshed,
    () => {},
    (orders) => orders,
    () => {},
    () => {}
  );

  harness.applyDispatchOrderFeed([]);
  assert.deepEqual(
    harness.orders().map((order) => order.id),
    [customOrder.id],
    "An assigned saved-plan order remains authoritative even when the open-order feed no longer lists it."
  );
});

test("operator service worker ignores unsupported request schemes", () => {
  const listeners = new Map();
  const context = {
    URL,
    Request: globalThis.Request,
    caches: {
      open: async () => ({ addAll: async () => {}, put: async () => {} }),
      keys: async () => [],
      delete: async () => true,
      match: async () => null
    },
    fetch: async () => new globalThis.Response("extension response"),
    Response: globalThis.Response,
    self: {
      location: { origin: "https://mbbsoperation.com" },
      addEventListener(type, listener) { listeners.set(type, listener); },
      skipWaiting() {},
      clients: { claim: async () => {} }
    }
  };
  vm.runInNewContext(serviceWorkerSource, context, { filename: "service-worker.js" });
  let responseOwned = false;
  listeners.get("fetch")({
    request: { method: "GET", url: "chrome-extension://test-extension/injected.js" },
    respondWith() { responseOwned = true; }
  });
  assert.equal(responseOwned, false, "Unsupported schemes must remain outside this service worker's cache pipeline.");
});

test("stored edit credentials are accepted only for the same plan and browser session", () => {
  const parseStoredDispatchEditLease = Function(
    `"use strict"; return (${functionBody("parseStoredDispatchEditLease")});`
  )();
  const valid = JSON.stringify({
    planDate: "2026-08-14",
    sessionId: "dispatch-session-a",
    editLeaseToken: "test-edit-lease",
    expiresAt: "2026-08-14T23:30:00.000Z"
  });
  assert.deepEqual(
    parseStoredDispatchEditLease(valid, { planDate: "2026-08-14", sessionId: "dispatch-session-a" }),
    {
      planDate: "2026-08-14",
      sessionId: "dispatch-session-a",
      editLeaseToken: "test-edit-lease",
      expiresAt: "2026-08-14T23:30:00.000Z"
    }
  );
  assert.equal(parseStoredDispatchEditLease(valid, { planDate: "2026-08-13", sessionId: "dispatch-session-a" }), null);
  assert.equal(parseStoredDispatchEditLease(valid, { planDate: "2026-08-14", sessionId: "dispatch-session-b" }), null);
  assert.equal(parseStoredDispatchEditLease("not-json", { planDate: "2026-08-14", sessionId: "dispatch-session-a" }), null);
});

test("reload resumes only after validation, while rejection and explicit exit clear credentials", () => {
  assert.match(dispatchSource, /const\s+DISPATCH_EDIT_LEASE_SESSION_KEY\s*=/u);
  assert.match(functionBody("enterDispatchEditMode"), /persistStoredDispatchEditLease/u);
  assert.match(functionBody("refreshDispatchPlanEditLease"), /resumeStoredDispatchEditLease/u);
  assert.match(functionBody("releaseDispatchEditMode"), /clearStoredDispatchEditLease/u);

  const heartbeat = functionBody("heartbeatDispatchEditLease");
  assert.match(heartbeat, /isAuthoritativeDispatchLeaseFailure/u);
  assert.match(heartbeat, /persistStoredDispatchEditLease/u);

  const pagehideStart = dispatchSource.indexOf('window.addEventListener("pagehide"');
  const pagehideEnd = dispatchSource.indexOf("requireDispatchLogin", pagehideStart);
  assert.ok(pagehideStart >= 0 && pagehideEnd > pagehideStart, "Expected the pagehide lifecycle handler.");
  assert.doesNotMatch(
    dispatchSource.slice(pagehideStart, pagehideEnd),
    /plan-edit-lease\/release/u,
    "A page reload must not release a lease that the same tab is about to resume."
  );
});

test("transient heartbeat failures are distinct from authoritative lease rejection", () => {
  const isAuthoritativeDispatchLeaseFailure = Function(
    `"use strict"; return (${functionBody("isAuthoritativeDispatchLeaseFailure")});`
  )();
  assert.equal(isAuthoritativeDispatchLeaseFailure({ status: 409 }), true);
  assert.equal(isAuthoritativeDispatchLeaseFailure({ status: 401 }), true);
  assert.equal(isAuthoritativeDispatchLeaseFailure({ status: 503 }), false);
  assert.equal(isAuthoritativeDispatchLeaseFailure(new TypeError("Failed to fetch")), false);
});

test("compact bootstrap starts before the expensive global order feed", () => {
  const init = functionBody("initDispatch");
  const bootstrap = init.indexOf("await loadPlanForDate(");
  const orderFeed = init.indexOf("loadDispatchOrders(");
  assert.ok(bootstrap >= 0, "Expected compact-plan bootstrap on startup.");
  assert.ok(orderFeed > bootstrap, "The full order feed must not contend with compact-plan bootstrap.");
});
