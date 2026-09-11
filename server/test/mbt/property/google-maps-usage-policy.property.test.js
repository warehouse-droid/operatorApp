import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFallbackRoutePreview,
  googleMapsAdmissionDecision,
  validateRoutePreview
} from "../../../src/google-maps-usage-policy.js";

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = ((state * 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

test("property: no input can admit usage beyond the hard limit", () => {
  const next = random(0x4d415053);
  for (let index = 0; index < 5_000; index += 1) {
    const rollingUsage = Math.floor(next() * 6_000);
    const units = 1 + Math.floor(next() * 20);
    const decision = googleMapsAdmissionDecision({
      rollingUsage,
      units,
      automatic: next() > 0.5,
      reason: next() > 0.5 ? "confirm" : "background"
    });
    if (decision.admitted) {assert.ok(rollingUsage + units <= 4_500);}
  }
});

test("property: fallback route previews are totalled and valid for arbitrary route sizes", () => {
  const next = random(0x524f5554);
  for (let pass = 0; pass < 1_000; pass += 1) {
    const stopCount = 1 + Math.floor(next() * 30);
    const stops = Array.from({ length: stopCount }, (_, index) => ({
      location: next() < 0.1 && index ? `stop-${index - 1}` : `stop-${index}`,
      stayMinutes: Math.floor(next() * 181)
    }));
    const fallbackLegMinutes = Array.from({ length: Math.max(0, stopCount - 1) }, () =>
      next() < 0.1 ? Number.NaN : Math.floor(next() * 241)
    );
    const preview = buildFallbackRoutePreview({
      stops,
      fallbackLegMinutes,
      travelTimePercent: Math.floor(next() * 101)
    });
    assert.equal(validateRoutePreview(preview, { stopCount }).valid, true);
    assert.equal(preview.driveMinutes, preview.legMinutes.reduce((sum, minutes) => sum + minutes, 0));
    assert.equal(preview.totalMinutes, preview.driveMinutes + preview.stayMinutes);
  }
});
