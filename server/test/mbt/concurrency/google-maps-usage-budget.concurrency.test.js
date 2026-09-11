import assert from "node:assert/strict";
import test from "node:test";

import { query, withTransaction } from "../../../src/db.js";
import { createGoogleMapsUsageRepository } from "../../../src/google-maps-usage-repository.js";

const limits = Object.freeze({
  windowDays: 30,
  alertLimit: 5,
  conserveLimit: 6,
  normalLimit: 8,
  hardLimit: 10,
  consoleTarget: 12,
  subsystemLimits: Object.freeze({ dispatch_route: 8 })
});

test("concurrent admissions cannot overshoot the rolling hard limit", async () => {
  await query("DELETE FROM google_maps_usage_ledger");
  const repository = createGoogleMapsUsageRepository({ query, withTransaction, limits });
  const results = await Promise.all(Array.from({ length: 25 }, (_, index) => repository.admit({
    subsystem: "dispatch_route",
    api: "routes_v2_compute_routes",
    reason: "confirm",
    fingerprint: `concurrency-${index}`,
    units: 1,
    mode: "normal"
  })));
  assert.equal(results.filter((result) => result.admitted).length, 10);
  assert.equal(results.filter((result) => !result.admitted).length, 15);
  const stored = await query("SELECT coalesce(sum(admitted_units), 0)::integer AS usage FROM google_maps_usage_ledger WHERE admitted");
  assert.equal(stored.rows[0].usage, 10);
});

test("usage summaries contain counts only and outcomes update without request content", async () => {
  await query("DELETE FROM google_maps_usage_ledger");
  const repository = createGoogleMapsUsageRepository({ query, withTransaction, limits });
  const admitted = await repository.admit({
    subsystem: "dispatch_route",
    api: "routes_v2_compute_routes",
    reason: "manual_refresh",
    fingerprint: "100 Queen Street, Toronto",
    actorId: "operator-1",
    sessionId: "session-1",
    units: 1,
    mode: "normal"
  });
  await repository.recordOutcome({ ledgerId: admitted.ledgerId, outcome: "succeeded", httpStatus: 200, latencyMs: 25 });
  await query(
    "UPDATE google_maps_usage_ledger SET requested_at = (((now() AT TIME ZONE 'UTC')::date - 1) AT TIME ZONE 'UTC') WHERE id = $1",
    [admitted.ledgerId]
  );
  const summary = await repository.summary();
  assert.equal(summary.rolling30Day, 1);
  assert.equal(summary.perSubsystem.dispatch_route, 1);
  assert.equal(summary.hardLimit, 10);
  assert.equal(summary.daily.length, 30);
  assert.equal(summary.daily.at(-2).admittedUnits, 1);
  assert.equal(summary.projected30DayFromSevenDays, 4);
  assert.equal(summary.actions.length, 1);
  assert.equal(summary.actions[0].reason, "manual_refresh");
  assert.equal(summary.actions[0].admittedUnits, 1);
  assert.equal(summary.actions[0].deniedCount, 0);
  assert.equal(summary.actions[0].failedCount, 0);
  const storedFingerprint = await query(
    "SELECT request_fingerprint, actor_id, session_id FROM google_maps_usage_ledger WHERE id = $1",
    [admitted.ledgerId]
  );
  assert.match(storedFingerprint.rows[0].request_fingerprint, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(storedFingerprint.rows[0].request_fingerprint, /manual|queen|operator/iu);
  assert.match(storedFingerprint.rows[0].actor_id, /^[0-9a-f]{64}$/u);
  assert.match(storedFingerprint.rows[0].session_id, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(storedFingerprint.rows[0]), /queen|operator-1|session-1/iu);
  const columns = await query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'google_maps_usage_ledger'`
  );
  const names = columns.rows.map((row) => row.column_name);
  assert.equal(names.includes("address"), false);
  assert.equal(names.includes("latitude"), false);
  assert.equal(names.includes("longitude"), false);
  assert.equal(names.includes("response_body"), false);
});

test("a paid admission remains reserved when the surrounding business transaction rolls back", async () => {
  await query("DELETE FROM google_maps_usage_ledger");
  const repository = createGoogleMapsUsageRepository({ limits });
  await withTransaction(async () => {
    const admitted = await repository.admit({
      subsystem: "support_route",
      api: "routes_v2_compute_routes",
      reason: "manual_refresh",
      fingerprint: "independent-reservation",
      units: 1,
      mode: "normal"
    });
    assert.equal(admitted.admitted, true);
  }, { rollback: true });
  const stored = await query(
    "SELECT count(*)::integer AS count, coalesce(sum(admitted_units), 0)::integer AS usage FROM google_maps_usage_ledger"
  );
  assert.equal(stored.rows[0].count, 1);
  assert.equal(stored.rows[0].usage, 1);
});
