import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb } from "../../../src/db.js";
import {
  createAssignedDriverBinFixture,
  driverBinDurableState,
  driverBinEvent,
  enabledDriverBinBoundary
} from "../support/driver-bin-fixtures.js";

const execution = /** @type {Record<string, Function>} */ (await import(
  "../../../src/mbt/driver-bin-execution-service.js"
).catch((error) => {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") {
    throw error;
  }
  return {};
}));

function requiredOperation(name) {
  const operation = execution[name];
  assert.equal(typeof operation, "function", `P3.9 requires concurrency-safe ${name}.`);
  return operation;
}

async function together(operations) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = operations.map(async (operation) => {
    await gate;
    return operation();
  });
  release();
  return Promise.allSettled(pending);
}

after(async () => {
  await closeDb();
});

test("P3-F19: 25 simultaneous exact offline completion retries create one movement/evidence/acknowledgement", {
  timeout: 120_000
}, async () => {
  const materializeMbtDriverBinJob = requiredOperation("materializeMbtDriverBinJob");
  const completeMbtDriverBinJob = requiredOperation("completeMbtDriverBinJob");
  const fixture = await createAssignedDriverBinFixture("sync-race");
  const collect = await materializeMbtDriverBinJob(fixture.jobs[0], {
    clientVersion: "2026.08.03.1",
    minimumClientVersion: "2026.08.03.1"
  });
  const manifest = { manifestId: crypto.randomUUID(), schemaVersion: 2, planId: fixture.planId };
  const event = driverBinEvent(fixture, collect, "job_completed", 1, {
    mbt: {
      schemaVersion: "mbt-driver-bin-event-v1",
      actionCode: "collect_empty_bin",
      scans: [{
        evidenceCode: "outgoing_bin_scan",
        assetRole: "outgoing",
        assetId: fixture.assetId,
        scannedValue: fixture.assetCode
      }]
    }
  }, { manifestId: manifest.manifestId });
  const outcomes = await together(Array.from({ length: 25 }, () => () =>
    completeMbtDriverBinJob({
      event: structuredClone(event),
      job: structuredClone(collect),
      manifest: structuredClone(manifest),
      photoReferences: []
    }, { capability: enabledDriverBinBoundary })
  ));
  assert.equal(outcomes.every(({ status }) => status === "fulfilled"), true, JSON.stringify(outcomes));
  const results = outcomes.map(({ value }) => value);
  assert.equal(results.filter(({ replayed }) => replayed === false).length, 1);
  assert.equal(results.filter(({ replayed }) => replayed === true).length, 24);
  assert.equal(new Set(results.map(({ body }) => JSON.stringify(body))).size, 1);
  const state = await driverBinDurableState(fixture);
  assert.equal(state.movement_count, 2);
  assert.equal(state.evidence_count, 1);
  assert.equal(state.application_count, 1);
  assert.equal(state.completed_driver_record_count, 1);
});

test("P3-F19: competing event IDs for one physical job yield one winner and one review-safe conflict", async () => {
  const materializeMbtDriverBinJob = requiredOperation("materializeMbtDriverBinJob");
  const completeMbtDriverBinJob = requiredOperation("completeMbtDriverBinJob");
  const fixture = await createAssignedDriverBinFixture("event-conflict");
  const collect = await materializeMbtDriverBinJob(fixture.jobs[0], {
    clientVersion: "2026.08.03.1",
    minimumClientVersion: "2026.08.03.1"
  });
  const manifest = { manifestId: crypto.randomUUID(), schemaVersion: 2, planId: fixture.planId };
  const details = {
    mbt: {
      schemaVersion: "mbt-driver-bin-event-v1",
      actionCode: "collect_empty_bin",
      scans: [{
        evidenceCode: "outgoing_bin_scan",
        assetRole: "outgoing",
        assetId: fixture.assetId,
        scannedValue: fixture.assetCode
      }]
    }
  };
  const first = driverBinEvent(fixture, collect, "job_completed", 1, details, { manifestId: manifest.manifestId });
  const second = driverBinEvent(fixture, collect, "job_completed", 1, details, { manifestId: manifest.manifestId });
  const outcomes = await together([first, second].map((event) => () =>
    completeMbtDriverBinJob({ event, job: collect, manifest, photoReferences: [] }, {
      capability: enabledDriverBinBoundary
    })
  ));
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  const loser = outcomes.find(({ status }) => status === "rejected");
  assert.equal(loser.reason?.code, "MBT_DRIVER_BIN_JOB_ALREADY_APPLIED");
  const state = await driverBinDurableState(fixture);
  assert.equal(state.movement_count, 2);
  assert.equal(state.evidence_count, 1);
  assert.equal(state.application_count, 1);
});
