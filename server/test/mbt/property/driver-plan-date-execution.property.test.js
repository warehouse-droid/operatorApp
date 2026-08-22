// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import {
  driverCompanyDate,
  driverPlanExecutionDecision
} from "../../../src/driver-plan-date-policy.js";

function isoUtcDate(date) {
  return date.toISOString().slice(0, 10);
}

test("S7 property: valid plan dates are allowed exactly when they are not after Toronto today", () => {
  fc.assert(fc.property(
    fc.date({
      min: new Date("2020-01-01T00:00:00.000Z"),
      max: new Date("2035-12-31T23:59:59.999Z"),
      noInvalidDate: true
    }),
    fc.date({
      min: new Date("2020-01-01T00:00:00.000Z"),
      max: new Date("2035-12-31T23:59:59.999Z"),
      noInvalidDate: true
    }),
    (now, planDateSource) => {
      const planDate = isoUtcDate(planDateSource);
      const companyDate = driverCompanyDate(now);
      const decision = driverPlanExecutionDecision(planDate, { now });
      assert.equal(decision.allowed, planDate <= companyDate);
      assert.equal(decision.companyDate, companyDate);
      assert.equal(decision.planDate, planDate);
    }
  ), { numRuns: 2_000 });
});

test("S8 property: every invalid ISO-looking calendar date fails closed", () => {
  fc.assert(fc.property(
    fc.integer({ min: 2020, max: 2035 }),
    fc.integer({ min: 13, max: 99 }),
    fc.integer({ min: 32, max: 99 }),
    (year, month, day) => {
      const candidate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const decision = driverPlanExecutionDecision(candidate, {
        now: new Date("2026-08-18T12:00:00.000Z")
      });
      assert.equal(decision.allowed, false);
      assert.equal(decision.code, "DRIVER_PLAN_DATE_INVALID");
    }
  ), { numRuns: 1_000 });
});
