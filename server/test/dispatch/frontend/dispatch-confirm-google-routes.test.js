import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse } from "espree";

const filename = new URL("../../../public/dispatch.js", import.meta.url);
const source = readFileSync(filename, "utf8");
const program = parse(source, { ecmaVersion: "latest", sourceType: "script", range: true }).body;
const declarations = new Map(program
  .filter(node => node.type === "FunctionDeclaration").map(node => [node.id.name, node]));
const requestMapDeclaration = program.find(node => node.type === "VariableDeclaration"
  && node.declarations.some(declaration => declaration.id.name === "backgroundRouteRequests"));
const clickRegistration = program.find(node => node.type === "ExpressionStatement"
  && node.expression.type === "CallExpression"
  && node.expression.callee.object?.name === "app"
  && node.expression.callee.property?.name === "addEventListener"
  && node.expression.arguments[0]?.value === "click");

function deferred() {
  let resolve;
  const promise = new Promise(finish => { resolve = finish; });
  return { promise, resolve };
}

function stopsFor(id) {
  return ["yard", "customer", "return"].map((place, index) => ({
    id: `${id}-${place}`, type: index === 1 ? "drop" : "pick", orderId: `${id}-order`,
    routeLocation: `${id}:${place}`, title: place, stayMinutes: index === 0 ? 5 : 10
  }));
}

function providerEstimate(body, { legMinutes = [25, 35], version = 1 } = {}) {
  const driveMinutes = legMinutes.reduce((sum, value) => sum + value, 0);
  const stayMinutes = body.stops.reduce((sum, stop) => sum + stop.stayMinutes, 0);
  const stopCoordinates = body.stops.map((_, index) => ({ lat: 43.3 + index / 100, lng: -80.4 + index / 100 }));
  return {
    source: "google_routes_v2", legMinutes, rawLegMinutes: [...legMinutes],
    rawDriveMinutes: driveMinutes, driveMinutes, stayMinutes, totalMinutes: driveMinutes + stayMinutes,
    stopCoordinates, routePath: [stopCoordinates[0], { lat: Number((43.4 + version / 1000).toFixed(3)), lng: -80.35 }, ...stopCoordinates.slice(1)],
    routeSignature: body.routeSignature, routeEstimateId: body.routeEstimateId, travelTimePercent: 0
  };
}

function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value,
    text: async () => JSON.stringify(value) };
}

function fixture({ ids = ["first", "second"], reverseTrucks = false, transport, includeClickHandler = false } = {}) {
  const loads = ids.map((id, index) => ({ id, name: `Load ${id}`, driverLogin: "driver-one",
    driverSequence: index, start: "07:00", startMode: index ? "auto" : "manual", stops: stopsFor(id) }));
  const firstTruck = { id: "truck-a", plate: "TRUCK-A", driverLogin: "driver-one", start: "07:00", loads: loads.filter((_, index) => index % 2 === 0) };
  const secondTruck = { id: "truck-b", plate: "TRUCK-B", driverLogin: "driver-one", start: "07:00", loads: loads.filter((_, index) => index % 2 === 1) };
  const state = { requests: [], saves: [], confirms: [], renders: [], scheduled: [], cachesWritten: 0, errors: [], clickHandler: null };
  let context;
  const findLoad = id => {
    for (const truck of context.trucks) {
      const load = truck.loads.find(item => item.id === id);
      if (load) return { truck, load };
    }
    return {};
  };
  const stats = (_truck, load) => {
    const sequence = context.driverLoadEntries();
    const index = sequence.findIndex(entry => entry.load.id === load.id);
    const previous = index > 0 ? sequence[index - 1] : null;
    const start = previous ? stats(previous.truck, previous.load).finish : 420;
    const estimate = context.estimateForLoad(load);
    const legs = estimate?.legMinutes || load.stops.slice(1).map(() => 30);
    let minute = start;
    const rows = load.stops.map((stop, stopIndex) => {
      if (stopIndex) minute += Number.isFinite(Number(legs[stopIndex - 1])) ? Number(legs[stopIndex - 1]) : 30;
      const arrival = minute;
      minute += stop.stayMinutes || 0;
      return { stop, arrival, depart: minute };
    });
    return { start, finish: start + Number(estimate?.totalMinutes ?? 85), scheduledStart: start,
      previousFinish: previous ? start : null, restBefore: 0, rows };
  };
  context = vm.createContext({
    console, Promise, Date, Map, Set, structuredClone,
    setTimeout: callback => { state.scheduled.push(callback); return state.scheduled.length; }, clearTimeout() {},
    window: { setTimeout: callback => { state.scheduled.push(callback); return state.scheduled.length; }, clearTimeout() {} },
    currentPlan: { id: "route-plan", planDate: "2096-12-13", revision: 4, digest: "acknowledged", status: "draft" },
    currentPlanDate: "2096-12-13", trucks: reverseTrucks ? [secondTruck, firstTruck] : [firstTruck, secondTruck],
    routeEstimates: {}, persistedRouteEstimateCache: {}, backgroundRouteInFlight: new Set(), backgroundRouteRequests: new Map(),
    backgroundRoutesRunning: false, backgroundRouteRunPromise: null, backgroundRouteRenderQueued: false,
    backgroundRouteTimer: null, persistedRouteEstimateSaveTimer: null,
    dispatchSessionId: "route-confirm-session", routeNotice: "", saveTimer: null,
    pendingDispatchPlanAction: null, pendingOperatorAlertRefs: new Set(), pendingTargetedOrderRefreshRefs: new Set(),
    localPlanGeneration: 1, localPlanDirty: false, saveQueued: false, confirmInFlight: false,
    planEditLeaseToken: "lease", DEFAULT_FIRST_LOAD_START: "07:00", DISPATCH_PLAN_DATE_KEY: "plan-date",
    dispatchPlanningSettings: { truckSwitchMinutes: 0 }, lastServerSavedAt: null,
    nextSaveNeedsOrderPoolRefresh: false, nextPlanSaveMode: "",
    findLoad, loadStats: stats, driverOrientedPlanningEnabled: () => true,
    loadDriverKey: (truck, load) => load.driverLogin || truck.driverLogin,
    loadDriver: (truck, load) => ({ login: load.driverLogin || truck.driverLogin, name: "Driver one" }),
    minutes: value => { const [hour, minute] = String(value).split(":").map(Number); return hour * 60 + minute; },
    effectiveTruckForLoad: truck => truck, truckTravelTimePercent: () => 0,
    mapStopsForLoad: load => load.stops,
    samePhysicalRouteStop: (left, right) => left?.routeLocation === right?.routeLocation,
    switchApproachTravelForLoad: (_truck, load) => {
      const entries = context.driverLoadEntries();
      const index = entries.findIndex(entry => entry.load.id === load.id);
      return index > 0 ? { previousEntry: entries[index - 1] } : null;
    },
    fallbackLegMinutesForRouteStops: stops => stops.slice(1).map((stop, index) => stop.routeLocation === stops[index].routeLocation ? 0 : 30),
    orderById: () => null, savePersistedRouteEstimateCache: () => { state.cachesWritten++; },
    normalizeLoadAssignments() {}, normalizePlanBeforeSave() {}, assignLoadFields: (_truck, load) => load,
    resolvedLoadStartMode: load => load.startMode || "auto", normalizeTypedDispatchTime: value => value,
    timeText: minute => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
    ensureDispatchPlanEditor: () => true, dispatchEditModeMessage: () => "Not editing",
    DISPATCH_VIEW_MUTATION_ACTIONS: new Set(["confirm-plan"]),
    app: { addEventListener: (type, listener) => { assert.equal(type, "click"); state.clickHandler = listener; } },
    confirmCurrentPlanAtomic: () => context.performDispatchPlanConfirmation(),
    reportDispatchSaveError: (...args) => { state.errors.push(args); },
    dispatchErrorMessage: async value => (await value.json()).error || `HTTP ${value.status}`,
    render: value => { state.renders.push(value); }, queueServerSave() {}, displayDate: value => String(value),
    dispatchStorageSet() {}, dispatchPlanWireState: value => value, compactCurrentPlan: value => value,
    applySavedPlan() {}, loadPlanHistory: async () => {}, savedPlanHash: () => "saved-hash",
    stablePlanHashPayload: () => "request-hash", resetLocalPlanDirty() {}, resetUndoHistory() {},
    saveCurrentPlanNow: async () => { state.saves.push(structuredClone(context.trucksWithTimingMetadata())); return { saved: true }; },
    planPayload: () => ({ planId: context.currentPlan.id, planDate: context.currentPlanDate,
      baseRevision: context.currentPlan.revision, baseDigest: context.currentPlan.digest,
      summary: {}, orders: [], trucks: context.trucksWithTimingMetadata() }),
    dispatchPlanActionRequest: async (_kind, _url, payload) => {
      state.confirms.push(structuredClone(payload));
      return { result: { ...payload, id: payload.planId, revision: 5, status: "confirmed" } };
    },
    fetch: async (url, options) => {
      assert.equal(url, "/api/dispatch/maps/route-estimate");
      const body = JSON.parse(options.body);
      const request = { body, id: body.stops[0].location.split(":")[0] };
      state.requests.push(request);
      return transport ? transport(request, state.requests.length) : response(providerEstimate(body));
    }
  });

  const required = ["isMbtPlanningLoad", "isPlanningLoadReadOnly", "driverLoadEntries", "routeSignature", "routeEstimateId", "routeEstimateMeta",
    "routeEstimateMatchesMeta", "routeEstimateHasCompleteGoogleLegs", "normalizeRouteEstimateForLoad", "estimateForLoad",
    "serializableRouteEstimateForLoad", "cacheRouteEstimate", "applyCachedRouteEstimate", "applyServerRouteEstimate",
    "googleRouteForLoad", "routeLoadsNeedingEstimate", "refreshGoogleRouteEstimatesForConfirmation",
    "routeEstimateChangesVisibleTiming", "plannedDepartureDate", "trucksWithTimingMetadata", "performDispatchPlanConfirmation"];
  const selected = new Set(required);
  function dependencies(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "Identifier" && declarations.has(node.name) && !(node.name in context)) selected.add(node.name);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(dependencies);
      else if (value && typeof value === "object") dependencies(value);
    }
  }
  for (const name of selected) {
    assert.ok(declarations.has(name), `Missing implementation ${name}`);
    dependencies(declarations.get(name));
  }
  // Compile one real helper body with full source offsets, including the actual
  // per-page request-map initializer when available in the captured version.
  let body = source.replace(/[^\n\r]/g, " ");
  const nodes = [...selected].map(name => declarations.get(name));
  if (requestMapDeclaration) nodes.push(requestMapDeclaration);
  if (includeClickHandler) { assert.ok(clickRegistration, "Missing actual Dispatch click handler."); nodes.push(clickRegistration); }
  for (const node of nodes) body = body.slice(0, node.range[0]) + source.slice(...node.range) + body.slice(node.range[1]);
  const exports = [...selected, ...(requestMapDeclaration ? ["backgroundRouteRequests"] : [])];
  Object.assign(context, vm.compileFunction(`${body}\nreturn {${exports.join(",")}};`, [], {
    parsingContext: context, filename: filename.pathname
  })());
  const oldEstimate = load => {
    const { truck } = findLoad(load.id);
    const meta = context.routeEstimateMeta(truck, load);
    return providerEstimate({ stops: load.stops, routeSignature: meta.signature, routeEstimateId: meta.id }, { version: 0 });
  };
  const setPrior = (load, { cached = false, stale = false, incomplete = false } = {}) => {
    const estimate = oldEstimate(load);
    if (stale) estimate.routeSignature = "outdated-route";
    if (incomplete) estimate.legMinutes.pop();
    load.routeEstimate = estimate;
    if (cached) {
      const meta = context.routeEstimateMeta(findLoad(load.id).truck, load);
      context.persistedRouteEstimateCache[meta.id] = { signature: meta.signature, estimate: structuredClone(estimate) };
    }
    return estimate;
  };
  return { context, state, loads, findLoad, setPrior };
}

test("Confirm refreshes unchanged cached, missing, stale and incomplete routes across every truck", async () => {
  const f = fixture({ ids: ["valid", "missing", "stale", "incomplete"] });
  f.setPrior(f.loads[0], { cached: true });
  f.setPrior(f.loads[2], { stale: true });
  f.setPrior(f.loads[3], { incomplete: true });
  const result = await f.context.refreshGoogleRouteEstimatesForConfirmation();
  assert.deepEqual(f.state.requests.map(item => item.id).sort(), ["incomplete", "missing", "stale", "valid"]);
  assert.equal(f.state.requests.length, 4, "Each eligible load must receive one fresh route request.");
  assert.ok(f.state.requests.every(item => item.body.reason === "confirm"));
  assert.deepEqual(Array.from(result.failed), []);
  const payload = f.context.trucksWithTimingMetadata();
  for (const load of payload.flatMap(truck => truck.loads)) {
    assert.equal(load.routeEstimate.source, "google");
    assert.equal(load.routeEstimate.routePath[1].lat, 43.401);
    assert.equal(load.routeEstimate.legMinutes.length, 2);
    assert.equal(load.plannedFinishMinute - load.plannedStartMinute, load.routeEstimate.totalMinutes);
  }

  const cacheOnly = fixture({ ids: ["cache-only"] });
  const cachedEstimate = cacheOnly.setPrior(cacheOnly.loads[0], { cached: true });
  delete cacheOnly.loads[0].routeEstimate;
  delete cacheOnly.context.routeEstimates[cacheOnly.loads[0].id];
  assert.equal(cacheOnly.context.estimateForLoad(cacheOnly.loads[0]), null);
  assert.equal(cachedEstimate.routePath[1].lat, 43.4);
  const cacheOnlyResult = await cacheOnly.context.refreshGoogleRouteEstimatesForConfirmation();
  assert.deepEqual(cacheOnly.state.requests.map(item => item.id), ["cache-only"],
    "Confirm must request fresh Google data even when a complete estimate exists only in persistent cache.");
  assert.equal(cacheOnly.state.requests[0].body.reason, "confirm");
  assert.deepEqual(Array.from(cacheOnlyResult.failed), []);
  const refreshedCacheOnly = cacheOnly.context.trucksWithTimingMetadata().flatMap(truck => truck.loads)[0];
  assert.equal(refreshedCacheOnly.routeEstimate.source, "google");
  assert.equal(refreshedCacheOnly.routeEstimate.routePath[1].lat, 43.401,
    "Saved geometry must come from the fresh provider response rather than the cached route.");
});

test("Confirm follows driver sequence across a truck switch and recomputes downstream departures", async () => {
  const f = fixture({ reverseTrucks: true, transport: request => response(providerEstimate(request.body,
    { legMinutes: request.id === "first" ? [45, 45] : [10, 20] })) });
  f.setPrior(f.loads[0], { cached: true });
  f.setPrior(f.loads[1], { cached: true });
  await f.context.refreshGoogleRouteEstimatesForConfirmation();
  assert.deepEqual(f.state.requests.map(item => item.id), ["first", "second"]);
  assert.match(f.state.requests[1].body.routeSignature, /start:535/);
  assert.equal(f.state.requests[1].body.departureTime, "2096-12-13T09:00:00.000Z");
  const saved = f.context.trucksWithTimingMetadata().flatMap(truck => truck.loads);
  assert.equal(saved.find(load => load.id === "second").plannedStartMinute, 535);
});

test("all refreshed mapping and timing reach both draft save and confirmation after the last response", { timeout: 5000 }, async () => {
  const entered = deferred();
  const last = deferred();
  const f = fixture({ transport: async request => {
    if (request.id === "second") { entered.resolve(); await last.promise; }
    return response(providerEstimate(request.body, { version: request.id === "first" ? 2 : 3 }));
  } });
  const pending = f.context.performDispatchPlanConfirmation();
  try {
    await entered.promise;
    assert.equal(f.state.saves.length, 0);
    assert.equal(f.state.confirms.length, 0, "Confirmation must await the complete date-plan refresh.");
  } finally { last.resolve(); }
  const result = await pending;
  assert.equal(result.status, "confirmed");
  assert.equal(f.state.saves.length, 1);
  assert.equal(f.state.confirms.length, 1);
  for (const payload of [f.state.saves[0], f.state.confirms[0].trucks]) {
    const saved = payload.flatMap(truck => truck.loads);
    assert.equal(saved.find(load => load.id === "first").routeEstimate.routePath[1].lat, 43.402);
    assert.equal(saved.find(load => load.id === "second").routeEstimate.routePath[1].lat, 43.403);
    assert.ok(saved.every(load => load.stops.every(stop => Number.isFinite(stop.timing.arrival) && Number.isFinite(stop.timing.depart))));
  }
  assert.ok(f.state.renders.length > 0, "Refreshed map geometry must schedule a visible redraw.");
});

test("budget and provider failures warn per load while retaining valid Google data and allowing Confirm", async () => {
  const f = fixture({ ids: ["valid", "missing"], transport: request => request.id === "valid"
    ? response({ ...providerEstimate(request.body), source: "fallback", fallbackReason: "hard_limit", googleAttempted: false })
    : response({ error: "Google provider unavailable" }, 503) });
  const before = structuredClone(f.setPrior(f.loads[0], { cached: true }));
  const result = await f.context.performDispatchPlanConfirmation();
  assert.equal(result.status, "confirmed", "Google failures must leave Confirm usable.");
  assert.equal(f.state.requests.length, 2);
  assert.equal(f.state.saves.length, 1);
  assert.equal(f.state.confirms.length, 1);
  assert.deepEqual(structuredClone(f.context.estimateForLoad(f.loads[0])), before, "A fallback must not overwrite a matching valid Google estimate.");
  assert.match(f.context.routeNotice, /Google/i);
  assert.match(f.context.routeNotice, /warn|unavailable|failed|could not|not refreshed|fallback/i);
  assert.ok(f.context.routeNotice.includes("Load valid") && f.context.routeNotice.includes("Load missing"), "Show each affected load to the dispatcher.");
  const saved = f.state.confirms[0].trucks.flatMap(truck => truck.loads);
  assert.equal(saved.find(load => load.id === "valid").routeEstimate.source, "google");
  assert.equal(saved.find(load => load.id === "missing").routeEstimate, undefined);
  assert.equal(f.state.scheduled.length, 0, "Denied routes must never schedule automatic paid retries.");
});

test("incomplete Google legs and network failures retain prior valid estimates and stay explicit", async () => {
  const scenarios = [
    request => response({ ...providerEstimate(request.body), legMinutes: [25] }),
    request => response({ ...providerEstimate(request.body), legMinutes: [0, 35] }),
    request => response({ ...providerEstimate(request.body), legMinutes: [Number.NaN, 35] }),
    request => response({ ...providerEstimate(request.body), source: "fallback", fallbackReason: "waypoint_cost_guard" }),
    () => { throw new Error("network unavailable"); }
  ];
  for (const transport of scenarios) {
    const f = fixture({ ids: ["retain"], transport });
    const before = structuredClone(f.setPrior(f.loads[0]));
    await f.context.performDispatchPlanConfirmation();
    const result = f.state.confirms[0].audit.details.googleRouteRefresh;
    assert.equal(f.state.requests.length, 1);
    assert.deepEqual(Array.from(result.failed, failure => failure.loadId), ["retain"]);
    assert.deepEqual(structuredClone(f.context.estimateForLoad(f.loads[0])), before);
    assert.match(f.context.routeNotice, /Google/i);
    assert.ok(f.context.routeNotice.includes("Load retain"));
    assert.equal(f.state.scheduled.length, 0);
  }
});

test("empty, single-point, read-only and zero-travel loads are skipped while duplicate zero legs remain valid", async () => {
  for (const driverOriented of [true, false]) {
    const f = fixture({ ids: ["empty", "single", "readonly", "no-travel", "duplicate"],
      transport: request => response(providerEstimate(request.body, { legMinutes: [0, 20] })) });
    f.context.driverOrientedPlanningEnabled = () => driverOriented;
    f.loads[0].stops = [];
    f.loads[1].stops = f.loads[1].stops.slice(0, 1);
    f.loads[2].mbtPlanning = true;
    f.loads[3].stops.forEach(stop => { stop.routeLocation = "same-yard"; });
    f.loads[4].stops[1].routeLocation = f.loads[4].stops[0].routeLocation;
    const result = await f.context.refreshGoogleRouteEstimatesForConfirmation();
    assert.deepEqual(f.state.requests.map(item => item.id), ["duplicate"]);
    assert.deepEqual(Array.from(result.failed), []);
    const estimate = f.context.serializableRouteEstimateForLoad(f.findLoad("duplicate").truck, f.loads[4]);
    assert.deepEqual(Array.from(estimate.legMinutes), [0, 20]);
  }
});

test("Confirm waits for an overlapping manual refresh and does not label its valid response a failure", async () => {
  const gate = deferred();
  const f = fixture({ ids: ["racing"], transport: async (request, count) => {
    if (count === 1) await gate.promise;
    return response(providerEstimate(request.body));
  } });
  const manual = f.context.googleRouteForLoad(f.findLoad("racing").truck, f.loads[0], { reason: "manual_refresh" });
  let settled = false;
  const confirm = f.context.refreshGoogleRouteEstimatesForConfirmation().then(value => { settled = true; return value; });
  try {
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    assert.equal(settled, false, "The confirmation refresh must await in-flight Google data rather than report a null result.");
  } finally { gate.resolve(); }
  await manual;
  const result = await confirm;
  assert.deepEqual(Array.from(result.failed), []);
  assert.ok(f.state.requests.length >= 1 && f.state.requests.length <= 2);
  assert.equal(f.context.serializableRouteEstimateForLoad(f.findLoad("racing").truck, f.loads[0]).source, "google");
});

test("a response for an edited route or another plan date never persists Google geometry", async () => {
  for (const edit of [f => { f.context.currentPlanDate = "2096-12-14"; },
    f => { f.loads[0].stops[1].routeLocation = "changed-destination"; }]) {
    const gate = deferred();
    const f = fixture({ ids: ["stale"], transport: async request => { await gate.promise; return response(providerEstimate(request.body)); } });
    const pending = f.context.googleRouteForLoad(f.findLoad("stale").truck, f.loads[0], { reason: "manual_refresh" });
    edit(f);
    gate.resolve();
    const result = await pending;
    assert.equal(result.estimate, null);
    assert.deepEqual(Object.keys(f.context.routeEstimates), []);
    assert.deepEqual(Object.keys(f.context.persistedRouteEstimateCache), []);
    assert.equal(f.state.cachesWritten, 0);
  }
});

test("Confirm never saves or confirms another plan/date when Google refresh completes late", { timeout: 5000 }, async () => {
  for (const switchPlan of [f => { f.context.currentPlanDate = "2096-12-14"; f.context.currentPlan.planDate = "2096-12-14"; },
    f => { f.context.currentPlan = { ...f.context.currentPlan, id: "another-plan" }; }]) {
    const entered = deferred();
    const gate = deferred();
    const f = fixture({ ids: ["switch"], transport: async request => {
      entered.resolve(); await gate.promise; return response(providerEstimate(request.body));
    } });
    const pending = f.context.performDispatchPlanConfirmation();
    await entered.promise;
    switchPlan(f);
    gate.resolve();
    await assert.rejects(pending, /plan.*changed|date.*changed|changed.*plan|changed.*date/i,
      "Changing the date or plan during Google refresh must stop this confirmation action.");
    assert.equal(f.state.saves.length, 0, "The old Confirm action must never save the newly selected plan.");
    assert.equal(f.state.confirms.length, 0, "The old Confirm action must never confirm the newly selected plan.");
    assert.equal(f.context.confirmInFlight, false);
  }
});

test("valid Google timing without map geometry stays confirmable with a per-load mapping warning", async () => {
  const f = fixture({ ids: ["mapping"], transport: request => response({
    ...providerEstimate(request.body), routePath: [], stopCoordinates: []
  }) });
  const plan = await f.context.performDispatchPlanConfirmation();
  assert.equal(plan.status, "confirmed");
  assert.equal(f.state.confirms.length, 1);
  const saved = f.state.confirms[0].trucks.flatMap(truck => truck.loads).find(load => load.id === "mapping");
  assert.equal(saved.routeEstimate.source, "google");
  assert.deepEqual(Array.from(saved.routeEstimate.legMinutes), [25, 35]);
  assert.equal(saved.plannedFinishMinute - saved.plannedStartMinute, saved.routeEstimate.totalMinutes);
  assert.match(f.context.routeNotice, /Google/i);
  assert.match(f.context.routeNotice, /map|mapping|geometry|pins/i);
  assert.ok(f.context.routeNotice.includes("Load mapping"), "Disclose the load whose map data is unavailable.");
});

test("Confirm never confirms another plan/date when the draft save acknowledgement arrives late", { timeout: 5000 }, async () => {
  for (const switchPlan of [f => { f.context.currentPlanDate = "2096-12-14"; f.context.currentPlan.planDate = "2096-12-14"; },
    f => { f.context.currentPlan = { ...f.context.currentPlan, id: "another-plan" }; }]) {
    const entered = deferred();
    const gate = deferred();
    const f = fixture({ ids: ["saving"] });
    f.context.saveCurrentPlanNow = async () => {
      f.state.saves.push({ planId: f.context.currentPlan.id, planDate: f.context.currentPlanDate,
        trucks: structuredClone(f.context.trucksWithTimingMetadata()) });
      entered.resolve(); await gate.promise; return { saved: true };
    };
    const pending = f.context.performDispatchPlanConfirmation();
    await entered.promise;
    switchPlan(f);
    gate.resolve();
    await assert.rejects(pending, /plan.*changed|date.*changed|changed.*plan|changed.*date/i,
      "A late draft acknowledgement must not permit the old Confirm action to confirm a newly selected plan.");
    assert.equal(f.state.saves.length, 1);
    assert.equal(f.state.saves[0].planId, "route-plan");
    assert.equal(f.state.saves[0].planDate, "2096-12-13");
    assert.equal(f.state.confirms.length, 0);
    assert.equal(f.context.confirmInFlight, false);
  }
});

test("normalization introduces required return routes and latest stops before the Google pass and Save", async () => {
  const f = fixture({ ids: ["existing"] });
  let normalized = false;
  f.context.normalizePlanBeforeSave = () => {
    if (normalized) return;
    normalized = true;
    f.loads[0].stops[1].routeLocation = "existing:reconciled-customer";
    const required = { id: "required-return", name: "Load required-return", driverLogin: "driver-one",
      driverSequence: 1, startMode: "auto", returnOnly: true, manual: false, stops: stopsFor("required-return") };
    f.context.trucks.find(truck => truck.id === "truck-b").loads.push(required);
    f.loads.push(required);
  };
  // The real Save payload normalizes pickups and returns before serializing.
  f.context.saveCurrentPlanNow = async () => {
    f.context.normalizePlanBeforeSave();
    f.state.saves.push(structuredClone(f.context.trucksWithTimingMetadata()));
    return { saved: true };
  };
  const plan = await f.context.performDispatchPlanConfirmation();
  assert.equal(plan.status, "confirmed");
  assert.deepEqual(f.state.requests.map(request => request.id), ["existing", "required-return"],
    "Every route materialized by normalization must receive a Google estimate before Save.");
  assert.equal(f.state.requests[0].body.stops[1].location, "existing:reconciled-customer",
    "Google must estimate the normalized latest stops rather than the earlier route shape.");
  for (const payload of [f.state.saves[0], f.state.confirms[0].trucks]) {
    const saved = payload.flatMap(truck => truck.loads);
    assert.equal(saved.length, 2);
    assert.ok(saved.every(load => load.routeEstimate?.source === "google"));
    assert.ok(saved.every(load => load.routeEstimate.stopCoordinates.length === load.stops.length));
  }
});

test("partial Google mapping retains the whole matching usable estimate and never reuses stale geometry", async () => {
  for (const stale of [false, true]) {
    const f = fixture({ ids: ["retain-map"], transport: request => response({
      ...providerEstimate(request.body, { legMinutes: [50, 60] }), routePath: [], stopCoordinates: []
    }) });
    const previous = f.setPrior(f.loads[0], { stale });
    previous.asOf = "2026-09-30T10:00:00.000Z";
    const before = structuredClone(previous);
    const plan = await f.context.performDispatchPlanConfirmation();
    assert.equal(plan.status, "confirmed");
    assert.equal(f.state.requests.length, 1);
    const estimate = structuredClone(f.context.estimateForLoad(f.loads[0]));
    const saved = f.state.confirms[0].trucks.flatMap(truck => truck.loads).find(load => load.id === "retain-map");
    if (stale) {
      assert.notEqual(estimate.routeSignature, before.routeSignature, "An outdated prior route must never supply its map geometry.");
      assert.deepEqual(estimate.legMinutes, [50, 60], "Keep valid newly returned timing when no matching prior map is usable.");
      assert.deepEqual(estimate.routePath, []);
      assert.deepEqual(saved.routeEstimate.stopCoordinates, []);
    } else {
      assert.deepEqual(estimate, before, "A partial map result must retain the entire prior valid timing and geometry.");
      assert.deepEqual(saved.routeEstimate.routePath, before.routePath);
      assert.deepEqual(saved.routeEstimate.stopCoordinates, before.stopCoordinates);
      assert.deepEqual(saved.routeEstimate.legMinutes, before.legMinutes);
      assert.equal(saved.routeEstimate.totalMinutes, before.totalMinutes);
      assert.equal(saved.routeEstimate.asOf, before.asOf, "Retained Google timing must preserve its observation timestamp.");
    }
    assert.match(f.context.routeNotice, /Google/i);
    assert.match(f.context.routeNotice, /map|mapping|geometry|pins/i);
    assert.ok(f.context.routeNotice.includes("Load retain-map"), "A retained good map must not hide the raw-response mapping warning.");
  }
});

test("the actual Confirm button retains per-load Google and post-confirmation warnings in its visible notice", { timeout: 5000 }, async () => {
  const f = fixture({ ids: ["button"], includeClickHandler: true,
    transport: () => response({ error: "Google provider unavailable" }, 503) });
  f.setPrior(f.loads[0]);
  const confirm = f.context.dispatchPlanActionRequest;
  f.context.dispatchPlanActionRequest = async (...args) => {
    const acknowledgement = await confirm(...args);
    acknowledgement.result.followupWarnings = [{ step: "driver_publish", label: "Driver publishing", message: "Temporarily unavailable" }];
    return acknowledgement;
  };
  const visible = deferred();
  f.context.render = value => {
    f.state.renders.push(value);
    if (f.state.confirms.length) visible.resolve();
  };
  const button = { dataset: { action: "confirm-plan" }, closest: () => null };
  await f.state.clickHandler({ target: { dataset: button.dataset, closest: selector => selector === "button" ? button : null } });
  await visible.promise;
  assert.equal(f.state.confirms.length, 1);
  assert.match(f.context.routeNotice, /confirmed/i);
  assert.match(f.context.routeNotice, /Google/i);
  assert.ok(f.context.routeNotice.includes("Load button"), "The button handler must retain the affected route rather than overwrite the warning.");
  assert.ok(f.context.routeNotice.includes("Driver publishing"), "Keep the existing post-confirmation warning alongside route warnings.");
  assert.equal(f.state.errors[0]?.[0], "confirmed-with-followup-warning");
  assert.equal(f.state.renders.at(-1).save, false);
});
