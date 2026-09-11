import assert from "node:assert/strict";
import test from "node:test";

import { replayGoogleMapsUsage } from "../../../src/google-maps-usage-replay.js";

test("identical seven-day events show legacy fan-out and controlled valid previews", () => {
  const report = replayGoogleMapsUsage({
    windowDays: 7,
    snapshots: [{
      eventAt: "2026-09-05T12:00:00.000Z",
      planId: "1",
      confirmed: true,
      loads: [{
        loadKey: "1:L1",
        routeFingerprint: "route-a",
        stops: [{ location: "A" }, { location: "B" }, { location: "C" }],
        routeEstimate: null
      }]
    }, {
      eventAt: "2026-09-05T12:10:00.000Z",
      planId: "1",
      confirmed: true,
      loads: [{
        loadKey: "1:L1",
        routeFingerprint: "route-a",
        stops: [{ location: "A" }, { location: "B" }, { location: "C" }],
        routeEstimate: null
      }]
    }],
    activeTruckIntervals: [
      { truckKey: "T1", startedAt: "2026-09-05T10:00:00.000Z", completedAt: "2026-09-05T11:00:00.000Z" },
      { truckKey: "T1", startedAt: "2026-09-05T10:30:00.000Z", completedAt: "2026-09-05T11:30:00.000Z" }
    ],
    completedJobs: 2,
    uniqueUnresolvedDestinations: 1,
    dependencySuggestions: 1,
    browserMapSessions: 1
  });

  assert.equal(report.previews.total, 2);
  assert.equal(report.previews.valid, 2);
  assert.equal(report.previews.invalid, 0);
  assert.equal(report.previews.fallback, 2);
  assert.equal(report.previews.sourceInvalid, 0);
  assert.deepEqual(report.previews.fingerprints, { total: 2, stable: 2, unstable: 0 });
  assert.equal(report.current.monitorEta, 120);
  assert.equal(report.controlled.monitorEta, 0);
  assert.equal(report.current.dispatchRoutes, 3);
  assert.equal(report.controlled.dispatchRoutes, 1);
  assert.equal(report.current.dynamicMaps, 1);
  assert.equal(report.controlled.dynamicMaps, 0);
  assert.ok(report.controlled.total < report.current.total);
  assert.ok(report.controlled.projected30Day < 5_000);
});

test("malformed persisted previews are reported and repaired instead of omitted", () => {
  const report = replayGoogleMapsUsage({
    windowDays: 0,
    snapshots: [{
      confirmed: false,
      loads: [{
        loadKey: "bad-load",
        stops: [{ location: "A" }, { location: "B" }, { location: "C" }],
        fallbackLegMinutes: [12, 18],
        routeEstimate: {
          source: "google",
          legMinutes: [12, Number.NaN],
          driveMinutes: 12,
          stayMinutes: 0,
          totalMinutes: 12
        }
      }]
    }],
    activeTruckIntervals: [
      { truckKey: "T1", startedAt: "invalid", completedAt: "2026-09-05T10:00:00.000Z" },
      { truckKey: "T1", startedAt: "2026-09-05T11:00:00.000Z", completedAt: "2026-09-05T10:00:00.000Z" }
    ]
  });
  assert.equal(report.windowDays, 7);
  assert.equal(report.previews.sourceInvalid, 1);
  assert.equal(report.previews.repairedWithFallback, 1);
  assert.equal(report.previews.sourceIssues.leg_2_invalid, 1);
  assert.equal(report.previews.invalid, 0);
  assert.equal(report.previews.valid, 1);
  assert.equal(report.current.monitorEta, 0);
});
