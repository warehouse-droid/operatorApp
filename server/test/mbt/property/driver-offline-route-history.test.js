import assert from "node:assert/strict";
import test from "node:test";

import history from "../../fixtures/driver-offline-route-history.json" with { type: "json" };
import {
  materializeHistoricalRoute,
  summarizeHistoricalRoutes
} from "../../support/driver-offline-route-history.mjs";

test("the anonymized route corpus covers every historical Driver manifest snapshot", () => {
  assert.equal(history.schemaVersion, 1);
  assert.equal(history.source.routeSnapshotCount, 519);
  assert.equal(history.source.jobCount, 1581);
  assert.equal(history.routes.length, 519);
  assert.deepEqual(
    summarizeHistoricalRoutes(history.routes),
    {
      routes: 519,
      jobs: 1581,
      actions: 3159,
      photos: 2570,
      directPickups: 3,
      stopTypes: { pickup: 460, dropoff: 825, travel: 293, truck_switch: 3 }
    }
  );
});

test("the route clone contains topology only and preserves strict sequence identity", () => {
  history.routes.forEach((source, index) => {
    assert.deepEqual(Object.keys(source).sort(), ["date", "id", "jobs"]);
    assert.equal(source.id, `H${String(index + 1).padStart(3, "0")}`);
    assert.match(source.date, /^2026-(?:07|08)-\d{2}$/u);
    const route = materializeHistoricalRoute(source);
    assert.equal(route.jobs.length, source.jobs.length);
    assert.equal(new Set(route.jobs.map(({ jobId }) => jobId)).size, route.jobs.length);
    assert.equal(new Set(route.jobs.map(({ fingerprint }) => fingerprint)).size, route.jobs.length);
    route.jobs.forEach((job, jobIndex) => {
      assert.match(job.fingerprint, /^[0-9a-f]{64}$/u);
      assert.equal(
        job.predecessorFingerprint,
        jobIndex === 0 ? "0".repeat(64) : route.jobs[jobIndex - 1].fingerprint
      );
    });
  });
});
