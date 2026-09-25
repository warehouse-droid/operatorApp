import assert from "node:assert/strict";
import test from "node:test";
import {
  GOOGLE_MAPS_USAGE_LIMITS,
  googleMapsAdmissionDecision
} from "../../../src/google-maps-usage-policy.js";

const features = ["dynamic_map", "dispatch_route", "driver_geocode", "monitor_eta", "support_route"];

test("one shared 150-unit daily budget covers automatic and manual requests from every feature", () => {
  assert.equal(GOOGLE_MAPS_USAGE_LIMITS.dailyLimit, 150);
  for (const subsystem of features) {
    for (const automatic of [false, true]) {
      const input = { subsystem, automatic, rollingUsage: 800, reason: "manual_refresh" };
      assert.equal(googleMapsAdmissionDecision({ ...input, dailyUsage: 149 }).admitted, true);
      assert.equal(googleMapsAdmissionDecision({ ...input, dailyUsage: 150 }).reason, "daily_limit");
      assert.equal(googleMapsAdmissionDecision({ ...input, dailyUsage: 149, units: 2 }).reason, "daily_limit");
    }
  }
});

test("embedded maps have no separate rolling subsystem ceiling", () => {
  assert.equal(GOOGLE_MAPS_USAGE_LIMITS.subsystemLimits.dynamic_map, undefined);
  for (const subsystemUsage of [299, 300, 301, 1_000]) {
    assert.equal(googleMapsAdmissionDecision({
      subsystem: "dynamic_map", subsystemUsage, rollingUsage: 1_200, dailyUsage: 10, automatic: true
    }).admitted, true);
  }
});

test("a reopened daily allowance still obeys the rolling ceiling and configuration", () => {
  const input = { dailyUsage: 150, dailyExtraUnits: 150, reason: "manual_refresh" };
  assert.equal(googleMapsAdmissionDecision(input).admitted, true);
  assert.equal(googleMapsAdmissionDecision({ ...input, dailyUsage: 299 }).admitted, true);
  assert.equal(googleMapsAdmissionDecision({ ...input, dailyUsage: 300 }).reason, "daily_limit");
  assert.equal(googleMapsAdmissionDecision({ ...input, rollingUsage: 4_500 }).reason, "hard_limit");
  assert.equal(googleMapsAdmissionDecision({ ...input, mode: "disabled" }).reason, "disabled");
  assert.equal(googleMapsAdmissionDecision({ ...input, mode: "conserve", automatic: true }).reason, "automatic_disabled");
});

test("other automatic subsystem allowances and explicit shared-reserve requests remain intact", () => {
  for (const [subsystem, subsystemUsage] of Object.entries(GOOGLE_MAPS_USAGE_LIMITS.subsystemLimits)) {
    const input = { subsystem, subsystemUsage, rollingUsage: 1_200, dailyUsage: 10, reason: "manual_refresh" };
    assert.equal(googleMapsAdmissionDecision({ ...input, automatic: true }).reason, "subsystem_limit");
    assert.equal(googleMapsAdmissionDecision({ ...input, automatic: false }).reason, "shared_reserve");
  }
});

test("property: daily allowance admits exactly the safe side of both capacity boundaries", () => {
  for (let dailyUsage = 0; dailyUsage <= 450; dailyUsage += 1) {
    for (const dailyExtraUnits of [0, 150, 300]) {
      for (const units of [1, 2, 9]) {
        const rollingUsage = 4_490 + (dailyUsage % 11);
        const decision = googleMapsAdmissionDecision({
          dailyUsage, dailyExtraUnits, units, rollingUsage, reason: "manual_refresh"
        });
        assert.equal(decision.admitted,
          dailyUsage + units <= 150 + dailyExtraUnits && rollingUsage + units <= 4_500);
      }
    }
  }
});
