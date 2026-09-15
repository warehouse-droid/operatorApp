import assert from "node:assert/strict";
import test from "node:test";

import { mapFixture, mapFrontend, mapPins, roadPath, mapRenderFunctions } from "../../support/google-map-redraw-fixture.mjs";

test("GMAP-02/03: the map draws road geometry and ordered Google pins, not identical schematic coordinates", async () => {
  const { state, dependencies } = mapFixture();
  const api = mapFrontend(mapRenderFunctions, dependencies);
  await api.renderGoogleMapPreview();
  assert.deepEqual(state.paths.at(-1).path, roadPath);
  assert.deepEqual(state.markers.filter((marker) => marker.map).map((marker) => marker.position), mapPins);
  assert.equal(state.maps.length, 1);
  assert.equal(state.admissions, 1);
});

test("GMAP-02: refresh with unchanged timing redraws overlays on the exact retained map without another admission", async () => {
  const { state, dependencies } = mapFixture();
  const api = mapFrontend(mapRenderFunctions, dependencies);
  await api.renderGoogleMapPreview();
  const captured = api.captureGoogleMapPreviewState();
  const nextPath = [mapPins[0], { lat: 43.4, lng: -80.43 }, ...roadPath.slice(1)];
  state.estimate = { ...state.estimate, routePath: nextPath };
  assert.equal(api.restoreGoogleMapPreviewState(captured), true);
  assert.equal(state.canvas, captured.canvas);
  assert.deepEqual(state.paths.at(-1).path, nextPath);
  assert.equal(state.paths.filter((path) => path.map).length, 1);
  assert.equal(state.markers.filter((marker) => marker.map).length, 3);
  assert.equal(state.maps.length, 1);
  assert.equal(state.admissions, 1);
});

test("GMAP-04: cache and plan serialization retain validated path and pin arrays", () => {
  const { state, dependencies, truck, load } = mapFixture();
  const cache = {};
  const api = mapFrontend(["cacheRouteEstimate", "serializableRouteEstimateForLoad", "routeEstimateMatchesMeta", "routeEstimateHasCompleteGoogleLegs"], {
    ...dependencies, persistedRouteEstimateCache: cache, savePersistedRouteEstimateCache() {},
    samePhysicalRouteStop: () => false
  });
  const cached = api.cacheRouteEstimate(truck, load, load.stops, state.estimate);
  const serialized = api.serializableRouteEstimateForLoad(truck, load);
  assert.deepEqual(cached.estimate.routePath, roadPath);
  assert.deepEqual(serialized.routePath, roadPath);
  assert.deepEqual(cached.estimate.stopCoordinates, mapPins);
  assert.deepEqual(serialized.stopCoordinates, mapPins);
});

test("GMAP-02: geometry-only estimate changes trigger redraw while identical estimates remain quiet", () => {
  const { state } = mapFixture();
  const { routeEstimateChangesVisibleTiming: changed } = mapFrontend(["routeEstimateChangesVisibleTiming"]);
  const estimate = state.estimate;
  assert.equal(changed(estimate, null), false);
  assert.equal(changed(null, estimate), true);
  assert.equal(changed(estimate, structuredClone(estimate)), false);
  assert.equal(changed(estimate, { ...estimate, routePath: [mapPins[0], { lat: 43.4, lng: -80.43 }, ...roadPath.slice(1)] }), true);
  assert.equal(changed(estimate, { ...estimate, stopCoordinates: [{ lat: 43.31, lng: -80.45 }, ...mapPins.slice(1)] }), true);
  assert.equal(changed(estimate, { ...estimate, allowTolls: true }), true);
  assert.equal(changed(estimate, { ...estimate, totalMinutes: estimate.totalMinutes + 1 }), true);
  assert.equal(changed({}, { routePath: [], stopCoordinates: [] }), false);
});

test("GMAP-05: a stale or malformed Google estimate stays explicitly approximate without paid retries", async () => {
  for (const override of [{ routeSignature: "other-route" }, { stopCoordinates: mapPins.slice(1) }, { routePath: [{ lat: null, lng: -80 }, mapPins[0]] }]) {
    const { state, dependencies } = mapFixture();
    state.estimate = { ...state.estimate, ...override };
    await mapFrontend(mapRenderFunctions, dependencies).renderGoogleMapPreview();
    assert.match(state.status.textContent, /approximate|unavailable/iu);
    assert.notEqual(state.canvas.dataset.dispatchGeometrySource, "google_route");
    assert.equal(state.admissions, 1);
  }
});

test("GMAP-04/07: an in-flight estimate for an edited route cannot relabel old geometry with the new identity", async () => {
  const { load, truck, state, dependencies } = mapFixture();
  let resolveResponse;
  const gate = new Promise((resolve) => { resolveResponse = resolve; });
  const estimates = {};
  const api = mapFrontend(["googleRouteForLoad", "applyServerRouteEstimate", "routeEstimateHasCompleteGoogleLegs"], {
    ...dependencies, findLoad: () => ({ load, truck }), currentPlan: { id: 323 }, currentPlanDate: "2026-09-11",
    routeEstimateMeta: (_truck, _load, stops) => ({ id: JSON.stringify(stops), signature: JSON.stringify(stops), loadStart: 390 }),
    backgroundRouteInFlight: new Set(), truckTravelTimePercent: () => 30,
    fetch: async () => { await gate; return { ok: true, json: async () => state.estimate }; },
    fallbackLegMinutesForRouteStops: () => [30, 30], plannedDepartureDate: () => new Date("2026-09-11T10:30:00Z"),
    dispatchSessionId: "test-session", samePhysicalRouteStop: () => false,
    routeEstimates: estimates, cacheRouteEstimate() { throw new Error("stale response must not be persisted"); }
  });
  const pending = api.googleRouteForLoad(truck, load, { reason: "manual_refresh" });
  load.stops = load.stops.map((stop, index) => index === 1 ? { ...stop, routeLocation: "New location" } : stop);
  resolveResponse();
  const result = await pending;
  assert.equal(result.estimate, null);
  assert.deepEqual(estimates, {});
});

test("GMAP-02/05: an unchanged preview reuses overlays and a denied map remains clearly unavailable", async () => {
  const { state, dependencies } = mapFixture();
  const api = mapFrontend(mapRenderFunctions, dependencies);
  await api.renderGoogleMapPreview();
  const pathCount = state.paths.length;
  api.restoreGoogleMapPreviewState(api.captureGoogleMapPreviewState());
  assert.equal(state.paths.length, pathCount);
  assert.equal(state.admissions, 1);
  const denied = mapFixture();
  denied.dependencies.loadGoogleMaps = async () => false;
  await mapFrontend(mapRenderFunctions, denied.dependencies).renderGoogleMapPreview();
  assert.match(denied.state.canvas.textContent, /map unavailable/iu);
  assert.equal(denied.state.maps.length, 0);
});

test("GMAP-05: valid road-matched pins remain useful when the provider omits its road path", async () => {
  const { state, dependencies } = mapFixture();
  state.estimate.routePath = [];
  await mapFrontend(mapRenderFunctions, dependencies).renderGoogleMapPreview();
  assert.equal(state.canvas.dataset.dispatchGeometrySource, "google_stops");
  assert.match(state.status.textContent, /geometry unavailable/iu);
  assert.deepEqual(state.markers.filter((marker) => marker.map).map((marker) => marker.position), mapPins);
  assert.equal(state.paths.at(-1).geodesic, true);
});

test("GMAP-04: a replaced canvas or changed selection cannot receive an old map", async () => {
  const { state, dependencies, load } = mapFixture();
  const api = mapFrontend(mapRenderFunctions, dependencies);
  const pending = api.renderGoogleMapPreview();
  state.canvas = { dataset: {} };
  await pending;
  assert.equal(state.maps.length, 0);
  await api.renderGoogleMapPreview();
  const captured = api.captureGoogleMapPreviewState();
  load.id = "another-load";
  assert.equal(api.restoreGoogleMapPreviewState(captured), false);
  api.updateGoogleMapPreviewGeometry(captured.canvas);
  assert.equal(state.paths.length, 1);
  api.updateGoogleMapPreviewGeometry({ dataset: {} });
  dependencies.selectedLoad = () => ({ load: null });
  mapFrontend(mapRenderFunctions, dependencies).updateGoogleMapPreviewGeometry(state.canvas);
  assert.equal(state.paths.length, 1);
});

test("GMAP-04/07: success, plan replacement, removed load, invalid legs and HTTP failure have explicit write boundaries", async () => {
  for (const scenario of ["success", "plan-replaced", "load-removed", "invalid-legs", "http-failure"]) {
    const { state, dependencies, load, truck } = mapFixture();
    const plan = { id: 323 };
    let selected = { load, truck };
    let finish;
    const gate = new Promise((resolve) => { finish = resolve; });
    const estimates = {};
    const cached = [];
    const inFlight = new Set();
    const api = mapFrontend(["googleRouteForLoad", "applyServerRouteEstimate", "routeEstimateHasCompleteGoogleLegs"], {
      ...dependencies, findLoad: () => selected, currentPlan: plan, currentPlanDate: "2026-09-11",
      backgroundRouteInFlight: inFlight, truckTravelTimePercent: () => 30,
      fetch: async () => { await gate; return { ok: scenario !== "http-failure", json: async () => state.estimate }; },
      dispatchErrorMessage: async () => "HTTP failed", fallbackLegMinutesForRouteStops: () => [30, 30],
      plannedDepartureDate: () => new Date("2026-09-11T10:30:00Z"), dispatchSessionId: "test-session",
      samePhysicalRouteStop: () => false, routeEstimates: estimates,
      cacheRouteEstimate: (...args) => cached.push(args.at(-1))
    });
    const pending = api.googleRouteForLoad(truck, load, { reason: "manual_refresh" });
    if (scenario === "plan-replaced") { plan.id = 324; }
    if (scenario === "load-removed") { selected = {}; }
    if (scenario === "invalid-legs") { state.estimate.legMinutes = []; }
    finish();
    const result = await pending;
    assert.equal(inFlight.size, 0);
    if (scenario === "success") {
      assert.deepEqual(estimates[load.id].routePath, roadPath);
      assert.deepEqual(cached[0].stopCoordinates, mapPins);
      assert.equal(cached.length, 1);
    } else {
      assert.equal(result.estimate, null);
      assert.deepEqual(estimates, {});
      assert.deepEqual(cached, []);
    }
  }
});
