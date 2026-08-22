// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDriverPlanExecutionDate,
  driverPlanExecutionDecision
} from "../../../src/driver-plan-date-policy.js";

test("S14 adversarial: hostile scalar plan dates cannot fail open", () => {
  const now = new Date("2026-08-18T12:00:00.000Z");
  for (const value of [false, true, 0, 20260818, [], {}, Symbol("date"), "2026-08-18T00:00:00Z"]) {
    const decision = driverPlanExecutionDecision(value, { now });
    assert.equal(decision.allowed, false, String(value));
    assert.equal(decision.code, "DRIVER_PLAN_DATE_INVALID", String(value));
  }
});

test("S15 adversarial: leap days and distant future dates retain calendar semantics", () => {
  assert.equal(driverPlanExecutionDecision("2024-02-29", {
    now: new Date("2024-02-29T05:00:00.000Z")
  }).allowed, true);
  assert.equal(driverPlanExecutionDecision("2025-02-29", {
    now: new Date("2025-03-01T12:00:00.000Z")
  }).code, "DRIVER_PLAN_DATE_INVALID");
  assert.equal(driverPlanExecutionDecision("9999-12-31", {
    now: new Date("2026-08-18T12:00:00.000Z")
  }).code, "DRIVER_PLAN_NOT_STARTED");
});

test("S16 adversarial: an invalid clock cannot silently authorize work", () => {
  assert.throws(
    () => driverPlanExecutionDecision("2026-08-18", { now: new Date("invalid") }),
    /valid instant/u
  );
  assert.throws(
    () => assertDriverPlanExecutionDate("2026-08-18", { now: new Date("invalid") }),
    /valid instant/u
  );
});
