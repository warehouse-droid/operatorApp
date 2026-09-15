import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";
import { createGoogleMapsGateway } from "../../../src/google-maps-gateway.js";
import { mapFrontend } from "../../support/google-map-redraw-fixture.mjs";

const point = fc.tuple(fc.integer({ min: -9000000, max: 9000000 }), fc.integer({ min: -18000000, max: 18000000 }))
  .map(([lat, lng]) => ({ lat: lat / 100000, lng: lng / 100000 }));
const points = fc.array(point, { minLength: 2, maxLength: 25 });
const frontend = mapFrontend(["normalizedRouteMapGeometry"]);

function response(pins, coordinates = pins.map(({ lat, lng }) => [lng, lat])) {
  const location = ({ lat, lng }) => ({ latLng: { latitude: lat, longitude: lng } });
  return { routes: [{
    distanceMeters: 1000, polyline: { geoJsonLinestring: { type: "LineString", coordinates } },
    legs: pins.slice(1).map((end, index) => ({ duration: "600s", startLocation: location(pins[index]), endLocation: location(end) }))
  }] };
}

async function estimate(pins, payload) {
  let calls = 0;
  const gateway = createGoogleMapsGateway({
    apiKey: "test-property-boundary", admitUsage: async () => ({ admitted: true }),
    transport: async () => { calls += 1; return { ok: true, json: async () => payload }; }
  });
  const result = await gateway.estimateRoute({ trafficAware: true, stops: pins.map((_, index) => ({ location: `Stop ${index}` })) });
  assert.equal(calls, 1);
  assert.equal(result.source, "google_routes_v2");
  return result;
}

test("GMAP-01/03/04 property: all bounded coordinates keep lat/lng and stop order through gateway and browser serialization", async () => {
  await fc.assert(fc.asyncProperty(points, async (pins) => {
    const result = await estimate(pins, response(pins));
    assert.deepEqual(result.routePath, pins);
    assert.deepEqual(result.stopCoordinates, pins);
    const serialized = frontend.normalizedRouteMapGeometry(JSON.parse(JSON.stringify(result)), pins.length);
    assert.deepEqual(serialized, { routePath: pins, stopCoordinates: pins });
    assert.notEqual(serialized.routePath, result.routePath);
  }), { seed: 20260911, numRuns: 150 });
});

test("GMAP-05 property: hostile geometry is rejected completely while timing and valid ordered pins survive", async () => {
  const invalid = fc.constantFrom(null, undefined, "43.5", Number.NaN, Number.POSITIVE_INFINITY, 91, -91, {}, []);
  await fc.assert(fc.asyncProperty(points, invalid, async (pins, badLatitude) => {
    const payload = response(pins);
    payload.routes[0].polyline.geoJsonLinestring.coordinates[0][1] = badLatitude;
    const result = await estimate(pins, payload);
    assert.deepEqual(result.routePath, []);
    assert.deepEqual(result.stopCoordinates, pins);
    assert.equal(result.legMinutes.length, pins.length - 1);
    const browser = frontend.normalizedRouteMapGeometry({ routePath: [{ lat: badLatitude, lng: 0 }, pins[0]], stopCoordinates: pins }, pins.length);
    assert.deepEqual(browser.routePath, []);
    assert.deepEqual(browser.stopCoordinates, pins);
  }), { seed: 20260912, numRuns: 150 });
});

test("GMAP-05 property: the browser requires the exact stop count and drops untrusted extra fields", () => {
  fc.assert(fc.property(points, (pins) => {
    assert.deepEqual(frontend.normalizedRouteMapGeometry({ routePath: pins, stopCoordinates: pins.slice(1) }, pins.length).stopCoordinates, []);
    const withExtras = pins.map((pin) => ({ ...pin, html: "<script>untrusted</script>", arbitrary: [1, 2, 3] }));
    assert.deepEqual(frontend.normalizedRouteMapGeometry({ routePath: withExtras, stopCoordinates: withExtras }, pins.length), { routePath: pins, stopCoordinates: pins });
    assert.deepEqual(frontend.normalizedRouteMapGeometry({ routePath: Array.from({ length: 5001 }, () => pins[0]), stopCoordinates: pins }, pins.length).routePath, []);
  }), { seed: 20260913, numRuns: 150 });
});

test("GMAP-05: exactly 5000 provider path points are accepted; 5001 are rejected without truncation", async () => {
  const pins = [{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }];
  const accepted = await estimate(pins, response(pins, Array.from({ length: 5000 }, () => [0, 0])));
  assert.equal(accepted.routePath.length, 5000);
  const rejected = await estimate(pins, response(pins, Array.from({ length: 5001 }, () => [0, 0])));
  assert.deepEqual(rejected.routePath, []);
  assert.deepEqual(rejected.stopCoordinates, pins);
});
