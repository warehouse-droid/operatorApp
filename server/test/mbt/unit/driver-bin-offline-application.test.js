import assert from "node:assert/strict";
import test from "node:test";

const application = /** @type {Record<string, Function>} */ (await import(
  "../../../src/mbt/driver-bin-offline-application.js"
).catch((error) => {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") {
    throw error;
  }
  return {};
}));

function requiredOperation() {
  assert.equal(
    typeof application.applyMbtDriverBinOfflineEvent,
    "function",
    "P3.9 requires a testable dedicated offline-queue BIN application boundary."
  );
  return application.applyMbtDriverBinOfflineEvent;
}

function binContext(eventType = "job_started") {
  return {
    event: {
      eventId: "00000000-0000-4000-8000-000000000991",
      eventType
    },
    job: {
      jobId: "p3-bin-offline-boundary-job",
      mbt: { schemaVersion: "mbt-driver-bin-job-v1" }
    },
    manifest: { manifestId: "00000000-0000-4000-8000-000000000992" },
    photoReferences: ["r2://driver-photo/p3-bin-boundary.jpg"]
  };
}

test("P3-F19: ordinary offline events remain outside the dedicated BIN application boundary", async () => {
  const applyMbtDriverBinOfflineEvent = requiredOperation();
  let called = false;
  const result = await applyMbtDriverBinOfflineEvent({
    event: { eventType: "job_started" },
    job: { jobId: "ordinary-job" }
  }, {
    startOperation: async () => { called = true; },
    completeOperation: async () => { called = true; }
  });
  assert.equal(result, null);
  assert.equal(called, false);
});

test("P3-F19: issued-manifest starts and completions call only their dedicated operation and replay result", async () => {
  const applyMbtDriverBinOfflineEvent = requiredOperation();
  const calls = [];
  const operations = {
    startOperation: async (input, boundary) => {
      calls.push({ kind: "start", input, boundary });
      return { replayed: false, body: { eventId: input.event.eventId, status: "in_progress" } };
    },
    completeOperation: async (input, boundary) => {
      calls.push({ kind: "complete", input, boundary });
      return { replayed: true, body: { eventId: input.event.eventId, status: "completed" } };
    }
  };

  const started = await applyMbtDriverBinOfflineEvent(binContext("job_started"), operations);
  const completed = await applyMbtDriverBinOfflineEvent(binContext("job_completed"), operations);

  assert.deepEqual(started, {
    eventId: "00000000-0000-4000-8000-000000000991",
    status: "in_progress",
    replayed: false
  });
  assert.deepEqual(completed, {
    eventId: "00000000-0000-4000-8000-000000000991",
    status: "completed",
    replayed: true
  });
  assert.deepEqual(calls.map(({ kind, input, boundary }) => ({
    kind,
    photoReferences: input.photoReferences,
    issuedManifestAuthorized: boundary.capability.issuedManifestAuthorized
  })), [
    {
      kind: "start",
      photoReferences: ["r2://driver-photo/p3-bin-boundary.jpg"],
      issuedManifestAuthorized: true
    },
    {
      kind: "complete",
      photoReferences: ["r2://driver-photo/p3-bin-boundary.jpg"],
      issuedManifestAuthorized: true
    }
  ]);
});

test("P3-F19: unsupported BIN schema or event types fail closed before generic Driver side effects", async () => {
  const applyMbtDriverBinOfflineEvent = requiredOperation();
  const operations = {
    startOperation: async () => assert.fail("unsupported input must not start"),
    completeOperation: async () => assert.fail("unsupported input must not complete")
  };
  const wrongSchema = binContext();
  wrongSchema.job.mbt.schemaVersion = "mbt-driver-bin-job-v999";
  await assert.rejects(
    () => applyMbtDriverBinOfflineEvent(wrongSchema, operations),
    (error) => error?.code === "MBT_DRIVER_BIN_JOB_UNSUPPORTED"
  );
  await assert.rejects(
    () => applyMbtDriverBinOfflineEvent(binContext("rest_started"), operations),
    (error) => error?.code === "MBT_DRIVER_BIN_EVENT_UNSUPPORTED"
  );
});
