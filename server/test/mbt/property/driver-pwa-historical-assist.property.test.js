// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import {
  historicalAssistDateDecision,
  historicalAssistRequiredPhotoCount,
  resolveHistoricalAssistInstant,
  torontoOffsetChoices
} from "../../../src/driver-historical-assist-policy.js";
import { driverCompanyDate } from "../../../src/driver-plan-date-policy.js";

test("S8 property: historical dates are allowed exactly before Toronto today", () => {
  fc.assert(fc.property(
    fc.date({ min: new Date("2022-01-01T00:00:00.000Z"), max: new Date("2032-12-31T23:59:59.999Z"), noInvalidDate: true }),
    fc.date({ min: new Date("2022-01-01T00:00:00.000Z"), max: new Date("2032-12-31T23:59:59.999Z"), noInvalidDate: true }),
    (now, source) => {
      const planDate = source.toISOString().slice(0, 10);
      assert.equal(
        historicalAssistDateDecision(planDate, { now }).allowed,
        planDate < driverCompanyDate(now)
      );
    }
  ), { numRuns: 2_000 });
});

test("S9 property: every returned Toronto offset round-trips to the requested local time", () => {
  fc.assert(fc.property(
    fc.date({ min: new Date("2023-01-01T00:00:00.000Z"), max: new Date("2030-12-31T23:59:59.999Z"), noInvalidDate: true }),
    fc.integer({ min: 0, max: 23 }),
    fc.integer({ min: 0, max: 59 }),
    (source, hour, minute) => {
      const planDate = source.toISOString().slice(0, 10);
      const localTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
      for (const choice of torontoOffsetChoices(planDate, localTime)) {
        const instant = resolveHistoricalAssistInstant({ planDate, localTime, offset: choice.offset });
        assert.equal(instant.toISOString(), choice.instant);
      }
    }
  ), { numRuns: 2_000 });
});

test("S10 property: enabled photo requirements never weaken Driver's two-photo floor", () => {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 100 }),
    (configured) => {
      const required = historicalAssistRequiredPhotoCount({ requiredPhotos: configured });
      assert.equal(required, configured === 0 ? 0 : Math.min(20, Math.max(2, configured)));
    }
  ), { numRuns: 1_000 });
});
