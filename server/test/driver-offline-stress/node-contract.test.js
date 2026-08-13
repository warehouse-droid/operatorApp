import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../src/db.js";
import {
  getDriverOfflineEvent,
  registerDriverOfflineEvents
} from "../../src/driver-offline-repository.js";
import {
  DRIVER_OFFLINE_STRESS_CASES,
  selectStressCases
} from "../support/driver-offline-stress-matrix.mjs";
import { recordStressResult } from "../support/driver-offline-stress-artifacts.mjs";

const MODE = process.env.DOS_STRESS_MODE || "full";
const CASE_ID = String(process.env.DOS_STRESS_CASE_ID || "").trim();
const SEED = Number(process.env.DOS_STRESS_SEED || 20260812);
const CONTRACT_CASES = selectStressCases({ mode: MODE, caseId: CASE_ID, seed: SEED })
  .filter(({ runtime }) => runtime === "node-postgresql");
const ALL_CONTRACT_CASES = DRIVER_OFFLINE_STRESS_CASES
  .filter(({ runtime }) => runtime === "node-postgresql");
const PLAN_DATE = "2026-08-12";

after(closeDb);

function uuidFor(testCase, suffix) {
  const bytes = crypto.createHash("sha256").update(`${testCase.id}:${suffix}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function eventFor(testCase, eventId, clientSequence = 1) {
  return {
    eventId,
    clientSequence,
    eventType: "rest_started",
    occurredAt: "2026-08-12T12:00:00.000Z",
    locationStatus: "not_checked_offline",
    details: { restId: testCase.id },
    photos: []
  };
}

async function seedManifest(testCase) {
  const manifestId = uuidFor(testCase, "manifest");
  const driverLogin = `dos-${testCase.id.toLowerCase()}`;
  const deviceId = `dos-device-${testCase.number}`;
  await query(
    `INSERT INTO driver_offline_manifests (
       manifest_id, schema_version, fingerprint_version, driver_login, device_id,
       plan_date, plan_revision, driver_profile, day_state, complete, job_count,
       generated_at, expires_at
     ) VALUES (
       $1::uuid, 1, 1, $2, $3, $4::date, 1, '{}'::jsonb, '{}'::jsonb,
       true, 0, '2026-08-12T00:00:00Z'::timestamptz, '2026-08-13T16:00:00Z'::timestamptz
     )`,
    [manifestId, driverLogin, deviceId, PLAN_DATE]
  );
  const persisted = await query(
    "SELECT manifest_id::text AS manifest_id FROM driver_offline_manifests WHERE manifest_id = $1::uuid",
    [manifestId]
  );
  assert.equal(persisted.rows[0]?.manifest_id, manifestId, "stress manifest must be durable before event registration");
  return { manifestId, driverLogin, deviceId };
}

async function exactReplayCase(testCase, fixture) {
  const event = eventFor(testCase, uuidFor(testCase, "event"));
  const calls = Array.from({ length: Math.min(Number(testCase.config.fanout || 2), 25) }, () => () => (
    registerDriverOfflineEvents({ ...fixture, events: [structuredClone(event)] })
  ));
  const results = [];
  for (const call of calls) {results.push(await call());}
  assert.equal(new Set(results.flat().map(({ eventId }) => eventId)).size, 1);
  const count = await query(
    "SELECT count(*)::int AS count FROM driver_offline_events WHERE event_id = $1::uuid",
    [event.eventId]
  );
  assert.equal(count.rows[0].count, 1);
}

async function concurrentReplayCase(testCase, fixture) {
  const event = eventFor(testCase, uuidFor(testCase, "event"));
  const fanout = Math.min(Number(testCase.config.fanout || 2), 25);
  const outcomes = await Promise.allSettled(Array.from({ length: fanout }, () => (
    registerDriverOfflineEvents({ ...fixture, events: [structuredClone(event)] })
  )));
  assert.equal(outcomes.every(({ status }) => status === "fulfilled"), true, JSON.stringify(outcomes));
  const count = await query(
    "SELECT count(*)::int AS count FROM driver_offline_events WHERE event_id = $1::uuid",
    [event.eventId]
  );
  assert.equal(count.rows[0].count, 1);
}

async function immutableConflictCase(testCase, fixture) {
  const eventId = uuidFor(testCase, "event");
  await registerDriverOfflineEvents({ ...fixture, events: [eventFor(testCase, eventId)] });
  await assert.rejects(
    registerDriverOfflineEvents({
      ...fixture,
      events: [{ ...eventFor(testCase, eventId), details: { restId: `${testCase.id}-changed` } }]
    }),
    (error) => error?.code === "OFFLINE_EVENT_IDEMPOTENCY_CONFLICT"
  );
  const stored = await getDriverOfflineEvent(eventId);
  assert.equal(stored.details.restId, testCase.id);
  assert.notEqual(stored.details.restId, `${testCase.id}-changed`);
}

async function sequenceConflictCase(testCase, fixture) {
  await registerDriverOfflineEvents({
    ...fixture,
    events: [eventFor(testCase, uuidFor(testCase, "event-a"), 1)]
  });
  await assert.rejects(
    registerDriverOfflineEvents({
      ...fixture,
      events: [eventFor(testCase, uuidFor(testCase, "event-b"), 1)]
    }),
    (error) => error?.code === "OFFLINE_EVENT_IDEMPOTENCY_CONFLICT"
  );
}

async function durableCountCase(testCase, fixture) {
  const event = eventFor(testCase, uuidFor(testCase, "event"));
  await registerDriverOfflineEvents({ ...fixture, events: [event] });
  await registerDriverOfflineEvents({ ...fixture, events: [event] });
  const counts = await query(
    `SELECT count(*)::int AS events,
            count(*) FILTER (WHERE immutable_payload->>'eventId' = $1)::int AS matching
       FROM driver_offline_events
      WHERE event_id = $2::uuid`,
    [event.eventId, event.eventId]
  );
  assert.deepEqual(counts.rows[0], { events: 1, matching: 1 });
}

async function runServerCase(testCase) {
  const fixture = await seedManifest(testCase);
  try {
    const scenario = testCase.config.scenario;
    if (["exact-replay", "lost-response-replay"].includes(scenario)) {await exactReplayCase(testCase, fixture);}
    else if (scenario === "concurrent-exact-replay") {await concurrentReplayCase(testCase, fixture);}
    else if (scenario === "immutable-payload-conflict") {await immutableConflictCase(testCase, fixture);}
    else if (scenario === "device-sequence-conflict") {await sequenceConflictCase(testCase, fixture);}
    else {await durableCountCase(testCase, fixture);}
  } finally {
    await query(
      `DELETE FROM driver_offline_event_photos
        WHERE event_record_id IN (
          SELECT id FROM driver_offline_events WHERE manifest_id = $1::uuid
        )`,
      [fixture.manifestId]
    );
    await query("DELETE FROM driver_offline_events WHERE manifest_id = $1::uuid", [fixture.manifestId]);
    await query("DELETE FROM driver_offline_manifests WHERE manifest_id = $1::uuid", [fixture.manifestId]);
  }
}

async function runIntegrityCase(testCase) {
  const scenario = testCase.config.scenario;
  if (scenario.startsWith("mutation-")) {
    const { mutationProbe } = await import("../support/driver-offline-stress-model.mjs");
    assert.ok(mutationProbe(scenario.slice("mutation-".length)).length > 0);
    return;
  }
  if (scenario === "matrix-cardinality-and-assignment") {
    assert.equal(DRIVER_OFFLINE_STRESS_CASES.length, 320);
    return;
  }
  if (scenario === "diagnostic-sanitization") {
    const { sanitizeDiagnostic } = await import("../support/driver-offline-stress-model.mjs");
    assert.equal(sanitizeDiagnostic({ token: "synthetic-redaction-input" }).token, "[REDACTED]");
    return;
  }
  if (scenario === "historical-clone-percentiles") {
    const { buildHistoricalClone } = await import("../support/driver-offline-stress-matrix.mjs");
    assert.equal(buildHistoricalClone().length, 425);
    return;
  }
  if (scenario === "evidence-completeness") {
    assert.equal(ALL_CONTRACT_CASES.length, 40);
    return;
  }
  const { createLedger, persistPhoto, uploadPhoto, verifyLedger } = await import("../support/driver-offline-stress-model.mjs");
  const ledger = createLedger();
  persistPhoto(ledger, {
    photoId: testCase.id,
    blobBytes: new Uint8Array([1]).buffer,
    sha256: "b".repeat(64),
    committed: true
  });
  uploadPhoto(ledger, testCase.id);
  assert.deepEqual(verifyLedger(ledger, { expectedClicks: 0 }), []);
}

for (const testCase of CONTRACT_CASES) {
  test(`${testCase.id} ${testCase.title}`, { timeout: 120_000 }, async () => {
    try {
      if (testCase.group === "server") {await runServerCase(testCase);}
      else {await runIntegrityCase(testCase);}
      await recordStressResult(testCase, { outcome: "passed", metrics: { organicErrors: [], injectedFaults: [] } });
    } catch (error) {
      const errorText = [error?.message, error?.detail ? `detail: ${error.detail}` : ""]
        .filter(Boolean)
        .join(" | ");
      await recordStressResult(testCase, {
        outcome: "failed",
        error: String(errorText || error),
        metrics: { organicErrors: [], injectedFaults: [] }
      });
      if (error?.detail) {error.message = errorText;}
      throw error;
    }
  });
}
