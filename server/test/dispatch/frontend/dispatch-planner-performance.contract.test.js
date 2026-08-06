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
  const open = dispatchSource.indexOf("{", start);
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
