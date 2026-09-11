import assert from "node:assert/strict";
import test from "node:test";

import {
  GOOGLE_MAPS_USAGE_LIMITS,
  buildFallbackRoutePreview,
  googleMapsAdmissionDecision,
  googleMapsRouteFingerprint,
  validateRoutePreview
} from "../../../src/google-maps-usage-policy.js";

test("normal, reserve, and hard budget boundaries leave 500 units of safety headroom", () => {
  assert.equal(GOOGLE_MAPS_USAGE_LIMITS.normalLimit, 4_000);
  assert.equal(GOOGLE_MAPS_USAGE_LIMITS.hardLimit, 4_500);
  assert.equal(GOOGLE_MAPS_USAGE_LIMITS.consoleTarget, 5_000);

  assert.equal(googleMapsAdmissionDecision({ rollingUsage: 2_999, subsystemUsage: 0 }).admitted, true);
  assert.equal(googleMapsAdmissionDecision({ rollingUsage: 3_500, automatic: true }).admitted, false);
  assert.equal(googleMapsAdmissionDecision({ rollingUsage: 4_000, reason: "confirm" }).admitted, true);
  assert.equal(googleMapsAdmissionDecision({ rollingUsage: 4_000, reason: "background" }).admitted, false);
  assert.equal(googleMapsAdmissionDecision({ rollingUsage: 4_499, reason: "manual_refresh" }).admitted, true);
  assert.equal(googleMapsAdmissionDecision({ rollingUsage: 4_500, reason: "confirm" }).admitted, false);
  assert.equal(googleMapsAdmissionDecision({ rollingUsage: 4_499, units: 2, reason: "confirm" }).admitted, false);
  assert.equal(googleMapsAdmissionDecision({ mode: "disabled", rollingUsage: 0, reason: "confirm" }).reason, "disabled");
  assert.equal(googleMapsAdmissionDecision({ mode: "conserve", rollingUsage: 0, automatic: true }).reason, "automatic_disabled");
  assert.equal(googleMapsAdmissionDecision({
    mode: "normal",
    subsystem: "dynamic_map",
    subsystemUsage: 300,
    automatic: true
  }).reason, "subsystem_limit");
});

test("fallback previews always contain finite ordered leg and total minutes", () => {
  const preview = buildFallbackRoutePreview({
    stops: [
      { location: "Yard A", stayMinutes: 5 },
      { location: "Customer", stayMinutes: 10 },
      { location: "Customer", stayMinutes: 0 },
      { location: "Yard B", stayMinutes: 3 }
    ],
    fallbackLegMinutes: [20, Number.NaN, -10],
    travelTimePercent: 10,
    allowTolls: false
  });

  assert.deepEqual(preview.rawLegMinutes, [20, 0, 30]);
  assert.deepEqual(preview.legMinutes, [22, 0, 33]);
  assert.equal(preview.driveMinutes, 55);
  assert.equal(preview.stayMinutes, 18);
  assert.equal(preview.totalMinutes, 73);
  assert.equal(preview.source, "fallback");
  assert.deepEqual(validateRoutePreview(preview, { stopCount: 4 }), { valid: true, issues: [] });
});

test("route fingerprints normalize cosmetic address changes but detect route changes", () => {
  const base = {
    stops: [{ location: " 3445 Kennedy RD " }, { location: "100 Queen St., Toronto" }],
    departureTime: "2026-09-10T10:01:00.000Z",
    allowTolls: false
  };
  const sameBucket = googleMapsRouteFingerprint({
    ...base,
    stops: [{ location: "3445 kennedy rd" }, { location: "100 queen st toronto" }],
    departureTime: "2026-09-10T10:14:59.000Z"
  });
  const fingerprint = googleMapsRouteFingerprint(base);
  assert.equal(fingerprint, sameBucket);
  assert.match(fingerprint, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(fingerprint, /kennedy|queen/iu);
  assert.notEqual(fingerprint, googleMapsRouteFingerprint({ ...base, allowTolls: true }));
  assert.notEqual(fingerprint, googleMapsRouteFingerprint({ ...base, stops: [...base.stops].reverse() }));
  assert.notEqual(fingerprint, googleMapsRouteFingerprint({ ...base, departureTime: "2026-09-10T10:16:00.000Z" }));
  assert.notEqual(fingerprint, googleMapsRouteFingerprint({ ...base, travelTimePercent: 10 }));
  assert.notEqual(fingerprint, googleMapsRouteFingerprint({ ...base, trafficAware: true }));
  assert.notEqual(fingerprint, googleMapsRouteFingerprint({ ...base, stops: [{ ...base.stops[0], stayMinutes: 5 }, base.stops[1]] }));
  assert.notEqual(fingerprint, googleMapsRouteFingerprint({ ...base, stayMinutes: [5, 0] }));
});

test("preview validation reports malformed legs instead of silently omitting them", () => {
  const result = validateRoutePreview({
    legMinutes: [12, Number.NaN],
    driveMinutes: 12,
    stayMinutes: 5,
    totalMinutes: 17
  }, { stopCount: 3 });
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes("leg_2_invalid"));
});
