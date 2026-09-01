// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildAnonymizedWorkloadReplayPlan,
  validateAnonymizedWorkloadFixture
} from "../../../src/application-workload-replay.js";

const fixture = JSON.parse(await readFile(
  new URL("../../fixtures/production-workload-2026-08-27.anonymized.json", import.meta.url),
  "utf8"
));

test("WL-21 today fixture is PII-free and internally accounts for every webhook entity", () => {
  assert.equal(validateAnonymizedWorkloadFixture(fixture).ok, true);
  const serialized = JSON.stringify(fixture);
  assert.doesNotMatch(serialized, /"(?:tranid|orderRef|customer|address|itemId|prompt|response|rawBody)"\s*:/iu);
  const eventCount = fixture.webhookEntityMultiplicity.reduce(
    (total, row) => total + (row.eventsPerEntity * row.entities),
    0
  );
  assert.equal(eventCount, 330);
});

test("WL-22 replay plan exposes write amplification and a serial/coalesced optimized schedule", () => {
  const replay = buildAnonymizedWorkloadReplayPlan(fixture);
  assert.equal(replay.legacy.printerAuditWrites, 25565);
  assert.equal(replay.optimized.printerAuditWrites, 0);
  assert.equal(replay.legacy.webhookApplications, 330);
  assert.equal(replay.optimized.minimumWebhookApplications, 219);
  assert.equal(replay.optimized.maximumWebhookApplications, 330);
  assert.equal(replay.optimized.workerConcurrency, 1);
  assert.equal(replay.peak.events, 395);
  assert.ok(replay.legacy.estimatedDatabaseWrites > replay.optimized.minimumEstimatedDatabaseWrites);
});
