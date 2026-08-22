// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDriverPlanExecutionDate,
  DRIVER_COMPANY_TIME_ZONE,
  driverCompanyDate,
  driverPlanExecutionDecision
} from "../../../src/driver-plan-date-policy.js";

test("S1: the company date follows Toronto rather than UTC", () => {
  assert.equal(DRIVER_COMPANY_TIME_ZONE, "America/Toronto");
  assert.equal(driverCompanyDate(new Date("2026-08-18T03:59:59.999Z")), "2026-08-17");
  assert.equal(driverCompanyDate(new Date("2026-08-18T04:00:00.000Z")), "2026-08-18");
  assert.equal(driverCompanyDate(new Date("2026-01-01T04:59:59.999Z")), "2025-12-31");
  assert.equal(driverCompanyDate(new Date("2026-01-01T05:00:00.000Z")), "2026-01-01");
});

test("S2: a future route is visible but not executable before Toronto midnight", () => {
  const decision = driverPlanExecutionDecision("2026-08-18", {
    now: new Date("2026-08-18T03:59:59.999Z")
  });
  assert.deepEqual(decision, {
    allowed: false,
    code: "DRIVER_PLAN_NOT_STARTED",
    message: "This route is scheduled for 2026-08-18 and cannot start before that date in Toronto.",
    planDate: "2026-08-18",
    companyDate: "2026-08-17",
    timeZone: "America/Toronto"
  });
});

test("S3/S4: the same route unlocks at Toronto midnight and past replay remains allowed", () => {
  for (const [planDate, now] of [
    ["2026-08-18", "2026-08-18T04:00:00.000Z"],
    ["2026-08-17", "2026-08-18T15:00:00.000Z"],
    [new Date("2026-08-18T00:00:00.000Z"), "2026-08-18T20:00:00.000Z"]
  ]) {
    const decision = driverPlanExecutionDecision(planDate, { now: new Date(now) });
    assert.equal(decision.allowed, true, JSON.stringify({ planDate, now }));
    assert.equal(decision.code, "");
    assert.equal(decision.message, "");
  }
});

test("S5: malformed, missing, and impossible dates fail closed", () => {
  for (const planDate of [undefined, null, "", "2026-8-18", "2026-02-30", "not-a-date", new Date("invalid")]) {
    const decision = driverPlanExecutionDecision(planDate, {
      now: new Date("2026-08-18T12:00:00.000Z")
    });
    assert.equal(decision.allowed, false, String(planDate));
    assert.equal(decision.code, "DRIVER_PLAN_DATE_INVALID", String(planDate));
    assert.match(decision.message, /valid YYYY-MM-DD plan date/u);
  }
});

test("S6: the assertion exposes a stable HTTP-safe conflict", () => {
  assert.throws(
    () => assertDriverPlanExecutionDate("2026-08-18", {
      now: new Date("2026-08-17T23:00:00.000-04:00")
    }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "DRIVER_PLAN_NOT_STARTED");
      assert.equal(error.planDate, "2026-08-18");
      assert.equal(error.companyDate, "2026-08-17");
      return true;
    }
  );
});
