import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  materializeMbtDriverBinJob,
  startMbtDriverBinJob
} from "../../../src/mbt/driver-bin-execution-service.js";
import {
  createAssignedDriverBinFixture,
  driverBinEvent,
  enabledDriverBinBoundary
} from "../support/driver-bin-fixtures.js";

after(async () => {
  await closeDb();
});

async function firstJob(label) {
  const fixture = await createAssignedDriverBinFixture(label);
  const job = await materializeMbtDriverBinJob(fixture.jobs[0], {
    clientVersion: "2026.08.03.1",
    minimumClientVersion: "2026.08.03.1"
  });
  const manifest = {
    manifestId: crypto.randomUUID(),
    schemaVersion: 2,
    planId: fixture.planId,
    planRevision: fixture.assignment.planRevision
  };
  return { fixture, job, manifest };
}

test("P3-F19 hardening: bounded device clock lead preserves all three evidence clocks", async () => {
  const { fixture, job, manifest } = await firstJob("bounded-device-clock");
  const receivedAt = new Date();
  const occurredAt = new Date(receivedAt.getTime() + 4 * 60 * 1_000);
  const event = driverBinEvent(fixture, job, "job_started", 1, {}, {
    manifestId: manifest.manifestId,
    receivedAt: receivedAt.toISOString(),
    occurredAt: occurredAt.toISOString()
  });
  await startMbtDriverBinJob({ event, job, manifest }, {
    capability: enabledDriverBinBoundary
  });
  const stored = await query(
    `SELECT device_occurred_at, server_received_at, server_applied_at
       FROM mbt_driver_bin_event_applications
      WHERE source_event_id = $1::uuid`,
    [event.eventId]
  );
  assert.equal(stored.rowCount, 1);
  assert.equal(new Date(stored.rows[0].device_occurred_at).toISOString(), occurredAt.toISOString());
  assert.equal(new Date(stored.rows[0].server_received_at).toISOString(), receivedAt.toISOString());
  assert.ok(new Date(stored.rows[0].server_applied_at).getTime() >= receivedAt.getTime());
});

test("P3-F19 hardening: more than five minutes of forward device skew fails before a ledger write", async () => {
  const { fixture, job, manifest } = await firstJob("excess-device-clock");
  const receivedAt = new Date();
  const event = driverBinEvent(fixture, job, "job_started", 1, {}, {
    manifestId: manifest.manifestId,
    receivedAt: receivedAt.toISOString(),
    occurredAt: new Date(receivedAt.getTime() + 5 * 60 * 1_000 + 1).toISOString()
  });
  await assert.rejects(
    startMbtDriverBinJob({ event, job, manifest }, {
      capability: enabledDriverBinBoundary
    }),
    (error) => error?.code === "MBT_DRIVER_BIN_INPUT_INVALID"
  );
  const stored = await query(
    "SELECT count(*)::int AS count FROM mbt_driver_bin_event_applications WHERE source_event_id = $1::uuid",
    [event.eventId]
  );
  assert.equal(stored.rows[0].count, 0);
});
