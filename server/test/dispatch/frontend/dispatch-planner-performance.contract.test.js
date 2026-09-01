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

test("DP-12: ordinary order events patch only the pool and preserve its scroll position", () => {
  const queuedRefresh = functionBody("queueDispatchOrderPoolRefresh");
  const refreshWorker = functionBody("runQueuedDispatchOrderPoolRefresh");
  assert.match(queuedRefresh, /orderPoolRefreshInFlight/u);
  assert.match(queuedRefresh, /orderPoolRefreshTrailing\s*=\s*true/u);
  assert.match(refreshWorker, /loadDispatchOrders\(/u);
  assert.match(refreshWorker, /renderDispatchOrderPoolPatch\(/u);
  assert.match(refreshWorker, /renderDispatchNoticePatch\(/u);
  assert.match(refreshWorker, /orderPoolRefreshInFlight\s*=\s*false[\s\S]*orderPoolRefreshTrailing/u,
    "Events received during a refresh must collapse into one trailing refresh.");
  assert.doesNotMatch(refreshWorker, /restoreServerPlan|loadDriverJobStatuses|refreshPlannedAssignments/u);
  assert.doesNotMatch(refreshWorker, /renderDispatchPlannerPatch|renderGoogleMapPreview/u);
  assert.doesNotMatch(refreshWorker, /\brender\(\{\s*save:/u);

  const events = functionBody("connectEvents");
  assert.match(events, /dispatch\.orders\.updated[\s\S]*queueDispatchOrderPoolRefresh/u);
  assert.doesNotMatch(events, /queueRemoteRefresh/u);

  const poolPatch = functionBody("renderDispatchOrderPoolPatch");
  assert.match(poolPatch, /previousScrollTop/u);
  assert.match(poolPatch, /nextList\.scrollTop\s*=\s*previousScrollTop/u);
  assert.match(poolPatch, /requestAnimationFrame/u,
    "The browser must restore the pool offset again after layout settles.");
  assert.match(poolPatch, /selectionEnd/u,
    "An order update must retain the complete search selection, not collapse it.");
});

test("DP-13: unchanged execution polling cannot rebuild the planner, preview, or map", () => {
  const refresh = functionBody("refreshDriverExecutionAndForecast");
  assert.match(refresh, /previousSignature\s*=\s*dispatchExecutionRenderSignature\(\)/u);
  assert.match(refresh, /changed\s*=\s*dispatchExecutionRenderSignature\(\)\s*!==\s*previousSignature/u);
  assert.match(refresh, /renderAfter\s*&&\s*changed/u);
  assert.match(refresh, /renderDispatchExecutionPatch\(\)/u);
  assert.doesNotMatch(refresh, /\brender\(\{\s*save:\s*false\s*\}\)/u,
    "The periodic execution poll must not replace the complete planner root.");

  const forecastEvidence = Function(`"use strict"; return (${functionBody("dispatchForecastRenderEvidence")});`)();
  assert.deepEqual(
    forecastEvidence({ generatedAt: "volatile", planRevision: 7, stops: [{ id: "A" }] }),
    { planRevision: 7, stops: [{ id: "A" }] },
    "A newly generated timestamp alone must not make an unchanged forecast rerender."
  );

  const plannerPatch = functionBody("renderDispatchPlannerPatch");
  assert.match(plannerPatch, /captureGoogleMapPreviewState\(\)/u);
  assert.match(plannerPatch, /restoreGoogleMapPreviewState\(mapState\)/u);
  assert.match(plannerPatch, /if\s*\(!mapPreserved\)\s*renderGoogleMapPreview\(\)/u,
    "An unchanged route must retain its existing Google Map DOM node.");
});

test("DP-14: stop-sequence scroll restoration targets the preview-owned load list", () => {
  const selector = functionBody("selectorForElement");
  assert.match(selector, /closest\(["']\[data-dispatch-load-preview-layer\]["']\)/u);
  assert.match(selector, /\.preview-stop-list/u);
  assert.match(selector, /\[data-dispatch-load-preview-layer\]\s+\.preview-stop-list/u);
  assert.match(selector, /data-load/u,
    "The selected load identity must disambiguate its preview stop list from board load elements.");

  const capture = functionBody("captureRenderUiState");
  assert.match(capture, /\.load-preview-panel/u);
  assert.match(capture, /\.load-preview-body/u);
  assert.match(capture, /\.preview-stop-list/u);
  assert.match(capture, /scrollTop/u);
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

test("DP-05/DP-16 frontend: normal autosave uses guarded semantic deltas with a legacy fallback", () => {
  assert.match(dispatchSource, /function\s+dispatchIncrementalSaveRequest\(/u);
  const request = functionBody("dispatchIncrementalSaveRequest");
  assert.match(request, /\/api\/dispatch\/v2\/plans\/\$\{encodeURIComponent\(targetPlanId\)\}\/commands/u);
  assert.match(request, /plannerCommandMode\s*===\s*["']on["']/u);
  assert.match(request, /dispatchSemanticCommandType/u);
  assert.match(request, /planDelta:\s*buildDispatchPlanWireDelta/u);
  assert.match(request, /:\s*["']replace_plan["']/u,
    "Turning compact commands off must retain the existing full-board command contract.");
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

test("DPO-10 frontend: indexed search is bounded, cancellable, paged, and hydrated before mutation", () => {
  const search = functionBody("loadDispatchOrderSearch");
  assert.match(search, /plannerOrderPoolMode\s*===\s*["']on["']/u);
  assert.match(search, /plannerOrderPoolMode\s*===\s*["']shadow["']/u);
  assert.match(search, /versionedPool/u);
  assert.match(search, /AbortController/u);
  assert.match(search, /\/api\/dispatch\/v2\/order-pool/u);
  const schedule = functionBody("scheduleDispatchOrderSearch");
  assert.match(schedule, /225/u);
  const load = functionBody("loadDispatchOrders");
  assert.match(load, /plannerOrderPoolMode\s*===\s*["']shadow["']/u,
    "Shadow mode must exercise the versioned endpoint while the server still returns the legacy result.");
  assert.match(load, /versionedPool/u);
  assert.match(load, /limit:\s*["']200["']/u);
  assert.match(load, /nextCursor|cursor/u);
  const hydrate = functionBody("hydrateDispatchOrder");
  assert.match(hydrate, /dispatchOrderHydrationPromises/u);
  assert.match(hydrate, /applyTargetedDispatchOrderUpdate/u);
  assert.match(dispatchSource, /catalogHydrated\s*===\s*false[\s\S]{0,500}event\.preventDefault\(\)[\s\S]{0,500}hydrateDispatchOrder/u);
  assert.match(dispatchSource, /data-action=["']jump-planned-order["']/u);

  const fallbackStart = serverSource.indexOf("async function legacyDispatchOrderPool(");
  assert.notEqual(fallbackStart, -1, "Expected a legacy warming/failure fallback.");
  const fallback = serverSource.slice(fallbackStart, fallbackStart + 900);
  assert.doesNotMatch(fallback, /visible\.slice\(/u,
    "A warming catalog has no legacy cursor, so truncating it would make valid orders unreachable.");
});

test("DPO-10b: Planning searches split POs by source and displays each corresponding ref", () => {
  const sourcePoMatch = Function(`"use strict"; let searchText = "POB03748"; return (${functionBody("matchesSearch")});`)();
  assert.equal(sourcePoMatch({
    id: "SN1398667",
    type: "PO",
    originalPoRef: "POB03748",
    dispatchRef: "SN1398667",
    items: []
  }), true, "a normal PO dispatch ref must remain visible when its source PO matched the server search");
  assert.equal(sourcePoMatch({
    id: "SN1398449",
    type: "PO",
    sourcePoRef: "POB03748",
    sourcePoRefs: ["POB03748"],
    correspondingPoRefs: ["SN1398449"],
    items: []
  }), true, "an SCM split ref must remain visible when its source PO matched the server search");

  const label = Function(`"use strict"; return (${functionBody("poSourceReferenceText")});`)();
  assert.equal(label({
    id: "SN1398449",
    type: "PO",
    originalPoRef: "SN1398449",
    sourcePoRef: "POB03321",
    sourcePoRefs: ["POB03321"],
    correspondingPoRefs: ["SN1398449"]
  }), "Source PO POB03321 → Ref SN1398449");
  assert.equal(label({
    id: "POB03321",
    type: "PO",
    originalPoRef: "POB03321",
    sourcePoRefs: ["POB03321"],
    correspondingPoRefs: ["SN1398449", "SN1398450"]
  }), "Source PO POB03321 → Refs SN1398449, SN1398450");
  assert.equal(label({
    id: "PGOB-17",
    type: "PO",
    sourcePoRefs: ["POB03321", "POB03322"],
    correspondingPoRefs: ["SN1398449", "SN1398450"]
  }), "Source PO POB03321, POB03322 → Refs SN1398449, SN1398450");
  assert.equal(label({ id: "POB100", type: "PO", originalPoRef: "POB100" }), "");

  const card = functionBody("renderOrderCard");
  assert.match(card, /poSourceReferenceText\(order\)/u);
  assert.match(card, /po-source-reference/u);
  assert.match(serverSource, /includeScmLinkedSearchRefs:\s*Boolean\(searchTerm\)/u);
});

test("DPO-11 frontend: route estimates cannot block compact autosave, while confirm remains strict", () => {
  const flush = functionBody("flushPlanSaveQueue");
  assert.match(flush, /plannerCommandMode\s*!==\s*["']on["'][\s\S]*ensureGoogleRouteEstimatesBeforeSave/u);
  const confirm = functionBody("confirmCurrentPlanAtomic");
  assert.match(confirm, /await\s+ensureGoogleRouteEstimatesBeforeSave\(["']confirm["']\)/u);
});

test("DPO-12 frontend: Save Now drains autosave then creates an idempotent manual checkpoint", () => {
  const saveNow = functionBody("forceSaveCurrentPlan");
  assert.match(saveNow, /await\s+saveCurrentPlanNow/u);
  assert.match(saveNow, /plannerCommandMode\s*===\s*["']on["']/u);
  assert.match(saveNow, /createDispatchPlanCheckpoint\(["']manual["'],\s*["']save_now["']\)/u);
  const checkpoint = functionBody("createDispatchPlanCheckpoint");
  assert.match(checkpoint, /\/api\/dispatch\/v2\/plans\/\$\{encodeURIComponent\(currentPlan\.id\)\}\/checkpoints/u);
  assert.match(checkpoint, /idempotencyKey/u);
  assert.match(checkpoint, /expectedRevision/u);
  assert.match(checkpoint, /expectedDigest/u);
});

test("DPO-11 backend: restore always protects executed Driver evidence", () => {
  const routeStart = serverSource.indexOf('app.post("/api/dispatch/plan-snapshots/:snapshotId/restore"');
  assert.notEqual(routeStart, -1, "Expected the Dispatch snapshot restore endpoint.");
  const route = serverSource.slice(routeStart, routeStart + 9_000);
  assert.match(route, /evaluateExecutedPrefixPolicy\(\{[\s\S]{0,400}listDriverJobStatuses/u);
  assert.match(route, /restoreExecutionPolicy\.allowed/u);
  assert.ok(
    route.indexOf("restoreExecutionPolicy") < route.indexOf("restoreDispatchPlanSnapshot"),
    "Executed Driver evidence must be checked before planner-owned state changes."
  );
});

test("DP-16 startup: the compact plan is on the critical path but the full order feed and history are background work", () => {
  const init = functionBody("initDispatch");
  assert.match(init, /await\s+loadPlanForDate\(/u);
  assert.ok(
    init.indexOf("loadDispatchOrders(") > init.indexOf("await loadPlanForDate("),
    "The global feed must begin only after the compact plan has rendered, so its expensive query cannot delay bootstrap."
  );
  const criticalWait = /await\s+Promise\.all\(\[([\s\S]*?)\]\)/u.exec(init)?.[1] || "";
  assert.doesNotMatch(criticalWait, /loadDispatchOrders|loadPlanHistory/u);
  assert.match(init, /renderDispatchOrderPoolPatch\(|renderDispatchPlannerPatch\(/u);
});

test("date-plan switching reuses the date-independent order pool after its first successful load", () => {
  assert.match(dispatchSource, /let\s+dispatchOrderPoolLoaded\s*=\s*false/u);
  const refresh = functionBody("loadDispatchOrderPoolForPlanSwitch");
  assert.match(refresh, /dispatchOrderPoolLoaded/u);
  assert.match(refresh, /isDispatchHistoryEditMode\(\)/u);
  assert.match(refresh, /return\s+loadDispatchOrders\(\)/u);

  const handlerStart = dispatchSource.indexOf('if (event.target?.id === "planDateInput")');
  assert.notEqual(handlerStart, -1, "Expected the date-plan switch handler.");
  const handler = dispatchSource.slice(handlerStart, handlerStart + 1_800);
  assert.match(handler, /loadDispatchOrderPoolForPlanSwitch\(\)/u);
  assert.doesNotMatch(
    handler,
    /Promise\.all\(\[loadDispatchOrders\(\),\s*loadMbtBinFrontLegs\(\)\]\)/u,
    "Switching dates must not reload a global pool that is already in memory."
  );
});

test("history edit mode scopes reconciliation-complete feeds to a leased past date", () => {
  const requestSource = functionBody("dispatchOrderFeedRequest");
  const harness = Function(`
    "use strict";
    let historyEditMode = false;
    let currentPlanDate = "2026-08-09";
    let planEditLeaseToken = "test-history-lease";
    function isDispatchHistoryEditMode() { return historyEditMode; }
    ${requestSource}
    return {
      request: dispatchOrderFeedRequest,
      enable() { historyEditMode = true; }
    };
  `)();
  assert.deepEqual(harness.request(), { url: "/api/dispatch/orders", headers: {} },
    "Current/view-mode requests must retain the ordinary Dispatch feed contract.");
  assert.deepEqual(harness.request({ sync: true }), { url: "/api/dispatch/sync", headers: {} });
  harness.enable();
  const historicalEmpty = harness.request();
  const historicalEmptyUrl = new URL(historicalEmpty.url, "http://dispatch.test");
  assert.equal(historicalEmptyUrl.searchParams.has("search"), false,
    "Entering History Edit Mode must not fabricate a broad completed-order search.");
  assert.equal(historicalEmptyUrl.searchParams.get("historyPlanDate"), "2026-08-09");
  const historical = harness.request({ search: "PO-HISTORY" });
  assert.match(historical.url, /^\/api\/dispatch\/orders\?/u);
  const historicalUrl = new URL(historical.url, "http://dispatch.test");
  assert.equal(historicalUrl.searchParams.get("search"), "PO-HISTORY");
  assert.equal(historicalUrl.searchParams.get("historyPlanDate"), "2026-08-09");
  assert.equal(historical.headers["x-dispatch-edit-lease"], "test-history-lease");

  assert.match(functionBody("enterDispatchEditMode"), /isDispatchHistoryEditMode\(\)[\s\S]*await\s+loadDispatchOrders\(/u);
  assert.match(functionBody("releaseDispatchEditMode"), /leavingHistoryEditMode[\s\S]*await\s+loadDispatchOrders\(/u);
  assert.match(dispatchSource, /History Edit Mode[\s\S]*Driver PWA-completed orders/u);
  assert.match(dispatchSource, /Search to find reconciliation-complete historical orders/u);
  assert.match(dispatchSource, /historicalReconciliationComplete/u);
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

  const cancellationStart = dispatchSource.indexOf('if (action === "cancel-transit-co")');
  const cancellationEnd = dispatchSource.indexOf('if (action === "undo-plan")', cancellationStart);
  assert.ok(cancellationStart >= 0 && cancellationEnd > cancellationStart, "Expected an explicit CO cancellation action.");
  const cancellation = dispatchSource.slice(cancellationStart, cancellationEnd);
  assert.match(cancellation, /window\.confirm/u);
  assert.match(cancellation, /await\s+cancelTransitCoOnServer\(coId\)/u);
  assert.ok(
    cancellation.indexOf("await cancelTransitCoOnServer(coId)")
      < cancellation.indexOf("cancelTransitCoForOrder(order.id)"),
    "The server must accept cancellation before the browser removes CO state."
  );
  assert.doesNotMatch(cancellation, /persistTransitCoInBackground/u);
  const detailsStart = dispatchSource.indexOf('if (form.dataset.form === "edit-order-details")');
  const detailsEnd = dispatchSource.indexOf('if (form.dataset.form === "driver")', detailsStart);
  const detailsSave = dispatchSource.slice(detailsStart, detailsEnd);
  assert.doesNotMatch(detailsSave, /cancelTransitCo(?:OnServer|ForOrder|AndApply)/u);

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
  assert.match(snapshotLoader, /exactOrderRefs\s*=\s*\[\]/u);
  assert.match(snapshotLoader, /s\.orders::text\s+ILIKE/u);
  assert.match(snapshotLoader, /dispatch_plan_order_assignments/u);

  const feedStart = serverSource.indexOf("async function loadDispatchOrdersForResponse(");
  assert.notEqual(feedStart, -1);
  const feed = serverSource.slice(feedStart, feedStart + 2_500);
  assert.match(
    feed,
    /listDispatchSnapshotDerivedOrders\(\{\s*type,\s*search:\s*searchTerm,\s*exactOrderRefs:\s*normalizedExactOrderRefs\s*\}\)/u
  );
  assert.match(serverSource, /dispatchOrderResponseSingleFlight[\s\S]*worker:\s*loadDispatchOrdersForResponse/u);
});

test("DP-29 backend: snapshot-derived groups reconcile both cancelled and active global COs before entering the order feed", () => {
  const snapshotStart = serverSource.indexOf("async function listDispatchSnapshotDerivedOrders(");
  assert.notEqual(snapshotStart, -1);
  const snapshotLoader = serverSource.slice(snapshotStart, snapshotStart + 12_000);
  assert.match(snapshotLoader, /SELECT\s+co_ref,\s*source_order_ref,[\s\S]*?status[\s\S]*?FROM\s+local_co_orders/u);
  assert.match(snapshotLoader, /String\(row\.status[\s\S]*?===\s*["']cancelled["']/u);
  assert.match(
    snapshotLoader,
    /clearCancelledTransitCoMetadata\(snapshotOrder,\s*cancelledLocalCoByRef\)/u
  );
  assert.match(
    snapshotLoader,
    /applyActiveTransitCoMetadata\([\s\S]*?activeLocalCoBySource/u
  );
  assert.match(
    serverSource,
    /import\s*\{[^}]*applyActiveTransitCoMetadata[^}]*clearCancelledTransitCoMetadata[^}]*\}\s*from\s*["']\.\/dispatch-planner-performance\.js["']/u
  );
});

test("cached order pools refresh global assignment ownership before edit, plan reuse, and jump", () => {
  const enterEdit = functionBody("enterDispatchEditMode");
  const loadPlan = functionBody("loadPlanForDate");
  const restorePlan = functionBody("restoreServerPlan");
  const jump = functionBody("jumpToPlannedOrder");
  const events = functionBody("connectEvents");

  assert.match(enterEdit, /await\s+refreshPlannedAssignments\(\)/u,
    "Entering Edit Mode must clear assignment flags left by an earlier plan revision.");
  assert.match(loadPlan, /await\s+refreshPlannedAssignments\(\)/u,
    "A date switch must not reuse stale cross-date assignment flags from the cached pool.");
  assert.match(restorePlan, /await\s+refreshPlannedAssignments\(\)/u,
    "A remote plan refresh must update assignment flags before merging the saved snapshot.");
  assert.match(jump, /await\s+refreshPlannedAssignments\(\)/u,
    "Jump-to-plan must revalidate a possibly stale card before trusting its date.");
  assert.match(jump, /is no longer planned\. The order pool has been refreshed\./u,
    "A concurrently unplanned order must not report a missing load as though it were still planned.");
  assert.match(
    events,
    /payload\.planDate\s*&&\s*payload\.planDate\s*!==\s*currentPlanDate[\s\S]*refreshPlannedAssignments\(\)/u,
    "A plan change on another date must still refresh global assignment ownership."
  );
});
