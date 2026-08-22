// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertHistoricalAssistPlanDate,
  buildHistoricalAssistPhysicalVisits,
  HISTORICAL_ASSIST_MAX_PHOTOS,
  HISTORICAL_ASSIST_MINIMUM_DURATION_MS,
  HISTORICAL_ASSIST_TIME_ZONE,
  historicalAssistDateDecision,
  historicalAssistRequiredPhotoCount,
  resolveHistoricalAssistInstant,
  torontoOffsetChoices,
  validateHistoricalAssistChronology
} from "../../../src/driver-historical-assist-policy.js";

const NOW = new Date("2026-08-20T16:00:00.000Z");

test("S1: historical assist is restricted to valid dates before Toronto today", () => {
  assert.equal(HISTORICAL_ASSIST_TIME_ZONE, "America/Toronto");
  assert.equal(HISTORICAL_ASSIST_MINIMUM_DURATION_MS, 10_000);
  assert.equal(HISTORICAL_ASSIST_MAX_PHOTOS, 20);

  assert.equal(historicalAssistDateDecision("2026-08-19", { now: NOW }).allowed, true);
  for (const [date, code] of [
    ["2026-08-20", "HISTORICAL_ASSIST_DATE_NOT_PAST"],
    ["2026-08-21", "HISTORICAL_ASSIST_DATE_NOT_PAST"],
    ["2026-02-30", "HISTORICAL_ASSIST_DATE_INVALID"],
    ["", "HISTORICAL_ASSIST_DATE_INVALID"]
  ]) {
    const decision = historicalAssistDateDecision(date, { now: NOW });
    assert.equal(decision.allowed, false, String(date));
    assert.equal(decision.code, code, String(date));
    assert.equal(decision.companyDate, "2026-08-20");
  }

  assert.throws(
    () => assertHistoricalAssistPlanDate("2026-08-20", { now: NOW }),
    (error) => error?.status === 409 && error?.code === "HISTORICAL_ASSIST_DATE_NOT_PAST"
  );
});

test("S2: Toronto time resolution rejects gaps and requires a choice for overlaps", () => {
  assert.deepEqual(torontoOffsetChoices("2026-03-08", "02:30:00"), []);
  assert.throws(
    () => resolveHistoricalAssistInstant({ planDate: "2026-03-08", localTime: "02:30:00" }),
    (error) => error?.code === "HISTORICAL_ASSIST_TIME_NONEXISTENT"
  );

  const overlap = torontoOffsetChoices("2026-11-01", "01:30:00");
  assert.deepEqual(overlap.map((choice) => choice.offset), ["-04:00", "-05:00"]);
  assert.deepEqual(overlap.map((choice) => choice.abbreviation), ["EDT", "EST"]);
  assert.throws(
    () => resolveHistoricalAssistInstant({ planDate: "2026-11-01", localTime: "01:30:00" }),
    (error) => error?.code === "HISTORICAL_ASSIST_TIME_AMBIGUOUS"
  );
  assert.equal(
    resolveHistoricalAssistInstant({
      planDate: "2026-11-01",
      localTime: "01:30:00",
      offset: "-05:00"
    }).toISOString(),
    "2026-11-01T06:30:00.000Z"
  );

  const ordinary = torontoOffsetChoices("2026-08-19", "13:45:30");
  assert.equal(ordinary.length, 1);
  assert.equal(ordinary[0].offset, "-04:00");
});

test("S3: supplied offset must actually represent the Toronto local time", () => {
  assert.throws(
    () => resolveHistoricalAssistInstant({
      planDate: "2026-08-19",
      localTime: "13:45:30",
      offset: "-05:00"
    }),
    (error) => error?.code === "HISTORICAL_ASSIST_OFFSET_INVALID"
  );
  assert.throws(
    () => resolveHistoricalAssistInstant({
      planDate: "2026-08-19",
      localTime: "bad",
      offset: "-04:00"
    }),
    (error) => error?.code === "HISTORICAL_ASSIST_TIME_INVALID"
  );
});

test("S4: never-started visits require arrival and completion with route chronology", () => {
  const result = validateHistoricalAssistChronology({
    planDate: "2026-08-19",
    arrival: { localTime: "10:00:00", offset: "-04:00" },
    completion: { localTime: "10:05:00", offset: "-04:00" },
    previousCompletedAt: "2026-08-19T13:59:59.000Z",
    nextStartedAt: "2026-08-19T14:06:00.000Z"
  });
  assert.deepEqual(result, {
    startedAt: "2026-08-19T14:00:00.000Z",
    completedAt: "2026-08-19T14:05:00.000Z",
    usedStoredStart: false
  });

  assert.throws(
    () => validateHistoricalAssistChronology({
      planDate: "2026-08-19",
      completion: { localTime: "10:05:00", offset: "-04:00" }
    }),
    (error) => error?.code === "HISTORICAL_ASSIST_ARRIVAL_REQUIRED"
  );
  assert.throws(
    () => validateHistoricalAssistChronology({
      planDate: "2026-08-19",
      arrival: { localTime: "10:00:00", offset: "-04:00" },
      completion: { localTime: "10:00:09", offset: "-04:00" }
    }),
    (error) => error?.code === "HISTORICAL_ASSIST_DURATION_INVALID"
  );

  assert.equal(validateHistoricalAssistChronology({
    planDate: "2026-08-19",
    arrival: { localTime: "10:00:00", offset: "-04:00" },
    completion: { localTime: "10:00:10", offset: "-04:00" }
  }).completedAt, "2026-08-19T14:00:10.000Z");
});

test("S5: started visits preserve start time and respect both surrounding records", () => {
  const result = validateHistoricalAssistChronology({
    planDate: "2026-08-19",
    storedStartedAt: "2026-08-19T14:00:00.000Z",
    completion: { localTime: "10:05:00", offset: "-04:00" },
    previousCompletedAt: "2026-08-19T13:59:59.000Z",
    nextCompletedAt: "2026-08-19T14:06:00.000Z"
  });
  assert.equal(result.startedAt, "2026-08-19T14:00:00.000Z");
  assert.equal(result.usedStoredStart, true);

  for (const [overrides, code] of [
    [{ storedStartedAt: "2026-08-18T14:00:00.000Z" }, "HISTORICAL_ASSIST_STORED_START_DATE_CONFLICT"],
    [{ previousCompletedAt: "2026-08-19T14:00:01.000Z" }, "HISTORICAL_ASSIST_PREVIOUS_CHRONOLOGY_CONFLICT"],
    [{ nextStartedAt: "2026-08-19T14:04:59.000Z" }, "HISTORICAL_ASSIST_NEXT_CHRONOLOGY_CONFLICT"]
  ]) {
    assert.throws(
      () => validateHistoricalAssistChronology({
        planDate: "2026-08-19",
        storedStartedAt: "2026-08-19T14:00:00.000Z",
        completion: { localTime: "10:05:00", offset: "-04:00" },
        ...overrides
      }),
      (error) => error?.code === code,
      code
    );
  }
});

test("S6: historical completion uses the ordinary Driver photo rule", () => {
  assert.equal(historicalAssistRequiredPhotoCount({ requiredPhotos: 0 }), 0);
  assert.equal(historicalAssistRequiredPhotoCount({ requiredPhotos: 1 }), 2);
  assert.equal(historicalAssistRequiredPhotoCount({ requiredPhotos: 2 }), 2);
  assert.equal(historicalAssistRequiredPhotoCount({ requiredPhotos: 7 }), 7);
  assert.equal(historicalAssistRequiredPhotoCount({ requiredPhotos: 21 }), 20);
  assert.equal(historicalAssistRequiredPhotoCount({ requiredPhotos: 100 }), 20);
  assert.equal(historicalAssistRequiredPhotoCount({}), 2);
});

test("S7: only the earliest incomplete physical visit is actionable", () => {
  const consolidatedIds = ["drop-a", "drop-b"];
  const jobs = [
    { jobId: "travel-a", stopType: "travel" },
    { jobId: "pickup-a", stopType: "pickup", requiredPhotos: 0, loadId: "load-1" },
    { jobId: "drop-a", stopType: "dropoff", physicalVisitJobIds: consolidatedIds, loadId: "load-1" },
    { jobId: "drop-b", stopType: "dropoff", physicalVisitJobIds: consolidatedIds, loadId: "load-1" },
    { jobId: "pickup-b", stopType: "pickup", loadId: "load-2" },
    { jobId: "drop-c", stopType: "dropoff", loadId: "load-2" }
  ];
  const records = {
    "pickup-a": { status: "complete", startedAt: "2026-08-19T12:00:00.000Z", completedAt: "2026-08-19T12:05:00.000Z" },
    "drop-a": { status: "in_progress", startedAt: "2026-08-19T13:00:00.000Z" },
    "drop-b": { status: "in_progress", startedAt: "2026-08-19T13:00:00.000Z" },
    "drop-c": { status: "complete", startedAt: "2026-08-19T15:00:00.000Z", completedAt: "2026-08-19T15:05:00.000Z" }
  };

  const visits = buildHistoricalAssistPhysicalVisits(jobs, records);
  assert.equal(visits.length, 2);
  assert.deepEqual(visits[0].jobIds, consolidatedIds);
  assert.equal(visits[0].actionable, true);
  assert.equal(visits[0].startedAt, "2026-08-19T13:00:00.000Z");
  assert.equal(visits[0].previousCompletedAt, "2026-08-19T12:05:00.000Z");
  assert.equal(visits[0].nextStartedAt, "2026-08-19T15:00:00.000Z");
  assert.equal(visits[1].actionable, false);
  assert.equal(visits[1].blockedByJobId, "drop-a");
});
