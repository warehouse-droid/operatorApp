// @ts-check

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  actualArrivalHistoryWindows,
  findFinalDestinationCluster,
  normalizeActualArrivalPoint
} from "../../../src/dispatch-actual-arrival-policy.js";

const destination = Object.freeze({ latitude: 43.8, longitude: -79.3 });

function point(time, {
  latitude = destination.latitude,
  longitude = destination.longitude,
  speedKmh = null
} = {}) {
  return { time, value: { latitude, longitude, speedKmh } };
}

test("the final sustained destination cluster wins over an earlier pass-by", () => {
  const result = findFinalDestinationCluster({
    destination,
    windowStart: "2026-08-17T12:00:00.000Z",
    windowEnd: "2026-08-17T14:00:00.000Z",
    points: [
      point("2026-08-17T12:10:00.000Z"),
      point("2026-08-17T12:11:10.000Z"),
      point("2026-08-17T12:12:00.000Z", { latitude: 43.81 }),
      point("2026-08-17T13:50:00.000Z"),
      point("2026-08-17T13:51:10.000Z")
    ]
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.arrivalAt, "2026-08-17T13:50:00.000Z");
  assert.equal(result.confidence, "high");
  assert.equal(result.radiusMeters, 150);
});

test("leaving the destination radius always splits clusters", () => {
  const result = findFinalDestinationCluster({
    destination,
    windowStart: "2026-08-17T12:00:00.000Z",
    windowEnd: "2026-08-17T12:03:00.000Z",
    points: [
      point("2026-08-17T12:00:00.000Z"),
      point("2026-08-17T12:00:30.000Z"),
      point("2026-08-17T12:00:40.000Z", { latitude: 43.81 }),
      point("2026-08-17T12:01:10.000Z")
    ]
  });

  assert.deepEqual(result, {
    status: "unresolved",
    reason: "no_sustained_destination_cluster",
    pointCount: 4
  });
});

test("the 250 metre fallback requires dwell plus a slow sample, not exact zero speed", () => {
  const latitudeAbout200MetresAway = 43.8018;
  const base = {
    destination,
    windowStart: "2026-08-17T12:00:00.000Z",
    windowEnd: "2026-08-17T12:05:00.000Z"
  };
  const resolved = findFinalDestinationCluster({
    ...base,
    points: [
      point("2026-08-17T12:00:00.000Z", { latitude: latitudeAbout200MetresAway, speedKmh: 18 }),
      point("2026-08-17T12:01:00.000Z", { latitude: latitudeAbout200MetresAway, speedKmh: 3 }),
      point("2026-08-17T12:02:10.000Z", { latitude: latitudeAbout200MetresAway, speedKmh: 8 })
    ]
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.arrivalAt, "2026-08-17T12:00:00.000Z");
  assert.equal(resolved.radiusMeters, 250);
  assert.equal(resolved.slowPointCount, 1);

  const movingOnly = findFinalDestinationCluster({
    ...base,
    points: [
      point("2026-08-17T12:00:00.000Z", { latitude: latitudeAbout200MetresAway, speedKmh: 8 }),
      point("2026-08-17T12:02:10.000Z", { latitude: latitudeAbout200MetresAway, speedKmh: 9 })
    ]
  });
  assert.equal(movingOnly.status, "unresolved");
  assert.equal(movingOnly.reason, "no_sustained_destination_cluster");
});

test("Samsara mph history is normalized to km/h", () => {
  const normalized = normalizeActualArrivalPoint({
    time: "2026-08-17T12:00:00.000Z",
    value: {
      latitude: 43.8,
      longitude: -79.3,
      speedMilesPerHour: 10
    }
  });
  assert.equal(normalized?.time, "2026-08-17T12:00:00.000Z");
  assert.ok(Math.abs(Number(normalized?.speedKmh) - 16.09344) < 0.000001);
  assert.equal(normalizeActualArrivalPoint(point("2026-08-17T12:01:00.000Z"))?.speedKmh, null);
  assert.equal(normalizeActualArrivalPoint({
    time: "2026-08-17T12:01:00.000Z",
    value: { latitude: null, longitude: null }
  }), null);
});

test("history lookup starts with 30 minutes and expands without overlap", () => {
  assert.deepEqual(actualArrivalHistoryWindows({
    windowStart: "2026-08-17T12:00:00.000Z",
    windowEnd: "2026-08-17T14:00:00.000Z"
  }), [{
    startTime: "2026-08-17T13:30:00.000Z",
    endTime: "2026-08-17T14:00:00.000Z",
    kind: "primary"
  }, {
    startTime: "2026-08-17T12:00:00.000Z",
    endTime: "2026-08-17T13:30:00.000Z",
    kind: "expanded"
  }]);

  assert.deepEqual(actualArrivalHistoryWindows({
    windowStart: "2026-08-17T13:45:00.000Z",
    windowEnd: "2026-08-17T14:00:00.000Z"
  }), [{
    startTime: "2026-08-17T13:45:00.000Z",
    endTime: "2026-08-17T14:00:00.000Z",
    kind: "primary"
  }]);
});

test("missing coordinates, invalid windows, and empty history stay unresolved", () => {
  assert.equal(findFinalDestinationCluster({
    points: [],
    destination: {},
    windowStart: "2026-08-17T12:00:00.000Z",
    windowEnd: "2026-08-17T13:00:00.000Z"
  }).reason, "destination_coordinates_unavailable");
  assert.equal(findFinalDestinationCluster({
    points: [],
    destination,
    windowStart: "2026-08-17T13:00:00.000Z",
    windowEnd: "2026-08-17T12:00:00.000Z"
  }).reason, "invalid_time_window");
  assert.equal(findFinalDestinationCluster({
    points: [],
    destination,
    windowStart: "2026-08-17T12:00:00.000Z",
    windowEnd: "2026-08-17T13:00:00.000Z"
  }).reason, "no_gps_points");
});

test("local calculation remains below one second for a route-sized history", () => {
  const start = Date.parse("2026-08-17T12:00:00.000Z");
  const points = Array.from({ length: 7_200 }, (_, index) => point(
    new Date(start + index * 1000).toISOString(),
    index >= 7_000
      ? { latitude: 43.8002, longitude: -79.3002, speedKmh: 2 }
      : { latitude: 43.82, longitude: -79.32, speedKmh: 45 }
  ));
  const started = performance.now();
  const result = findFinalDestinationCluster({
    points,
    destination,
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(start + 7_200_000).toISOString()
  });
  const elapsedMs = performance.now() - started;
  assert.equal(result.status, "resolved");
  assert.ok(elapsedMs < 1_000, `Local arrival calculation took ${elapsedMs.toFixed(3)} ms.`);
});
