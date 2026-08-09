import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { config } from "./config.js";
import { listSamsaraVehicleLocations } from "./samsara.js";

const serverSource = await fs.readFile(new URL("./server.js", import.meta.url), "utf8");
const samsaraSource = await fs.readFile(new URL("./samsara.js", import.meta.url), "utf8");

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing source section: ${start}`);
  const endIndex = end ? source.indexOf(end, startIndex + start.length) : source.length;
  assert.notEqual(endIndex, -1, `Missing source section terminator: ${end}`);
  return source.slice(startIndex, endIndex);
}

const locationCheckSource = sourceSection(
  serverSource,
  "async function checkDriverJobLocation(job)",
  "function emitAppEvent("
);
assert.match(
  locationCheckSource,
  /Promise\.allSettled\(\[\s*samsaraLocationForDriverJob\(job\),\s*expectedPointForDriverJob\(job\)/,
  "Truck GPS and expected-stop resolution must run concurrently."
);
assert.match(
  locationCheckSource,
  /lookupErrors\.length[\s\S]{0,260}status:\s*"unavailable"/,
  "External location lookup failures must become an overridable unavailable result."
);

const completionRoute = sourceSection(
  serverSource,
  'app.post("/api/driver/jobs/:jobId/photos",',
  'app.get("/api/operators",'
);
assert.match(
  completionRoute,
  /locationCheck\.status !== "ok" && !req\.body\?\.locationOverride/,
  "The completion endpoint must permit an explicit override after an unavailable GPS result."
);

const geocodeSource = sourceSection(
  serverSource,
  "async function geocodeStopAddress(address)",
  "async function expectedPointForDriverJob(job)"
);
assert.match(
  geocodeSource,
  /setTimeout\(\(\) => timeoutController\.abort\(\), DRIVER_GEOCODE_TIMEOUT_MS\)/,
  "Google geocoding must have a bounded timeout."
);
const coordinateSource = sourceSection(
  serverSource,
  "function validCoordinate(latitude, longitude)",
  "async function geocodeStopAddress(address)"
);
assert.match(
  coordinateSource,
  /latitude === null[\s\S]{0,180}longitude === null/,
  "Missing Samsara coordinates must not be coerced to the valid coordinate 0,0."
);

const nextJobRoute = sourceSection(
  serverSource,
  'app.get("/api/driver/next-job",',
  'app.post("/api/driver/rest/start",'
);
assert.match(
  nextJobRoute,
  /const \[state, jobContext, rest\] = await Promise\.all\(\[[\s\S]{0,360}getDriverDayState[\s\S]{0,360}getDriverNextJobContext[\s\S]{0,180}getActiveDriverRest/,
  "Independent next-job state, job, and rest reads must run concurrently."
);
assert.match(
  nextJobRoute,
  /res\.json\(\{[\s\S]*?state,[\s\S]*?job: presentedJob,[\s\S]*?rest,[\s\S]*?restSummary,[\s\S]*?pendingCompletion,[\s\S]*?routeBootstrap,[\s\S]*?offlineEnabled: driverMode\.enabled,[\s\S]*?offlineModeRevision: driverMode\.revision[\s\S]*?\}\)/,
  "The next-job response must return the dependency-reviewed job, day state, cross-device completion guard, offline bootstrap, and mode metadata."
);

assert.match(
  samsaraSource,
  /normalizedMethod === "GET" \? new AbortController\(\) : null/,
  "Samsara GET requests must have a bounded timeout without timing out writes of unknown outcome."
);
assert.match(
  samsaraSource,
  /if \(wantedPlates\.size && !filteredVehicles\.length\) return \[\];/,
  "An unmatched requested plate must not trigger an unfiltered all-fleet location request."
);

const originalFetch = globalThis.fetch;
const originalToken = config.samsara.apiToken;
const calls = [];
config.samsara.apiToken = "driver-location-reliability-test";
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  calls.push({ url, signal: options.signal });
  assert.ok(options.signal, `Samsara GET did not include a timeout signal: ${url}`);
  if (url.includes("/fleet/vehicles?")) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        data: [{ id: "vehicle-1", name: "Test Truck", licensePlate: "TEST 123" }],
        pagination: { hasNextPage: false }
      })
    };
  }
  if (url.includes("/fleet/vehicles/locations?")) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        data: [{
          vehicle: { id: "vehicle-1", name: "Test Truck", licensePlate: "TEST 123" },
          gps: { latitude: 43.7, longitude: -79.4, time: "2026-07-30T12:00:00.000Z" }
        }],
        pagination: { hasNextPage: false }
      })
    };
  }
  throw new Error(`Unexpected Samsara test request: ${url}`);
};

try {
  const first = await listSamsaraVehicleLocations({ plates: ["TEST123"] });
  const second = await listSamsaraVehicleLocations({ plates: ["TEST 123"] });
  const unmatched = await listSamsaraVehicleLocations({ plates: ["MISSING"] });

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.deepEqual(unmatched, []);
  assert.equal(
    calls.filter((call) => call.url.includes("/fleet/vehicles?")).length,
    1,
    "The short-lived vehicle roster cache was not reused."
  );
  assert.equal(
    calls.filter((call) => call.url.includes("/fleet/vehicles/locations?")).length,
    2,
    "An unmatched plate triggered an unnecessary all-fleet location request."
  );
} finally {
  globalThis.fetch = originalFetch;
  config.samsara.apiToken = originalToken;
}

console.log("Driver location reliability harness passed.");
