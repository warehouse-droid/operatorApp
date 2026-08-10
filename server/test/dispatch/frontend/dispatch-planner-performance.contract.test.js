import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dispatchSource = await readFile(
  new URL("../../../public/dispatch.js", import.meta.url),
  "utf8"
);
const serverSource = await readFile(
  new URL("../../../src/server.js", import.meta.url),
  "utf8"
);

function functionBody(name) {
  const start = dispatchSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Expected ${name} to be implemented.`);
  const parametersOpen = dispatchSource.indexOf("(", start);
  let parameterDepth = 0;
  let parametersClose = -1;
  for (let index = parametersOpen; index < dispatchSource.length; index += 1) {
    if (dispatchSource[index] === "(") {parameterDepth += 1;}
    if (dispatchSource[index] === ")") {parameterDepth -= 1;}
    if (!parameterDepth) {
      parametersClose = index;
      break;
    }
  }
  assert.notEqual(parametersClose, -1, `Could not read ${name} parameters.`);
  const open = dispatchSource.indexOf("{", parametersClose);
  let depth = 0;
  for (let index = open; index < dispatchSource.length; index += 1) {
    if (dispatchSource[index] === "{") {depth += 1;}
    if (dispatchSource[index] === "}") {depth -= 1;}
    if (!depth) {return dispatchSource.slice(start, index + 1);}
  }
  throw new Error(`Could not read ${name}.`);
}

test("DP-01/DP-02: snapshot failures fail closed and only explicit exists:false can open a blank plan", () => {
  assert.match(
    dispatchSource,
    /let\s+dispatchPlannerSnapshotState\s*=\s*["']loading["']/u,
    "Planner state must begin loading rather than assuming an empty board is safe."
  );
  const applySnapshot = functionBody("applyDispatchPlanSnapshotResult");
  assert.match(applySnapshot, /snapshot\?\.exists\s*===\s*false/u);
  assert.match(applySnapshot, /dispatchPlannerSnapshotState\s*=\s*["'](?:stale|failed)["']/u);
  assert.doesNotMatch(applySnapshot, /catch[\s\S]{0,800}resetPlanningBoard\(/u);
  const mutationGate = functionBody("canMutateDispatchPlan");
  assert.match(mutationGate, /dispatchPlannerSnapshotState\s*===\s*["']ready["']/u);
});

test("DP-03: targeted server operational fields win without overwriting local placement or driver evidence", () => {
  const merge = functionBody("mergeDispatchOrderSearchFeed");
  assert.doesNotMatch(
    merge,
    /\{\s*\.\.\.candidate\s*,\s*\.\.\.existing\s*\}/u,
    "The current merge gives stale in-memory values precedence over a newer response."
  );
  assert.match(dispatchSource, /function\s+mergeFreshDispatchOperationalOrder\(/u);
  assert.match(dispatchSource, /function\s+preserveDispatchPlanningFields\(/u);
  assert.match(dispatchSource, /function\s+preserveActiveOrderEvidence\(/u);
});

test("DP-04: the browser consumes a compact assigned-plan snapshot, never an unassigned order pool embedded in it", () => {
  assert.match(dispatchSource, /\/api\/dispatch\/v2\/bootstrap/u);
  assert.match(dispatchSource, /function\s+applyCompactDispatchPlanSnapshot\(/u);
  const applyCompact = functionBody("applyCompactDispatchPlanSnapshot");
  assert.doesNotMatch(applyCompact, /orderCatalog\s*=\s*.*snapshot\.orders/u);
  assert.match(applyCompact, /assignedOrders|assignedOrderSnapshots/u);
});

test("DP-11: CO updates are targeted and do not fetch, merge, or render the whole order pool", () => {
  assert.match(dispatchSource, /\/api\/dispatch\/v2\/order-feed\/[A-Za-z${}._-]+/u);
  const targeted = functionBody("applyTargetedDispatchOrderUpdate");
  assert.doesNotMatch(targeted, /loadDispatchOrders\(/u);
  assert.doesNotMatch(targeted, /applyDispatchOrderFeed\(/u);
  assert.doesNotMatch(targeted, /render\(\{\s*save:\s*false\s*\}\)/u);
  assert.match(targeted, /renderDispatchOrderPoolPatch|patchDispatchOrderPool/u);
});

test("DP-15: CO, group, and split modal updates are isolated from the planner root", () => {
  assert.match(dispatchSource, /data-dispatch-planner-root/u);
  assert.match(dispatchSource, /data-dispatch-modal-layer/u);
  const render = functionBody("render");
  assert.doesNotMatch(
    render,
    /app\.innerHTML\s*=/u,
    "Replacing the app root invalidates the board, focus, and scroll position for every popup action."
  );
  assert.match(dispatchSource, /function\s+renderDispatchModalInPlace\(/u);
  const modal = functionBody("renderDispatchModalInPlace");
  assert.doesNotMatch(modal, /render\(\{\s*save:\s*false\s*\}\)/u);
});

test("DP-16 frontend: pure 2,000-order command reduction is benchmarked and retains a 50ms P95 budget", async () => {
  assert.match(dispatchSource, /function\s+reduceDispatchPlanCommand\(/u);
  const reducer = functionBody("reduceDispatchPlanCommand");
  assert.doesNotMatch(reducer, /render\(/u);
  const reduce = Function(`"use strict"; return (${reducer});`)();
  const state = {
    orders: Array.from({ length: 2_000 }, (_, index) => ({ id: `DP-UI-${index}`, items: [] })),
    trucks: [{ id: "truck-ui", loads: [{
      id: "load-ui",
      stops: Array.from({ length: 200 }, (_, index) => ({ id: `stop-ui-${index}`, orderId: `DP-UI-${index}` }))
    }] }]
  };
  const samples = [];
  for (let index = 0; index < 30; index += 1) {
    const startedAt = performance.now();
    const next = reduce(state, { type: "remove_order", payload: { orderRef: `DP-UI-${index}` } });
    samples.push(performance.now() - startedAt);
    assert.equal(next.orders.length, 2_000);
  }
  const { recordDispatchPerformanceSamples } = await import("./dispatch-performance-recording.js");
  const result = await recordDispatchPerformanceSamples({
    scenario: "DP-16-frontend-2000-orders",
    samples,
    responseBytes: [Buffer.byteLength(JSON.stringify(state), "utf8")]
  });
  assert.ok(result.p95Ms < 50, `2,000-order reducer P95 was ${result.p95Ms}ms`);
});

test("DP-05/DP-16 frontend: normal autosave uses the guarded fast acknowledgement path", () => {
  assert.match(dispatchSource, /function\s+dispatchIncrementalSaveRequest\(/u);
  const request = functionBody("dispatchIncrementalSaveRequest");
  assert.match(request, /\/api\/dispatch\/v2\/plans\/\$\{encodeURIComponent\(targetPlanId\)\}\/commands/u);
  assert.match(request, /commandType:\s*["']replace_plan["']/u);
  assert.match(request, /baseDigest:\s*currentPlan\?\.digest/u);

  const saveStart = dispatchSource.indexOf("function savePlanToServer(");
  assert.notEqual(saveStart, -1);
  const save = dispatchSource.slice(saveStart, saveStart + 14_000);
  assert.match(save, /shouldUseDispatchIncrementalSave\(/u);
  assert.match(save, /dispatchIncrementalSaveRequest\(/u);
  assert.match(save, /forceSave|truck_sequence/u, "Force and truck-sequence compatibility saves must remain explicit.");
  assert.match(save, /renderDispatchSaveStatePatch\(/u);
  assert.doesNotMatch(save, /incrementalSave[\s\S]{0,500}plannerRoot\.innerHTML/u);
});

test("DP-16 startup: the compact plan is on the critical path but the full order feed and history are background work", () => {
  const init = functionBody("initDispatch");
  assert.match(init, /const\s+orderFeedPromise\s*=\s*loadDispatchOrders\(/u);
  assert.match(init, /await\s+loadPlanForDate\(/u);
  const criticalWait = /await\s+Promise\.all\(\[([\s\S]*?)\]\)/u.exec(init)?.[1] || "";
  assert.doesNotMatch(criticalWait, /loadDispatchOrders|loadPlanHistory/u);
  assert.match(init, /renderDispatchOrderPoolPatch\(|renderDispatchPlannerPatch\(/u);
});

test("DP-03/DP-11: SO, PO, TO, and CO popup mutations request targeted order responses", () => {
  assert.match(dispatchSource, /orders\/\$\{encodeURIComponent\(button\.dataset\.order\)\}\/vendor-yard\?response=targeted/u);
  assert.match(dispatchSource, /orders\/\$\{encodeURIComponent\(order\.id\)\}\/po-allocations\?response=targeted/u);
  assert.match(dispatchSource, /po-allocations\/\$\{encodeURIComponent\(button\.dataset\.allocation\)\}[\s\S]{0,240}response=targeted/u);
  assert.match(dispatchSource, /order-dependencies\?response=targeted/u);
  assert.match(dispatchSource, /order-dependencies\/\$\{encodeURIComponent\(dependencyId\)\}\/mode\?response=targeted/u);
  assert.match(dispatchSource, /order-dependencies\/\$\{encodeURIComponent\(dependencyId\)\}[\s\S]{0,240}response=targeted/u);

  const mergeTargeted = functionBody("mergeTargetedDispatchMutationOrders");
  assert.match(mergeTargeted, /mergeDispatchOrderSearchFeed/u);
  assert.doesNotMatch(mergeTargeted, /applyDispatchOrderFeed|loadDispatchOrders|render\(/u);

  const targetedServer = (() => {
    const start = serverSource.indexOf("async function targetedDispatchMutationOrders(");
    assert.notEqual(start, -1, "Expected a targeted mutation response helper.");
    return serverSource.slice(start, start + 2_500);
  })();
  assert.match(targetedServer, /listDispatchOrdersForResponse\(\{\s*search(?:\s*[:,}])/u);
  assert.doesNotMatch(targetedServer, /listDispatchOrdersForResponse\(\s*\)/u);
});

test("DP-18 frontend: CO initiation blocks only on the lightweight details acknowledgement", () => {
  assert.match(
    dispatchSource,
    /orders\/\$\{encodeURIComponent\(order\.id\)\}\/details\?response=ack/u,
    "CO initiation must not wait for targeted/global order hydration before it advances the UI."
  );
  const detailsRoute = (() => {
    const start = serverSource.indexOf('app.put("/api/dispatch/orders/:id/details"');
    assert.notEqual(start, -1, "Expected the dispatch details route.");
    return serverSource.slice(start, start + 3_000);
  })();
  const acknowledgement = detailsRoute.indexOf('req.query.response === "ack"');
  const targetedHydration = detailsRoute.indexOf("targetedDispatchMutationOrders");
  assert.ok(acknowledgement >= 0, "The details route must implement response=ack.");
  assert.ok(
    targetedHydration < 0 || acknowledgement < targetedHydration,
    "The acknowledgement must return before targeted order hydration."
  );
});

test("DP-19 frontend: completed travel evidence survives local mutations while stale forecasts stay hidden", () => {
  const rememberEvidence = functionBody("rememberDispatchTravelExecutionEvidence");
  assert.match(rememberEvidence, /actualLeave|actualArrival|status/u);
  assert.match(rememberEvidence, /kind[^\n]+inter_stop/u);
  const clearForecast = functionBody("clearDispatchForecast");
  assert.match(clearForecast, /rememberDispatchTravelExecutionEvidence\(dispatchForecast\)/u);
  const travelForPair = functionBody("travelLegForVisitPair");
  assert.match(travelForPair, /interStopExecutionEvidenceForLoad/u);
  assert.match(travelForPair, /travelLegMatchesVisitPair/u);
});

test("DP-21 frontend: completed stop baseline evidence survives unrelated local mutations", () => {
  assert.match(dispatchSource, /let\s+dispatchStopExecutionEvidence\s*=/u);
  const rememberEvidence = functionBody("rememberDispatchStopExecutionEvidence");
  assert.match(rememberEvidence, /actualArrival|actualLeave|status/u);
  const clearForecast = functionBody("clearDispatchForecast");
  assert.match(clearForecast, /rememberDispatchStopExecutionEvidence\(dispatchForecast\)/u);
  const stopRecord = functionBody("forecastRecordForStop");
  assert.match(stopRecord, /stopExecutionEvidenceForStop/u);
});

test("DP-22 frontend: compact nested group children remain resolvable as plan evidence", () => {
  const collectEvidence = functionBody("collectAssignedOrderEvidence");
  const collect = Function(`"use strict"; return (${collectEvidence});`)();
  const child = { id: "3022094354", type: "PO", items: [{ sku: "DP-CHILD" }] };
  const evidence = collect([{
    id: "POB03597",
    type: "PO",
    childOrders: [child.id],
    childOrderDetails: [child]
  }]);
  assert.equal(evidence.get(child.id)?.items?.[0]?.sku, "DP-CHILD");
  assert.match(dispatchSource, /let\s+assignedOrderEvidenceById\s*=\s*new Map/u);
  assert.match(functionBody("orderById"), /assignedOrderEvidenceById\.get/u);
  assert.match(functionBody("directOrderForStop"), /assignedOrderEvidenceById\.get/u);
  assert.match(functionBody("collapseGroupedOrderStops"), /stopHasDriverActivity/u);
  const applySaved = functionBody("applySavedPlan");
  assert.match(applySaved, /rememberAssignedOrderEvidence\(savedOrders\)/u);
  assert.match(
    applySaved,
    /savedAssignedIds\.has\(order\.id\)\s*\|\|\s*!savedGroupStructureConflictsWithPlan/u,
    "Assigned group evidence must survive even when an old snapshot has inconsistent ownership metadata."
  );
});

test("DP-24 frontend: incomplete compact order snapshots never delete executed child stops", () => {
  const cleanup = functionBody("cleanupOrphanPickupStops");
  assert.match(
    cleanup,
    /stop\.type\s*!==\s*["']drop["'][\s\S]{0,220}stopHasDriverActivity\(load,\s*stop\)/u,
    "An executed drop must survive even when its historical child order is absent from the compact order snapshot."
  );
  assert.match(
    cleanup,
    /stop\.type\s*!==\s*["']pick["'][\s\S]{0,220}stopHasDriverActivity\(load,\s*stop\)/u,
    "An executed pickup must survive even when the current order feed no longer requires that historical pickup."
  );
});

test("DP-26 frontend: planner undo and redo are persisted even after resetting the history fingerprint", () => {
  assert.match(
    functionBody("undoDispatchChange"),
    /commitPlanMutation\(\s*["']dispatch_plan_undo["']\s*,\s*null\s*,\s*\{\s*forceSave:\s*true\s*\}\s*\)/u,
    "Undo must force a server save because its history fingerprint already describes the restored state."
  );
  assert.match(
    functionBody("redoDispatchChange"),
    /commitPlanMutation\(\s*["']dispatch_plan_redo["']\s*,\s*null\s*,\s*\{\s*forceSave:\s*true\s*\}\s*\)/u,
    "Redo must force a server save because its history fingerprint already describes the restored state."
  );
});

test("DP-28 frontend: CO cancellation is server-first and clears every stale required-CO marker", () => {
  const clearSnapshot = functionBody("clearTransitCoFromOrderSnapshot");
  const clearTransitCo = Function(`"use strict"; return (${clearSnapshot});`)();
  const relationshipCases = [
    { label: "CO only", po: false, to: false },
    { label: "Link PO + CO", po: true, to: false },
    { label: "Link TO + CO", po: false, to: true },
    { label: "Link PO + Link TO + CO", po: true, to: true }
  ];
  for (const relationship of relationshipCases) {
    const poPickupManifest = relationship.po ? [{
      poOrderRef: "POB03597",
      location: "Vendor Yard",
      items: [{ sku: "GROUP-SKU", pieces: 8, quantity: 8 }]
    }] : undefined;
    const orderDependencies = relationship.to ? [{
      id: 912,
      transferOrderRef: "TOB00762",
      mode: "direct_to_customer",
      status: "active"
    }] : undefined;
    const grouped = {
      id: "GOA-6486-6489",
      transitCo: { id: "CO-GOA-6486-6489", fromYard: "2967", toYard: "12441" },
      transitOriginalPickupLocations: ["2967"],
      transitOriginalSourceYard: "2967",
      pickupLocations: ["12441", ...(relationship.po ? ["Vendor Yard"] : [])],
      sourceYard: "12441",
      notes: "Transit via 12441. Grouped orders",
      ...(poPickupManifest ? { poPickupManifest } : {}),
      ...(orderDependencies ? { orderDependencies } : {}),
      childOrderDetails: [{
        id: "SOA06486",
        transitCo: { id: "CO-GOA-6486-6489", fromYard: "2967", toYard: "12441" },
        transitOriginalPickupLocations: ["2967"],
        transitOriginalSourceYard: "2967",
        pickupLocations: ["12441"],
        sourceYard: "12441",
        items: [{
          sku: "GROUP-SKU",
          pieces: 8,
          ...(relationship.po ? { poAllocatedPieces: 8, poAllocatedSalesQty: 8 } : {})
        }],
        ...(orderDependencies ? { orderDependencies } : {})
      }]
    };
    const expectedPo = relationship.po ? structuredClone({
      poPickupManifest: grouped.poPickupManifest,
      childItems: grouped.childOrderDetails[0].items
    }) : null;
    const expectedTo = relationship.to ? structuredClone({
      group: grouped.orderDependencies,
      child: grouped.childOrderDetails[0].orderDependencies
    }) : null;

    const cleared = clearTransitCo(grouped, "CO-GOA-6486-6489");

    assert.equal(cleared.transitCo, undefined, relationship.label);
    assert.deepEqual(
      cleared.pickupLocations,
      ["2967", ...(relationship.po ? ["Vendor Yard"] : [])],
      `${relationship.label} must restore the original yard without dropping a PO pickup.`
    );
    assert.equal(cleared.sourceYard, "2967", relationship.label);
    assert.equal(cleared.transitOriginalPickupLocations, undefined, relationship.label);
    assert.equal(cleared.childOrderDetails[0].transitCo, undefined, relationship.label);
    assert.deepEqual(cleared.childOrderDetails[0].pickupLocations, ["2967"], relationship.label);
    assert.doesNotMatch(cleared.notes, /^Transit via /iu, relationship.label);
    if (expectedPo) {
      assert.deepEqual(cleared.poPickupManifest, expectedPo.poPickupManifest, relationship.label);
      assert.deepEqual(cleared.childOrderDetails[0].items, expectedPo.childItems, relationship.label);
    }
    if (expectedTo) {
      assert.deepEqual(cleared.orderDependencies, expectedTo.group, relationship.label);
      assert.deepEqual(cleared.childOrderDetails[0].orderDependencies, expectedTo.child, relationship.label);
    }
  }

  const cancellation = functionBody("cancelTransitCoAndApply");
  assert.match(cancellation, /await\s+cancelTransitCoOnServer\(coId\)/u);
  assert.ok(
    cancellation.indexOf("await cancelTransitCoOnServer(coId)")
      < cancellation.indexOf("cancelTransitCoForOrder(order.id)"),
    "The server must accept cancellation before the browser removes CO state."
  );
  assert.doesNotMatch(cancellation, /persistTransitCoInBackground/u);
  assert.match(dispatchSource, /cancelledCo\s*=\s*await\s+cancelTransitCoAndApply\(order\)/u);

  const preservePlanning = Function(`"use strict"; return (${functionBody("preserveDispatchPlanningFields")});`)();
  const authoritativeCancellation = preservePlanning(
    {
      id: "SOA06486",
      transitCo: { id: "CO-GOA-6486-6489" },
      transitOriginalPickupLocations: ["2967"]
    },
    { id: "SOA06486", transitCo: null }
  );
  assert.equal(authoritativeCancellation.transitCo, null);
  assert.equal(authoritativeCancellation.transitOriginalPickupLocations, undefined);
});

test("DP-15: successful popup persistence never replaces the dispatch planner root", () => {
  const coPersistence = functionBody("persistTransitCoInBackground");
  assert.doesNotMatch(coPersistence, /render\(\{\s*save:\s*false\s*\}\)/u);
  assert.match(coPersistence, /renderDispatchNoticePatch/u);

  const targetedFinish = functionBody("finishTargetedDispatchPopupMutation");
  assert.match(targetedFinish, /renderDispatchOrderPoolPatch/u);
  assert.match(targetedFinish, /renderDispatchPlannerPatch/u);
  assert.match(targetedFinish, /renderDispatchModalInPlace/u);
  assert.doesNotMatch(targetedFinish, /render\(/u);
});

test("DP-11 backend: a targeted refresh does not hydrate every historical snapshot document", () => {
  const snapshotStart = serverSource.indexOf("async function listDispatchSnapshotDerivedOrders(");
  assert.notEqual(snapshotStart, -1);
  const snapshotLoader = serverSource.slice(snapshotStart, snapshotStart + 3_500);
  assert.match(snapshotLoader, /search\s*=\s*["']{2}/u);
  assert.match(snapshotLoader, /s\.orders::text\s+ILIKE/u);

  const feedStart = serverSource.indexOf("async function listDispatchOrdersForResponse(");
  assert.notEqual(feedStart, -1);
  const feed = serverSource.slice(feedStart, feedStart + 2_500);
  assert.match(feed, /listDispatchSnapshotDerivedOrders\(\{\s*type,\s*search:\s*searchTerm\s*\}\)/u);
});

test("DP-29 backend: snapshot-derived groups reconcile cancelled local COs before entering the order feed", () => {
  const snapshotStart = serverSource.indexOf("async function listDispatchSnapshotDerivedOrders(");
  assert.notEqual(snapshotStart, -1);
  const snapshotLoader = serverSource.slice(snapshotStart, snapshotStart + 5_000);
  assert.match(snapshotLoader, /FROM\s+local_co_orders[\s\S]*?status\s*=\s*['"]cancelled['"]/u);
  assert.match(
    snapshotLoader,
    /clearCancelledTransitCoMetadata\(snapshotOrder,\s*cancelledLocalCoByRef\)/u
  );
  assert.match(
    serverSource,
    /import\s*\{[^}]*clearCancelledTransitCoMetadata[^}]*\}\s*from\s*["']\.\/dispatch-planner-performance\.js["']/u
  );
});
