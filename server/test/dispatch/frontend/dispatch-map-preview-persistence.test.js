import assert from "node:assert/strict";
import test from "node:test";
import { mapFixture, mapFrontend, mapPins, roadPath } from "../../support/google-map-redraw-fixture.mjs";

function cacheFixture() {
  const fixture = mapFixture();
  const active = {};
  const cache = { "same-id": { signature: "same-route", estimate: structuredClone(fixture.state.estimate) } };
  const api = mapFrontend(["applyCachedRouteEstimate", "hydrateCachedRouteEstimates", "routeEstimateMatchesMeta", "routeEstimateHasCompleteGoogleLegs"], {
    ...fixture.dependencies,
    persistedRouteEstimateCache: cache,
    routeEstimates: active,
    estimateForLoad: (load) => active[load.id] || load.routeEstimate || null,
    samePhysicalRouteStop: () => false,
    driverOrientedPlanningEnabled: () => true,
    driverLoadEntries: () => [{ truck: fixture.truck, load: fixture.load }]
  });
  return { ...fixture, active, cache, api };
}

test("a fresh page restores cached road geometry and timing without provider requests", () => {
  const { load, active, api } = cacheFixture();
  assert.equal(api.hydrateCachedRouteEstimates(), true);
  assert.deepEqual(active[load.id].routePath, roadPath);
  assert.deepEqual(active[load.id].stopCoordinates, mapPins);
  assert.equal(active[load.id].totalMinutes, 50);
  assert.equal(api.hydrateCachedRouteEstimates(), false);
});

test("a saved timing-only estimate receives map geometry without replacing its current timing", () => {
  const { state, load, active, api } = cacheFixture();
  load.routeEstimate = { ...state.estimate, routePath: [], stopCoordinates: [], totalMinutes: 90, driveMinutes: 70, stayMinutes: 20, legMinutes: [35, 35] };
  const before = structuredClone(load.routeEstimate);
  assert.equal(api.hydrateCachedRouteEstimates(), true);
  assert.deepEqual(active[load.id], { ...before, routePath: roadPath, stopCoordinates: mapPins });
  assert.deepEqual(load.routeEstimate, before);
});

test("an already complete preview is not overwritten by an older cached route", () => {
  const { state, load, active, api } = cacheFixture();
  load.routeEstimate = { ...state.estimate, routePath: [mapPins[0], { lat: 43.5, lng: -80.4 }, ...roadPath.slice(1)] };
  assert.equal(api.hydrateCachedRouteEstimates(), false);
  assert.deepEqual(active, {});
});

test("changed route identity and incomplete legs cannot restore stale geometry", () => {
  for (const invalid of ["signature", "legs"]) {
    const { cache, active, api } = cacheFixture();
    if (invalid === "signature") { cache["same-id"].signature = "changed-date-or-stops"; }
    else { cache["same-id"].estimate.legMinutes.pop(); }
    assert.equal(api.hydrateCachedRouteEstimates(), false);
    assert.deepEqual(active, {});
  }
});

test("cached pins can restore a preview when the provider did not return road geometry", () => {
  const { state, load, cache, active, api } = cacheFixture();
  cache["same-id"].estimate.routePath = [];
  load.routeEstimate = { ...state.estimate, routePath: [], stopCoordinates: [] };
  assert.equal(api.hydrateCachedRouteEstimates(), true);
  assert.deepEqual(active[load.id].stopCoordinates, mapPins);
  assert.deepEqual(active[load.id].routePath, []);
  assert.equal(api.hydrateCachedRouteEstimates(), false);
});

test("restoration follows a driver's load sequence across trucks before matching inherited departures", () => {
  const { state, dependencies, load, truck } = mapFixture();
  const laterLoad = { ...load, id: "later-load" };
  const laterTruck = { id: "later-truck", loads: [laterLoad] };
  truck.loads = [load];
  const active = {};
  const cache = {
    first: { signature: "first", estimate: { ...state.estimate, routeSignature: "first" } },
    "later:50": { signature: "later:50", estimate: { ...state.estimate, routeSignature: "later:50" } }
  };
  const api = mapFrontend(["applyCachedRouteEstimate", "hydrateCachedRouteEstimates", "routeEstimateMatchesMeta", "routeEstimateHasCompleteGoogleLegs"], {
    ...dependencies,
    trucks: [laterTruck, truck],
    persistedRouteEstimateCache: cache,
    routeEstimates: active,
    estimateForLoad: (item) => active[item.id] || null,
    samePhysicalRouteStop: () => false,
    driverOrientedPlanningEnabled: () => true,
    driverLoadEntries: () => [{ truck, load }, { truck: laterTruck, load: laterLoad }],
    routeEstimateMeta: (_truck, item) => {
      const signature = item.id === load.id ? "first" : `later:${active[load.id]?.totalMinutes || 0}`;
      return { id: signature, signature };
    }
  });
  assert.equal(api.hydrateCachedRouteEstimates(), true);
  assert.deepEqual(Object.keys(active), [load.id, laterLoad.id]);
  assert.deepEqual(active[laterLoad.id].routePath, roadPath);
});
