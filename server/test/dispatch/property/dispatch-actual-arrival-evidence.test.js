import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { arrivalFailureSummary, arrivalVerificationPoint, expectedArrivalPoint } from "../../../src/dispatch-actual-arrival-evidence.js";

const record = { job_id: "job-one", driver_login: "dao", completed_at: "2026-09-14T12:00:00Z" };
const verification = {
  job_id: "job-one", driver_login: "dao", verification_id: "verification-one", checked_at: "2026-09-14T11:00:00Z",
  details: { expectedAddress: "100 Main Street, Toronto", expectedLatitude: 43.8, expectedLongitude: -79.3 }
};
const address = verification.details.expectedAddress;

test("valid destination evidence survives address formatting and coordinate representation", () => {
  fc.assert(fc.property(fc.double({ min: -90, max: 90, noNaN: true }), fc.double({ min: -180, max: 180, noNaN: true }), fc.boolean(), (lat, lng, strings) => {
    const v = { ...verification, details: { expectedAddress: address.toUpperCase().replaceAll(",", ""), expectedLatitude: strings ? String(lat) : lat, expectedLongitude: strings ? String(lng) : lng } };
    const point = arrivalVerificationPoint(record, v, address);
    assert.ok(point, "Valid evidence must remain usable, not merely fail closed.");
    assert.equal(point.latitude, strings ? Number(String(lat)) : lat);
    assert.equal(point.longitude, strings ? Number(String(lng)) : lng);
    assert.equal(point.source, "driver_location_verification");
  }), { numRuns: 300, seed: 20260920 });
});

test("any distinct recorded destination or owner must reject coordinate reuse", () => {
  fc.assert(fc.property(fc.integer({ min: 101, max: 999999 }), fc.stringMatching(/^[a-z]{1,12}$/), (street, suffix) => {
    assert.equal(arrivalVerificationPoint(record, verification, `${street} Main Street, Toronto`), null);
    assert.equal(arrivalVerificationPoint(record, { ...verification, driver_login: `other-${suffix}` }, address), null);
    assert.equal(arrivalVerificationPoint(record, { ...verification, job_id: `other-${suffix}` }, address), null);
  }), { numRuns: 200, seed: 20260921 });
});

test("future verifications and geographic outliers cannot become historical coordinates", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100000000 }), fc.double({ min: 90.0001, max: 1000000, noNaN: true }), (offset, outlier) => {
    assert.equal(arrivalVerificationPoint(record, { ...verification, checked_at: new Date(Date.parse(record.completed_at) + offset).toISOString() }, address), null);
    assert.equal(expectedArrivalPoint({ ...verification.details, expectedLatitude: outlier }, address), null);
    assert.equal(expectedArrivalPoint({ ...verification.details, expectedLongitude: outlier + 180 }, address), null);
  }), { numRuns: 200, seed: 20260922 });
});

test("malformed evidence returns no point without coercing blank, boolean or array coordinates", () => {
  for (const value of [null, undefined, "", " ", true, false, [], [43.8], {}, NaN, Infinity, -Infinity]) {
    assert.equal(expectedArrivalPoint({ ...verification.details, expectedLatitude: value }, address), null);
    assert.equal(expectedArrivalPoint({ ...verification.details, expectedLongitude: value }, address), null);
  }
  for (const details of [null, [], "text", 42]) {assert.equal(expectedArrivalPoint(details, address), null);}
  for (const time of [null, "", "invalid date"]) {
    assert.equal(arrivalVerificationPoint(record, { ...verification, checked_at: time }, address), null);
    assert.equal(arrivalVerificationPoint({ ...record, completed_at: time }, verification, address), null);
  }
  assert.equal(arrivalVerificationPoint({}, verification, address), null);
  assert.equal(arrivalVerificationPoint({ job_id: record.job_id }, verification, address), null);
  assert.equal(arrivalVerificationPoint(record, { ...verification, details: { expectedLatitude: 43.8, expectedLongitude: -79.3 } }, address), null);
  assert.deepEqual(expectedArrivalPoint({ expected: { latitude: 43.8, longitude: -79.3, address } }, address), { latitude: 43.8, longitude: -79.3 });
  assert.deepEqual(expectedArrivalPoint({ expectedLatitude: 43.8, expectedLongitude: -79.3 }), { latitude: 43.8, longitude: -79.3 });
});

test("failure summaries preserve distinct causes, deduplicate repeats, and ignore resolved stops", () => {
  const reasons = ["destination_coordinates_unavailable", "invalid_time_window", "truck_plate_unavailable", "samsara_vehicle_not_found", "samsara_vehicle_lookup_failed", "no_gps_points", "no_sustained_destination_cluster", "gps_history_incomplete", "unknown"];
  for (const error of reasons) {
    const one = { resolutionStatus: "unresolved", error };
    const summary = arrivalFailureSummary([one, one, { resolutionStatus: "resolved", error: "ignored" }]);
    assert.ok(summary.length > 15);
    assert.equal(summary.split(";").length, 1);
  }
  assert.equal(arrivalFailureSummary(), "");
});
