import assert from "node:assert/strict";
import test from "node:test";

import { createGoogleMapsGateway } from "../../../src/google-maps-gateway.js";

const stops = [{ location: "Ayr Yard - Unilock" }, { location: "141 Shearson Crescent, Cambridge, ON N1T 1J3" }, { location: "UNILOCK Georgetown" }];
const pins = [{ lat: 43.3, lng: -80.45 }, { lat: 43.405, lng: -80.3 }, { lat: 43.65, lng: -79.91 }];
const path = [pins[0], { lat: 43.35, lng: -80.4 }, pins[1], { lat: 43.51, lng: -80.1 }, pins[2]];
const location = ({ lat, lng }) => ({ latLng: { latitude: lat, longitude: lng } });

function googleRoute() {
  return {
    duration: "3000s", distanceMeters: 42000,
    polyline: { geoJsonLinestring: { type: "LineString", coordinates: path.map(({ lat, lng }) => [lng, lat]) } },
    legs: pins.slice(1).map((point, index) => ({
      duration: "1500s", distanceMeters: 21000,
      startLocation: location(pins[index]), endLocation: location(point)
    }))
  };
}

function setup(route = googleRoute(), { admitted = true } = {}) {
  const calls = [];
  const admissions = [];
  const gateway = createGoogleMapsGateway({
    apiKey: "test-route-map-key",
    async admitUsage(input) { admissions.push(input); return { admitted, ledgerId: 1, budgetState: "normal", reason: admitted ? "within_budget" : "hard_limit" }; },
    async transport(url, options) {
      calls.push({ url, options });
      return { ok: true, status: 200, async json() { return { routes: [route] }; } };
    }
  });
  return { gateway, calls, admissions };
}

test("GMAP-01: one budgeted estimate includes road geometry and ordered Google pin positions", async () => {
  const { gateway, calls, admissions } = setup();
  const result = await gateway.estimateRoute({ stops, subsystem: "dispatch_route", reason: "manual_refresh", trafficAware: true });
  assert.equal(calls.length, 1);
  assert.equal(admissions.length, 1);
  const body = JSON.parse(calls[0].options.body);
  const mask = calls[0].options.headers["X-Goog-FieldMask"].split(",");
  assert.ok(mask.includes("routes.polyline.geoJsonLinestring"));
  assert.ok(mask.includes("routes.legs.startLocation"));
  assert.ok(mask.includes("routes.legs.endLocation"));
  assert.equal(body.polylineEncoding, "GEO_JSON_LINESTRING");
  assert.equal(body.polylineQuality, "OVERVIEW");
  assert.equal(body.optimizeWaypointOrder, undefined);
  assert.equal(body.extraComputations, undefined);
  assert.deepEqual(body.intermediates, [{ address: stops[1].location }]);
  assert.equal(result.source, "google_routes_v2");
  assert.deepEqual(result.routePath, path);
  assert.deepEqual(result.stopCoordinates, pins);
  assert.deepEqual(result.legMinutes, [25, 25]);
});

test("GMAP-05: invalid geometry is omitted without discarding valid timing or retrying Google", async () => {
  const route = googleRoute();
  route.polyline.geoJsonLinestring.coordinates[1] = [-80.4, null];
  route.legs[1].endLocation.latLng.latitude = 999;
  const { gateway, calls } = setup(route);
  const result = await gateway.estimateRoute({ stops });
  assert.equal(result.source, "google_routes_v2");
  assert.deepEqual(result.legMinutes, [25, 25]);
  assert.deepEqual(result.routePath, []);
  assert.deepEqual(result.stopCoordinates, []);
  assert.equal(calls.length, 1);
});

test("GMAP-05: geometry over 5000 points is rejected as a whole, not silently truncated", async () => {
  const route = googleRoute();
  route.polyline.geoJsonLinestring.coordinates = Array.from({ length: 5001 }, () => [-80.4, 43.3]);
  const { gateway, calls } = setup(route);
  const result = await gateway.estimateRoute({ stops });
  assert.equal(result.source, "google_routes_v2");
  assert.deepEqual(result.routePath, []);
  assert.deepEqual(result.stopCoordinates, pins);
  assert.equal(calls.length, 1);
});

test("GMAP-01/05: denied geometry estimates make no Google or per-stop geocoding calls", async () => {
  const { gateway, calls } = setup(googleRoute(), { admitted: false });
  const result = await gateway.estimateRoute({ stops });
  assert.equal(result.source, "fallback");
  assert.equal(calls.length, 0);
  assert.equal(result.googleAttempted, false);
});
