import assert from "node:assert/strict";
import test from "node:test";

import { createGoogleMapsGateway } from "../../../src/google-maps-gateway.js";

const fallback = Object.freeze({
  source: "fallback",
  rawLegMinutes: [30, 30],
  legMinutes: [30, 30],
  rawDriveMinutes: 60,
  driveMinutes: 60,
  stayMinutes: 10,
  totalMinutes: 70
});

function googleResponse() {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        routes: [{
          duration: "3000s",
          distanceMeters: 42_000,
          legs: [
            { duration: "1200s", distanceMeters: 18_000 },
            { duration: "1800s", distanceMeters: 24_000 }
          ]
        }]
      };
    }
  };
}

test("one multi-stop estimate makes one Routes request and returns every leg", async () => {
  const requests = [];
  const outcomes = [];
  const gateway = createGoogleMapsGateway({
    apiKey: "test-google-key",
    async admitUsage(input) { return { admitted: true, ledgerId: 7, budgetState: "normal", ...input }; },
    async recordOutcome(input) { outcomes.push(input); },
    async transport(url, options) { requests.push({ url, options }); return googleResponse(); }
  });
  const result = await gateway.estimateRoute({
    subsystem: "dispatch_route",
    reason: "confirm",
    stops: [{ location: "A" }, { location: "B" }, { location: "C" }],
    stayMinutes: [5, 5, 0],
    departureTime: "2026-09-10T12:00:00.000Z",
    fallback
  });

  assert.equal(requests.length, 1);
  assert.match(String(requests[0].url), /routes\.googleapis\.com\/directions\/v2:computeRoutes/u);
  const requestBody = JSON.parse(requests[0].options.body);
  assert.equal(requestBody.intermediates.length, 1);
  assert.equal(requestBody.routingPreference, "TRAFFIC_UNAWARE");
  assert.equal("departureTime" in requestBody, false);
  assert.deepEqual(result.rawLegMinutes, [20, 30]);
  assert.equal(result.totalMinutes, 60);
  assert.equal(result.source, "google_routes_v2");
  assert.equal(outcomes[0].outcome, "succeeded");
});

test("budget denial and Google failure return fallback without blocking", async () => {
  let requests = 0;
  const denied = createGoogleMapsGateway({
    apiKey: "test-google-key",
    async admitUsage() { return { admitted: false, reason: "hard_limit", budgetState: "exhausted" }; },
    async transport() { requests += 1; return googleResponse(); }
  });
  assert.deepEqual(await denied.estimateRoute({
    stops: [{ location: "A" }, { location: "B" }, { location: "C" }],
    fallback
  }), {
    ...fallback,
    budgetState: "exhausted",
    fallbackReason: "hard_limit",
    googleAttempted: false
  });
  assert.equal(requests, 0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(requests, 0, "A denied request must not be queued for a later paid retry.");

  const failed = createGoogleMapsGateway({
    apiKey: "test-google-key",
    async admitUsage() { return { admitted: true, ledgerId: 9, budgetState: "normal" }; },
    async recordOutcome() {},
    async transport() { throw new Error("offline"); }
  });
  const fallbackResult = await failed.estimateRoute({
    stops: [{ location: "A" }, { location: "B" }, { location: "C" }],
    fallback
  });
  assert.equal(fallbackResult.source, "fallback");
  assert.equal(fallbackResult.googleAttempted, true);
  assert.equal(fallbackResult.fallbackReason, "request_failed");
});

test("same route requests are coalesced across callers", async () => {
  let requests = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const gateway = createGoogleMapsGateway({
    apiKey: "test-google-key",
    async admitUsage() { return { admitted: true, ledgerId: 11, budgetState: "normal" }; },
    async recordOutcome() {},
    async transport() { requests += 1; await pending; return googleResponse(); }
  });
  const input = {
    subsystem: "monitor_eta",
    reason: "manual_refresh",
    stops: [{ location: "A" }, { location: "B" }],
    fallback: { ...fallback, rawLegMinutes: [30], legMinutes: [30], rawDriveMinutes: 30, driveMinutes: 30, totalMinutes: 40 }
  };
  const first = gateway.estimateRoute(input);
  const second = gateway.estimateRoute(input);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(requests, 1);
  assert.deepEqual(left, right);
});

test("manual monitor estimates reuse one paid result for fifteen minutes", async () => {
  let requests = 0;
  let current = new Date("2026-09-10T12:00:00.000Z");
  const gateway = createGoogleMapsGateway({
    apiKey: "test-google-key",
    now: () => current,
    async admitUsage() { return { admitted: true, ledgerId: requests + 1, budgetState: "normal" }; },
    async recordOutcome() {},
    async transport() { requests += 1; return googleResponse(); }
  });
  const input = {
    subsystem: "monitor_eta",
    reason: "manual_refresh",
    stops: [{ location: "A" }, { location: "B" }, { location: "C" }],
    fallback
  };
  const first = await gateway.estimateRoute(input);
  current = new Date("2026-09-10T12:14:59.000Z");
  const second = await gateway.estimateRoute(input);
  assert.equal(requests, 1);
  assert.equal(first.googleAttempted, true);
  assert.equal(second.googleAttempted, false);
  assert.equal(second.fallbackReason, "cooldown_reuse");
  current = new Date("2026-09-10T12:15:01.000Z");
  const third = await gateway.estimateRoute(input);
  assert.equal(requests, 2);
  assert.equal(third.googleAttempted, true);
});

test("invalid coordinates fall back before quota admission or network work", async () => {
  let admissions = 0;
  let requests = 0;
  const gateway = createGoogleMapsGateway({
    apiKey: "test-google-key",
    async admitUsage() { admissions += 1; return { admitted: true, ledgerId: 1, budgetState: "normal" }; },
    async transport() { requests += 1; return googleResponse(); }
  });
  const result = await gateway.estimateRoute({
    stops: [{ latitude: 43.8, longitude: -79.4 }, { latitude: 200, longitude: -79.3 }],
    stayMinutes: [7, 9],
    fallbackLegMinutes: [20]
  });
  assert.equal(admissions, 0);
  assert.equal(requests, 0);
  assert.equal(result.source, "fallback");
  assert.equal(result.fallbackReason, "invalid_stops");
  assert.equal(result.stayMinutes, 16);
});

test("high-cost waypoint and traffic features require an explicit refresh", async () => {
  const requests = [];
  const gateway = createGoogleMapsGateway({
    apiKey: "test-google-key",
    async admitUsage() { return { admitted: true, ledgerId: requests.length + 1, budgetState: "normal" }; },
    async recordOutcome() {},
    async transport(_url, options) {
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            routes: [{
              duration: "780s",
              distanceMeters: 13_000,
              legs: Array.from({ length: 13 }, () => ({ duration: "60s", distanceMeters: 1_000 }))
            }]
          };
        }
      };
    }
  });
  const stops = Array.from({ length: 14 }, (_, index) => ({ location: `Stop ${index}` }));
  const guarded = await gateway.estimateRoute({ stops });
  assert.equal(guarded.fallbackReason, "waypoint_cost_guard");
  assert.equal(requests.length, 0);
  const explicit = await gateway.estimateRoute({ stops, trafficAware: true, reason: "manual_refresh" });
  assert.equal(explicit.source, "google_routes_v2");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].routingPreference, "TRAFFIC_AWARE");
  assert.match(requests[0].departureTime, /^\d{4}-\d{2}-\d{2}T/u);
});

test("invalid Google route output is recorded and replaced with fallback", async () => {
  const outcomes = [];
  const gateway = createGoogleMapsGateway({
    apiKey: "test-google-key",
    async admitUsage() { return { admitted: true, ledgerId: 33, budgetState: "normal" }; },
    async recordOutcome(value) { outcomes.push(value); },
    async transport() {
      return { ok: false, status: 429, async json() { return { routes: [] }; } };
    }
  });
  const result = await gateway.estimateRoute({
    stops: [{ location: "A" }, { location: "B" }],
    fallbackLegMinutes: [22]
  });
  assert.equal(result.source, "fallback");
  assert.equal(result.fallbackReason, "invalid_response");
  assert.equal(result.googleAttempted, true);
  assert.equal(outcomes[0].outcome, "invalid_response");
  assert.equal(outcomes[0].httpStatus, 429);
});

test("missing configuration and accounting failures never call Google", async () => {
  let requests = 0;
  const unconfigured = createGoogleMapsGateway({
    async transport() { requests += 1; return googleResponse(); }
  });
  assert.equal((await unconfigured.estimateRoute({ stops: ["A", "B"] })).fallbackReason, "not_configured");

  const unavailableAccounting = createGoogleMapsGateway({
    apiKey: "test-google-key",
    async admitUsage() { throw new Error("database unavailable"); },
    async transport() { requests += 1; return googleResponse(); }
  });
  const denied = await unavailableAccounting.estimateRoute({ stops: ["A", "B"] });
  assert.equal(denied.fallbackReason, "accounting_unavailable");
  assert.equal(requests, 0);
});

test("geocoding is metered, range checked, and fail-safe", async () => {
  const outcomes = [];
  const requests = [];
  const gateway = createGoogleMapsGateway({
    apiKey: "test-google-key",
    async admitUsage(input) { return { admitted: true, ledgerId: 41, budgetState: "normal", input }; },
    async recordOutcome(value) { outcomes.push(value); },
    async transport(url) {
      requests.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() { return { results: [{ geometry: { location: { lat: 43.8, lng: -79.4 } } }] }; }
      };
    }
  });
  assert.equal(await gateway.geocode({ address: "" }), null);
  const point = await gateway.geocode({ address: "100 Queen St" });
  assert.deepEqual(point, {
    latitude: 43.8,
    longitude: -79.4,
    source: "google_geocode",
    budgetState: "normal"
  });
  assert.match(requests[0], /maps\.googleapis\.com\/maps\/api\/geocode\/json/u);
  assert.match(requests[0], /components=country%3ACA/u);
  assert.equal(outcomes[0].outcome, "succeeded");

  const invalid = createGoogleMapsGateway({
    apiKey: "test-google-key",
    async admitUsage() { return { admitted: true, ledgerId: 42, budgetState: "normal" }; },
    async recordOutcome(value) { outcomes.push(value); },
    async transport() {
      return {
        ok: true,
        status: 200,
        async json() { return { results: [{ geometry: { location: { lat: 143.8, lng: -79.4 } } }] }; }
      };
    }
  });
  assert.equal(await invalid.geocode({ address: "Outside range" }), null);
  assert.equal(outcomes.at(-1).outcome, "invalid_response");

  const denied = createGoogleMapsGateway({
    apiKey: "test-google-key",
    async admitUsage() { return { admitted: false }; },
    async transport() { throw new Error("must not run"); }
  });
  assert.equal(await denied.geocode({ address: "No quota" }), null);
});

test("timeouts are labelled and duplicate consecutive waypoints keep a zero leg", async () => {
  const outcomes = [];
  const timedOut = createGoogleMapsGateway({
    apiKey: "test-google-key",
    async admitUsage() { return { admitted: true, ledgerId: 51, budgetState: "normal" }; },
    async recordOutcome(value) { outcomes.push(value); },
    async transport() {
      const error = new Error("timed out");
      error.name = "AbortError";
      throw error;
    }
  });
  const timeout = await timedOut.estimateRoute({ stops: ["A", "B"] });
  assert.equal(timeout.fallbackReason, "timeout");
  assert.equal(outcomes[0].outcome, "timeout");

  const duplicate = createGoogleMapsGateway({
    apiKey: "test-google-key",
    async admitUsage() { return { admitted: true, ledgerId: 52, budgetState: "normal" }; },
    async recordOutcome() {},
    async transport() { return googleResponse(); }
  });
  const result = await duplicate.estimateRoute({
    stops: [{ location: "A" }, { location: "A" }, { location: "C" }],
    travelTimePercent: 25
  });
  assert.deepEqual(result.rawLegMinutes, [0, 30]);
  assert.deepEqual(result.legMinutes, [0, 38]);
});

test("runtime key and mode providers are resolved for every new request", async () => {
  let key = "first-key";
  let mode = "normal";
  const admissions = [];
  const headers = [];
  const gateway = createGoogleMapsGateway({
    apiKey: () => key,
    mode: () => mode,
    async admitUsage(input) { admissions.push(input); return { admitted: true, ledgerId: admissions.length, budgetState: "normal" }; },
    async recordOutcome() {},
    async transport(_url, options) { headers.push(options.headers["X-Goog-Api-Key"]); return googleResponse(); }
  });
  await gateway.estimateRoute({ stops: ["A", "B", "C"], fingerprint: "first" });
  key = "second-key";
  mode = "disabled";
  await gateway.estimateRoute({ stops: ["A", "B", "C"], fingerprint: "second" });
  assert.deepEqual(headers, ["first-key", "second-key"]);
  assert.deepEqual(admissions.map((entry) => entry.mode), ["normal", "disabled"]);
});
