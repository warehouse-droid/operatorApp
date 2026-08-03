import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  persistDriverOfflineDayPlan,
  registerDriverOfflineEvents
} from "./driver-offline-repository.js";
import { foregroundReceiptResult } from "./driver-offline-service.js";

const serverSource = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
const repositorySource = fs.readFileSync(new URL("./driver-offline-repository.js", import.meta.url), "utf8");
const serviceSource = fs.readFileSync(new URL("./driver-offline-service.js", import.meta.url), "utf8");
assert.match(
  serverSource,
  /if \(!occurredAt\)[\s\S]{0,240}DRIVER_FOREGROUND_OCCURRENCE_REQUIRED/,
  "Foreground local-first actions must require a valid device occurrence time."
);
assert.match(
  serverSource,
  /canonicalDriverForegroundOccurrence\(row\.device_occurred_at\) !== occurredAt/,
  "Foreground idempotency must reject a reused event ID with a different occurrence time."
);
assert.match(
  serverSource,
  /Date\.now\(\) >= manifestExpiry[\s\S]{0,400}DRIVER_FOREGROUND_MANIFEST_EXPIRED/,
  "A new foreground action must not execute after its route manifest expires."
);
const dvirRoute = serverSource.match(/app\.post\("\/api\/driver\/dvir"[\s\S]*?\n\}\);/)?.[0] || "";
assert.ok(
  dvirRoute.indexOf("requireRegisteredForegroundDvirEvidence")
    < dvirRoute.indexOf("beginDriverForegroundAction"),
  "A foreground DVIR must bind durable event evidence before creating an external-action receipt."
);
assert.match(
  serverSource,
  /async function requireRegisteredForegroundDvirEvidence[\s\S]*durableReferences[\s\S]*DRIVER_FOREGROUND_DVIR_EVIDENCE_MISMATCH/,
  "Foreground DVIR references must exactly match durably verified registered photos."
);
assert.match(
  repositorySource,
  /event\.eventType === "dvir_captured"\s*\?\s*4[\s\S]{0,700}reviewReasons\.push[\s\S]{0,300}operational effects are blocked/,
  "A DVIR without four photo descriptors must be retained for review with operational effects blocked."
);
assert.match(
  serviceSource,
  /event\.eventType === "dvir_captured"[\s\S]{0,160}validatePhotoEvidence\(event, null\)/,
  "A foreground receipt must not bypass durable DVIR photo validation."
);
assert.ok(
  dvirRoute.indexOf("getDriverOfflineReconciliationReceipt") >= 0
    && dvirRoute.indexOf("getDriverOfflineReconciliationReceipt")
      < dvirRoute.indexOf("const submitted = await submitDriverDvir"),
  "Foreground DVIR must inspect a competing offline reconciliation receipt before calling Samsara."
);
const offlineDvirReconciliationRoute = serverSource.match(
  /app\.post\("\/api\/driver\/offline-events\/:eventId\/reconcile-dvir"[\s\S]*?\n\}\);/
)?.[0] || "";
assert.ok(
  offlineDvirReconciliationRoute.indexOf("FROM driver_foreground_action_receipts") >= 0
    && offlineDvirReconciliationRoute.indexOf("FROM driver_foreground_action_receipts")
      < offlineDvirReconciliationRoute.indexOf("const dvir = await submitDriverDvir"),
  "Offline DVIR reconciliation must inspect a competing foreground receipt before calling Samsara."
);
assert.match(
  offlineDvirReconciliationRoute,
  /competingForegroundReceipt\.rowCount[\s\S]{0,900}return finalizeReview/,
  "A competing foreground receipt must atomically close offline reconciliation as review-only."
);
const offlineDvirExecution = offlineDvirReconciliationRoute.slice(
  offlineDvirReconciliationRoute.indexOf("const dvir = await submitDriverDvir")
);
assert.ok(
  offlineDvirExecution.indexOf("mergeAppliedDriverOfflineReconciliationResult") >= 0
    && offlineDvirExecution.indexOf("mergeAppliedDriverOfflineReconciliationResult")
      < offlineDvirExecution.indexOf("completeDriverOfflineReconciliationReceipt"),
  "A confirmed offline DVIR must mark its event reconciled before its receipt is completed in the same locked transaction."
);

const suffix = crypto.randomBytes(6).toString("hex");
const driverLogin = `foreground-receipt-${suffix}`;
const deviceId = `foreground-device-${suffix}`;
const manifestId = crypto.randomUUID();
const planDate = "2098-07-17";
const job = {
  jobId: `foreground-job-${suffix}`,
  planId: null,
  planDate,
  driverLogin,
  truckId: "TRUCK-ID",
  truckPlate: "TEST-201",
  loadId: "LOAD-1",
  loadName: "Foreground Harness",
  stopId: "STOP-1",
  stopType: "pickup",
  location: "3445",
  pickupLocation: "3445",
  orderRefs: ["TO-FOREGROUND"],
  orderTypes: ["TO"],
  lineRowIds: ["11"],
  requiredPhotos: 0
};

function receiptContext(manifest, event) {
  return {
    manifestId: manifest.manifestId,
    planId: manifest.planId,
    planDate: manifest.planDate,
    planRevision: Number(manifest.planRevision || 0),
    clientSequence: event.clientSequence,
    jobFingerprint: event.jobFingerprint,
    predecessorFingerprint: event.predecessorFingerprint,
    truckPlate: job.truckPlate
  };
}

async function insertAppliedReceipt(manifest, event, deviceOccurredAt) {
  await query(
    `INSERT INTO driver_foreground_action_receipts (
       event_id, driver_login, device_id, action_type, target_id,
       event_context, device_occurred_at, status, result, completed_at
     ) VALUES (
       $1::uuid, $2, $3, 'job_started', $4,
       $5::jsonb, $6::timestamptz, 'applied', '{"recorded":true}'::jsonb, now()
     )`,
    [
      event.eventId,
      driverLogin,
      deviceId,
      job.jobId,
      JSON.stringify(receiptContext(manifest, event)),
      deviceOccurredAt
    ]
  );
}

const rollback = await beginRollbackContext();
try {
  await rollback.run(async () => {
    const manifest = await persistDriverOfflineDayPlan({
      manifestId,
      driverLogin,
      deviceId,
      planMetadata: { planId: null, planDate, planRevision: 3 },
      jobs: [job],
      driverProfile: { login: driverLogin, name: "Foreground Harness" },
      dayState: { planDate, truckPlate: job.truckPlate, preDvirStatus: "complete" },
      samsaraWorkflowEnabled: false
    });
    const manifestJob = manifest.jobs[0];
    const missingDvirEvidence = (await registerDriverOfflineEvents({
        driverLogin,
        deviceId,
        manifestId,
        events: [{
          eventId: crypto.randomUUID(),
          clientSequence: 99,
          eventType: "dvir_captured",
          occurredAt: new Date().toISOString(),
          locationStatus: "not_required",
          details: { dvirType: "pre", truckPlate: job.truckPlate },
          photos: []
        }]
      }))[0];
    assert.equal(missingDvirEvidence.status, "review_required");
    assert.match(missingDvirEvidence.reviewReason, /includes 0 of 4 required photo descriptors/i);
    const createEvent = async (clientSequence) => {
      const occurredAt = new Date(Date.now() - clientSequence * 1000).toISOString();
      return (await registerDriverOfflineEvents({
        driverLogin,
        deviceId,
        manifestId,
        events: [{
          eventId: crypto.randomUUID(),
          clientSequence,
          eventType: "job_started",
          jobId: job.jobId,
          jobFingerprint: manifestJob.fingerprint,
          predecessorFingerprint: manifestJob.predecessorFingerprint,
          occurredAt,
          locationStatus: "not_checked_offline",
          photos: []
        }]
      }))[0];
    };

    const mismatched = await createEvent(1);
    await insertAppliedReceipt(
      manifest,
      mismatched,
      new Date(new Date(mismatched.occurredAt).getTime() + 1000).toISOString()
    );
    const rejected = await foregroundReceiptResult(mismatched, manifest);
    assert.equal(rejected.status, "review_required");
    assert.equal(rejected.result?.code, "OFFLINE_FOREGROUND_RECEIPT_MISMATCH");

    const matching = await createEvent(2);
    await insertAppliedReceipt(manifest, matching, new Date(matching.occurredAt).toISOString());
    const acknowledged = await foregroundReceiptResult(matching, manifest);
    assert.equal(acknowledged.status, "applied");
    assert.equal(acknowledged.result?.foregroundReceipt, true);
  });
  console.log("Driver foreground receipt rollback harness passed.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await rollback.rollback();
  await closeDb();
}
