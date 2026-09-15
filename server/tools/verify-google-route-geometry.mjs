import assert from "node:assert/strict";

import { googleMapsGateway } from "../src/google-maps-service.js";
import { closeDb } from "../src/db.js";

if (!process.argv.includes("--allow-one-metered-request")) {
  throw new Error("This opt-in check makes one metered Google Routes request; it never changes a dispatch plan");
}
try {
  const locations = [
    "3445 Kennedy Road, Toronto, ON",
    "2977 Cedar Creek Rd RR#1, Ayr, ON N0B 1E0",
    "141 Shearson Crescent, Cambridge, ON N1T 1J3",
    "287 Armstrong Ave, Georgetown, ON L7G 4X6",
    "2967 Kennedy Road, Toronto, ON",
    "3445 Kennedy Road, Toronto, ON"
  ];
  const result = await googleMapsGateway.estimateRoute({
    subsystem: "support_route", reason: "manual_refresh", automatic: false, trafficAware: true,
    actorId: "map-regression-verification", sessionId: "ce94489-map-geometry-20260911",
    stops: locations.map((location) => ({ location })), fallbackLegMinutes: [81, 15, 53, 76, 4], allowTolls: false
  });
  assert.equal(result.source, "google_routes_v2");
  assert.equal(result.legMinutes.length, 5);
  assert.equal(result.stopCoordinates.length, 6);
  assert.ok(result.routePath.length > 6 && result.routePath.length <= 5000);
  assert.equal(new Set(result.stopCoordinates.slice(0, 4).map(JSON.stringify)).size, 4);
  assert.ok(result.stopCoordinates.every(({ lat, lng }) => lat > 42 && lat < 45 && lng > -82 && lng < -78));
  process.stdout.write(JSON.stringify({ verified: true, meteredRouteRequests: 1, extraGeocodeRequests: 0, operationalWrites: 0, legs: result.legMinutes.length, pathPoints: result.routePath.length, stopCoordinates: result.stopCoordinates, asOf: result.asOf }) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ verified: false, errorName: error.name, code: error.code || "geometry_verification_failed" }) + "\n");
  process.exitCode = 1;
} finally { await closeDb(); }
