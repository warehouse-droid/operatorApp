import assert from "node:assert/strict";
import crypto from "node:crypto";
import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  DRIVER_OFFLINE_ROUTE_START,
  authenticateDriverOfflineGrant,
  authorizeOfflinePhotoUpload,
  canonicalDriverOfflineJobIdentity,
  consumeDriverLocationVerification,
  countDriverOfflineReviews,
  createDriverLocationVerification,
  createDriverSession,
  driverOfflineManifestMatchesJobs,
  driverOfflineRouteBootstrap,
  dismissDriverClientSyncIssue,
  fingerprintDriverOfflineJob,
  fingerprintDriverOfflineJobContent,
  findOpenDriverOfflineJobCompletion,
  getDriverOfflineEvent,
  getDriverOfflineReview,
  getDriverOfflineSyncQueue,
  getDriverSession,
  listDriverClientSyncIssues,
  markDriverOfflineEventApplied,
  markDriverOfflineEventBlocked,
  markDriverOfflineEventReviewRequired,
  markDriverOfflinePhotoDurable,
  materializeDriverOfflineJobs,
  persistDriverOfflineDayPlan,
  recordDriverOfflinePhotoReceipts,
  recordDriverOfflinePhotoVerificationFailure,
  recordDriverClientSyncStatus,
  registerDriverOfflineEvents,
  releaseDriverOfflineEventForReplay,
  resolveDriverOfflineReview,
  revokeDriverSession,
  sanitizeDriverOfflineEventDetails,
  sanitizeDriverOfflineJob,
  torontoManifestExpiry
} from "./driver-offline-repository.js";
import {
  beginDriverOfflineReconciliationReceipt,
  completeDriverOfflineReconciliationReceipt,
  driverOfflineReconciliationDateSafety,
  markDriverOfflineReconciliationReceiptUncertain,
  releaseDriverOfflineReconciliationReceipt
} from "./driver-offline-reconciliation-repository.js";
import { findDriverOfflineCompletionConflict, processDriverOfflineQueue } from "./driver-offline-service.js";
import {
  getDriverDayState,
  listDriverHistory,
  recordDriverJobPhotos,
  recordOfflineDriverTruckSwitch
} from "./driver-repository.js";

const suffix = crypto.randomBytes(6).toString("hex");
const driverLogin = `offline-harness-${suffix}`;
const deviceId = `offline-device-${suffix}`;
const secondDeviceId = `offline-device-2-${suffix}`;
const duplicateDeviceId = `offline-duplicate-device-${suffix}`;
const manifestId = crypto.randomUUID();
const secondManifestId = crypto.randomUUID();
const duplicateManifestId = crypto.randomUUID();
const startedEventId = crypto.randomUUID();
const completedEventId = crypto.randomUUID();
const duplicateCompletionEventId = crypto.randomUUID();
const reviewEventId = crypto.randomUUID();
const crossDeviceBlockedEventId = crypto.randomUUID();
const blockedEventId = crypto.randomUUID();
const photoId = crypto.randomUUID();
const duplicatePhotoId = crypto.randomUUID();
const missingPhotoDriverLogin = `offline-missing-photo-${suffix}`;
const missingPhotoDeviceId = `offline-missing-photo-device-${suffix}`;
const missingPhotoManifestId = crypto.randomUUID();
const missingPhotoEventId = crypto.randomUUID();
const missingPhotoLaterEventId = crypto.randomUUID();
const planDate = "2098-07-16";
const sha256 = "a".repeat(64);
const occurredAt = (minutes) => new Date(Date.now() - 60 * 60 * 1000 + minutes * 60 * 1000).toISOString();

assert.deepEqual(
  sanitizeDriverOfflineEventDetails("job_completed", {
    driverRemark: "  Left the pallet beside receiving.  ",
    ignoredPrivateField: "not retained"
  }),
  {
    locationOverrideReason: "",
    driverRemark: "Left the pallet beside receiving."
  },
  "A completion must retain a trimmed driver remark without accepting unrelated fields."
);
assert.deepEqual(
  sanitizeDriverOfflineEventDetails("job_started", { driverRemark: "not applicable" }),
  { locationOverrideReason: "" },
  "A driver remark belongs only to the stop-completion event."
);
assert.throws(
  () => sanitizeDriverOfflineEventDetails("job_completed", { driverRemark: "x".repeat(1001) }),
  (error) => error.status === 400,
  "The server must reject a driver remark beyond the client limit."
);

const baseJob = {
  jobId: `offline-job-${suffix}`,
  planId: null,
  planDate,
  driverLogin,
  driverName: "Offline Harness",
  truckId: "TRUCK-ID",
  truckPlate: "TEST-101",
  loadId: "LOAD-1",
  loadName: "Harness Load",
  stopId: "STOP-1",
  stopType: "pickup",
  location: "3445",
  pickupLocation: "3445",
  address: "3445 Kennedy Road",
  instructions: "Display-only instructions",
  orderRefs: ["TO-HARNESS"],
  orderTypes: ["TO"],
  lineRowIds: ["11"],
  requiredPhotos: 1
};

assert.equal(
  torontoManifestExpiry("2026-03-07").toISOString(),
  "2026-03-08T16:00:00.000Z",
  "Toronto expiry must honor the spring DST transition."
);
assert.equal(
  torontoManifestExpiry("2026-10-31").toISOString(),
  "2026-11-01T17:00:00.000Z",
  "Toronto expiry must honor the fall DST transition."
);
assert.equal(
  driverOfflineReconciliationDateSafety("2026-07-31", "2026-07-31").allowed,
  true,
  "Samsara reconciliation may run only for the active Toronto driver day."
);
assert.equal(
  driverOfflineReconciliationDateSafety("2026-07-30", "2026-07-31").allowed,
  false,
  "A still-valid prior-day manifest must not trigger stale Samsara writes."
);
assert.deepEqual(
  canonicalDriverOfflineJobIdentity(baseJob),
  canonicalDriverOfflineJobIdentity({
    ...baseJob,
    instructions: "Changed display text",
    address: "A reformatted display address",
    windowStart: "09:00"
  }),
  "Display-only job fields must not affect operational identity."
);
assert.notEqual(
  fingerprintDriverOfflineJob(baseJob),
  fingerprintDriverOfflineJob({ ...baseJob, pickupLocation: "2967" }),
  "An operational location change must affect the fingerprint."
);
assert.notEqual(
  fingerprintDriverOfflineJobContent(baseJob),
  fingerprintDriverOfflineJobContent({ ...baseJob, address: "12441 Woodbine Avenue", instructions: "Updated by Dispatch" }),
  "Every driver-facing stop detail must affect the route-content fingerprint even when immutable job identity is unchanged."
);
assert.deepEqual(
  sanitizeDriverOfflineJob({
    ...baseJob,
    orders: [{
      orderRef: "TO-HARNESS",
      items: [{
        itemName: "Harness Item",
        units: [
          { unit: "PLT", value: 2, fallback: true },
          { label: "PCS", quantity: 7 }
        ]
      }]
    }]
  }).orders[0].items[0].units,
  [
    { unit: "PLT", label: "PLT", value: 2, fallback: true },
    { unit: "PCS", label: "PCS", value: 7 }
  ],
  "Offline job snapshots must retain canonical UOM fields and normalize legacy labels."
);
const pureJobs = materializeDriverOfflineJobs([
  baseJob,
  { ...baseJob, jobId: `${baseJob.jobId}-2`, stopId: "STOP-2", requiredPhotos: 0 }
], driverLogin);
assert.equal(pureJobs[0].predecessorFingerprint, DRIVER_OFFLINE_ROUTE_START);
assert.equal(pureJobs[1].predecessorFingerprint, pureJobs[0].fingerprint);
const pureManifest = {
  manifestId,
  complete: true,
  jobs: pureJobs.map((entry) => ({
    ...entry.snapshot,
    fingerprint: entry.fingerprint,
    contentFingerprint: entry.contentFingerprint,
    predecessorFingerprint: entry.predecessorFingerprint
  }))
};
assert.equal(
  driverOfflineManifestMatchesJobs(pureManifest, [baseJob, pureJobs[1].snapshot], driverLogin),
  true,
  "A complete unchanged materialized route may reuse its manifest."
);
assert.equal(
  driverOfflineManifestMatchesJobs(
    pureManifest,
    [{ ...baseJob, location: "12441", pickupLocation: "12441", address: "12441 Woodbine Avenue" }, pureJobs[1].snapshot],
    driverLogin
  ),
  false,
  "A same-plan, same-revision location change must invalidate the cached manifest."
);

const bootstrapPredecessor = {
  ...baseJob,
  jobId: `${baseJob.jobId}-bootstrap-predecessor`,
  stopId: "BOOTSTRAP-PREDECESSOR",
  stopType: "dropoff",
  location: "BWS Woodbridge",
  pickupLocation: "",
  dropLocation: "BWS Woodbridge",
  address: "8821 Weston Rd, Woodbridge, ON L4L 1A6",
  requiredPhotos: 2
};
const rawBootstrapCurrent = {
  ...baseJob,
  jobId: `${baseJob.jobId}-bootstrap-current`,
  stopId: "BOOTSTRAP-CURRENT",
  stopType: "travel",
  location: "BWS Woodbridge to BWS Woodbridge",
  pickupLocation: "",
  fromLocation: "BWS Woodbridge",
  fromJobLocation: "BWS Woodbridge",
  fromAddress: "8821 Weston Rd, Woodbridge, ON L4L 1A6",
  toLocation: "BWS Woodbridge",
  toAddress: "BWS Woodbridge",
  toPickupLocation: "BWS Woodbridge",
  address: "BWS Woodbridge",
  orderRefs: [],
  orderTypes: [],
  lineRowIds: [],
  requiredPhotos: 0
};
const materializedBootstrapCurrent = {
  ...rawBootstrapCurrent,
  address: "8821 Weston Rd, Woodbridge, ON L4L 1A6"
};
const materializedBootstrapEntries = materializeDriverOfflineJobs(
  [bootstrapPredecessor, materializedBootstrapCurrent],
  driverLogin
);
const materializedBootstrapManifest = {
  manifestId: crypto.randomUUID(),
  complete: true,
  jobs: materializedBootstrapEntries.map((entry) => ({
    ...entry.snapshot,
    fingerprint: entry.fingerprint,
    contentFingerprint: entry.contentFingerprint,
    predecessorFingerprint: entry.predecessorFingerprint
  }))
};
assert.equal(
  fingerprintDriverOfflineJob(rawBootstrapCurrent),
  fingerprintDriverOfflineJob(materializedBootstrapCurrent),
  "Address materialization must not change the current job's operational identity."
);
assert.equal(
  driverOfflineManifestMatchesJobs(
    materializedBootstrapManifest,
    [bootstrapPredecessor, rawBootstrapCurrent],
    driverLogin,
    { requireComplete: false, requiredJobId: rawBootstrapCurrent.jobId }
  ),
  false,
  "A raw current-job placeholder must not match a fully materialized manifest snapshot."
);
const mergedBootstrapComparison = [
  bootstrapPredecessor,
  { ...rawBootstrapCurrent, ...materializedBootstrapCurrent }
];
assert.equal(
  driverOfflineManifestMatchesJobs(
    materializedBootstrapManifest,
    mergedBootstrapComparison,
    driverLogin,
    { requireComplete: false, requiredJobId: rawBootstrapCurrent.jobId }
  ),
  true,
  "Merging the already-materialized context.job must match the required current job and predecessor."
);
assert.equal(
  materializedBootstrapManifest.jobs[1].predecessorFingerprint,
  fingerprintDriverOfflineJob(bootstrapPredecessor),
  "Materializing only the current job must preserve its canonical predecessor fingerprint."
);
assert.equal(
  driverOfflineManifestMatchesJobs(
    materializedBootstrapManifest,
    [
      bootstrapPredecessor,
      { ...materializedBootstrapCurrent, address: "9000 Changed Road, Vaughan, ON" }
    ],
    driverLogin,
    { requireComplete: false, requiredJobId: rawBootstrapCurrent.jobId }
  ),
  false,
  "A genuine Driver-visible current-stop change must still invalidate bootstrap reuse."
);
const secondBootstrap = driverOfflineRouteBootstrap({
  manifestId,
  jobs: pureJobs.map((entry) => ({
    ...entry.snapshot,
    fingerprint: entry.fingerprint,
    predecessorFingerprint: entry.predecessorFingerprint
  }))
}, pureJobs[1].snapshot.jobId);
assert.equal(secondBootstrap.currentJobFingerprint, pureJobs[1].fingerprint);
assert.equal(secondBootstrap.predecessorFingerprint, pureJobs[0].fingerprint);

const rollback = await beginRollbackContext();
try {
  await rollback.run(async () => {
    const schema = await query(
      `SELECT
         to_regclass('public.driver_sessions') AS sessions,
         to_regclass('public.driver_offline_manifests') AS manifests,
         to_regclass('public.driver_offline_manifest_jobs') AS jobs,
         to_regclass('public.driver_offline_sync_grants') AS grants,
         to_regclass('public.driver_offline_events') AS events,
         to_regclass('public.driver_offline_event_photos') AS photos,
         to_regclass('public.driver_offline_resolutions') AS resolutions,
         to_regclass('public.driver_offline_retry_attempts') AS retry_attempts,
         to_regclass('public.driver_foreground_action_receipts') AS foreground_receipts,
         to_regclass('public.driver_location_verifications') AS location_verifications,
         to_regclass('public.driver_offline_reconciliation_receipts') AS reconciliation_receipts`
    );
    assert.ok(
      Object.values(schema.rows[0]).every(Boolean),
      "Driver offline migrations 089 through 093 must be installed."
    );
    const photoVerificationColumns = await query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'driver_offline_event_photos'
          AND column_name = ANY($1::text[])`,
      [[
        "verification_attempt_count",
        "last_verification_attempt_at",
        "last_verification_error_code",
        "last_verification_error"
      ]]
    );
    assert.deepEqual(
      new Set(photoVerificationColumns.rows.map((row) => row.column_name)),
      new Set([
        "verification_attempt_count",
        "last_verification_attempt_at",
        "last_verification_error_code",
        "last_verification_error"
      ]),
      "Offline photo verification failures must have durable, queryable diagnostics."
    );

    const createdSession = await createDriverSession(driverLogin, {
      deviceId,
      metadata: { harness: true }
    });
    assert.equal(createdSession.session.driverLogin, driverLogin);
    assert.equal((await getDriverSession(createdSession.token))?.deviceId, deviceId);
    await recordDriverClientSyncStatus({
      sessionId: createdSession.session.sessionId,
      driverLogin,
      deviceId,
      status: {
        state: "error",
        errorName: "UnknownError",
        errorCode: "indexeddb_transaction_failed",
        errorMessage: "IndexedDB transaction failed.",
        manifestId,
        planDate,
        pendingEventCount: 2,
        unsyncedPhotoCount: 1,
        photoFailures: Array.from({ length: 12 }, (_, index) => ({
          photoId: `photo-${index}`,
          eventId: `event-${index}`,
          phase: index === 0 ? "upload" : "ticket",
          byteSize: 1000000 + index,
          attemptCount: index + 1,
          retryable: index !== 1,
          errorCode: index === 0 ? "upstream_timeout" : "ticket_failed",
          httpStatus: index === 0 ? 503 : 0,
          message: index === 0
            ? `<gateway> ${"x".repeat(1200)}`
            : `Photo ${index} failed.`,
          privateBlob: "must not be retained"
        })),
        clientOccurredAt: new Date().toISOString()
      }
    });
    let clientSyncIssues = await listDriverClientSyncIssues({ planDate, driverLogin });
    assert.equal(clientSyncIssues.length, 1);
    assert.equal(clientSyncIssues[0].errorMessage, "IndexedDB transaction failed.");
    assert.equal(clientSyncIssues[0].pendingEventCount, 2);
    assert.equal(clientSyncIssues[0].photoFailures.length, 10, "Photo diagnostics must have a hard record limit.");
    assert.deepEqual(
      clientSyncIssues[0].photoFailures[0],
      {
        photoId: "photo-0",
        eventId: "event-0",
        phase: "upload",
        byteSize: 1000000,
        attemptCount: 1,
        retryable: true,
        errorCode: "upstream_timeout",
        httpStatus: 503,
        message: `<gateway> ${"x".repeat(990)}`
      },
      "Dispatch must receive only the bounded diagnostic allowlist."
    );
    assert.equal("privateBlob" in clientSyncIssues[0].photoFailures[0], false);
    assert.equal(
      (await getDriverSession(createdSession.token, { touch: false }))?.metadata?.harness,
      true,
      "Sync telemetry must preserve existing session metadata."
    );
    const reportedAtToDismiss = clientSyncIssues[0].reportedAt;
    await assert.rejects(
      dismissDriverClientSyncIssue({
        sessionId: createdSession.session.sessionId,
        expectedReportedAt: reportedAtToDismiss,
        auditNote: "   ",
        dismissedBy: "Offline harness"
      }),
      (error) => error.status === 400,
      "Dispatch must provide a nonblank audit note before hiding device telemetry."
    );
    const dismissedIssue = await dismissDriverClientSyncIssue({
      sessionId: createdSession.session.sessionId,
      expectedReportedAt: reportedAtToDismiss,
      auditNote: "Driver cleared this browser and repeated the affected stops.",
      dismissedBy: "Offline harness"
    });
    assert.equal(dismissedIssue.idempotentReplay, false);
    assert.equal(dismissedIssue.issue.reportedAt, reportedAtToDismiss);
    assert.equal(dismissedIssue.issue.errorMessage, "IndexedDB transaction failed.");
    assert.equal(
      (await listDriverClientSyncIssues({ planDate, driverLogin })).length,
      0,
      "A dismissed device report must no longer contribute to the Dispatch warning."
    );
    const dismissedSession = await getDriverSession(createdSession.token, { touch: false });
    assert.equal(dismissedSession.metadata.offlineSync.errorMessage, "IndexedDB transaction failed.");
    assert.equal(dismissedSession.metadata.offlineSync.pendingEventCount, 2);
    assert.equal(dismissedSession.metadata.offlineSync.unsyncedPhotoCount, 1);
    assert.equal(dismissedSession.metadata.harness, true);
    assert.equal(
      dismissedSession.metadata.offlineSync.dispatchDismissal.reportReceivedAt,
      reportedAtToDismiss,
      "Dismissal must annotate, rather than delete, the original device telemetry."
    );
    const replayedDismissal = await dismissDriverClientSyncIssue({
      sessionId: createdSession.session.sessionId,
      expectedReportedAt: reportedAtToDismiss,
      auditNote: "Repeated request must not create another dismissal.",
      dismissedBy: "Offline harness"
    });
    assert.equal(replayedDismissal.idempotentReplay, true);
    assert.equal(
      replayedDismissal.issue.dismissal.auditNote,
      "Driver cleared this browser and repeated the affected stops.",
      "An exact retry must return the first durable dismissal."
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    await recordDriverClientSyncStatus({
      sessionId: createdSession.session.sessionId,
      driverLogin,
      deviceId,
      status: {
        state: "error",
        errorMessage: "A later device report must resurface.",
        manifestId,
        planDate
      }
    });
    clientSyncIssues = await listDriverClientSyncIssues({ planDate, driverLogin });
    assert.equal(clientSyncIssues.length, 1);
    assert.equal(clientSyncIssues[0].errorMessage, "A later device report must resurface.");
    assert.notEqual(clientSyncIssues[0].reportedAt, reportedAtToDismiss);
    await assert.rejects(
      dismissDriverClientSyncIssue({
        sessionId: createdSession.session.sessionId,
        expectedReportedAt: reportedAtToDismiss,
        auditNote: "This stale screen must not dismiss the new report.",
        dismissedBy: "Offline harness"
      }),
      (error) => error.status === 409 && error.code === "DRIVER_SYNC_ISSUE_CHANGED",
      "A stale Dispatch screen must not hide newer device failure telemetry."
    );
    await recordDriverClientSyncStatus({
      sessionId: createdSession.session.sessionId,
      driverLogin,
      deviceId,
      status: { state: "ok", manifestId, planDate }
    });
    clientSyncIssues = await listDriverClientSyncIssues({ planDate, driverLogin });
    assert.equal(clientSyncIssues.length, 0, "A healthy report must clear the device's stale error.");
    await recordDriverClientSyncStatus({
      sessionId: createdSession.session.sessionId,
      driverLogin,
      deviceId,
      status: { state: "error", errorMessage: "Older session error", manifestId, planDate }
    });
    const newerSession = await createDriverSession(driverLogin, { deviceId, metadata: { harness: true } });
    await query(
      `UPDATE driver_sessions SET created_at = created_at + interval '1 second' WHERE session_id = $1::uuid`,
      [newerSession.session.sessionId]
    );
    clientSyncIssues = await listDriverClientSyncIssues({ planDate, driverLogin });
    assert.equal(clientSyncIssues.length, 0, "A newer active session with no error must suppress an older session error.");
    await recordDriverClientSyncStatus({
      sessionId: newerSession.session.sessionId,
      driverLogin,
      deviceId,
      status: { state: "error", errorMessage: "Current session error", manifestId, planDate }
    });
    clientSyncIssues = await listDriverClientSyncIssues({ planDate, driverLogin });
    assert.equal(clientSyncIssues[0]?.errorMessage, "Current session error");
    await recordDriverClientSyncStatus({
      sessionId: newerSession.session.sessionId,
      driverLogin,
      deviceId,
      status: { state: "ok", manifestId, planDate }
    });
    assert.equal((await listDriverClientSyncIssues({ planDate, driverLogin })).length, 0);
    const secondDeviceSession = await createDriverSession(driverLogin, {
      deviceId: secondDeviceId,
      metadata: { harness: true, device: "second" }
    });
    await recordDriverClientSyncStatus({
      sessionId: secondDeviceSession.session.sessionId,
      driverLogin,
      deviceId: secondDeviceId,
      status: { state: "error", errorMessage: "Second device error", manifestId, planDate }
    });
    clientSyncIssues = await listDriverClientSyncIssues({ planDate, driverLogin });
    assert.deepEqual(
      clientSyncIssues.map((issue) => issue.deviceId),
      [secondDeviceId],
      "Independent devices must not clear or inherit one another's sync state."
    );
    await query(
      `UPDATE driver_sessions
          SET created_at = created_at - interval '15 days',
              expires_at = now() - interval '1 second'
        WHERE session_id = $1::uuid`,
      [secondDeviceSession.session.sessionId]
    );
    assert.equal(
      (await listDriverClientSyncIssues({ planDate, driverLogin })).length,
      0,
      "Expired Driver sessions must not leave stale device errors in Dispatch."
    );
    const revokedDeviceId = `${secondDeviceId}-revoked`;
    const revokedDeviceSession = await createDriverSession(driverLogin, {
      deviceId: revokedDeviceId,
      metadata: { harness: true, device: "revoked" }
    });
    await recordDriverClientSyncStatus({
      sessionId: revokedDeviceSession.session.sessionId,
      driverLogin,
      deviceId: revokedDeviceId,
      status: { state: "error", errorMessage: "Revoked device error", manifestId, planDate }
    });
    assert.equal((await listDriverClientSyncIssues({ planDate, driverLogin })).length, 1);
    assert.equal(await revokeDriverSession(revokedDeviceSession.token), true);
    assert.equal(
      (await listDriverClientSyncIssues({ planDate, driverLogin })).length,
      0,
      "Revoked Driver sessions must not leave stale device errors in Dispatch."
    );
    assert.equal(await revokeDriverSession(newerSession.token), true);
    assert.equal(await revokeDriverSession(createdSession.token), true);
    assert.equal(await getDriverSession(createdSession.token), null);

    const remarkJob = {
      ...baseJob,
      jobId: `${baseJob.jobId}-remark-history`,
      stopId: "STOP-REMARK-HISTORY",
      requiredPhotos: 2
    };
    await recordDriverJobPhotos(driverLogin, remarkJob.jobId, {
      job: remarkJob,
      photoDataUrls: ["r2://driver/harness/remark-1.jpg", "r2://driver/harness/remark-2.jpg"],
      driverRemark: "Receiving door was closed."
    });
    const remarkHistory = await listDriverHistory(driverLogin, { date: planDate });
    assert.equal(
      remarkHistory.find((record) => record.details?.jobId === remarkJob.jobId)?.details?.driverRemark,
      "Receiving door was closed.",
      "A synchronized driver remark must be visible from the durable stop history record."
    );
    await assert.rejects(
      recordDriverJobPhotos(driverLogin, `${remarkJob.jobId}-too-long`, {
        job: { ...remarkJob, jobId: `${remarkJob.jobId}-too-long` },
        photoDataUrls: ["r2://driver/harness/remark-1.jpg", "r2://driver/harness/remark-2.jpg"],
        driverRemark: "x".repeat(1001)
      }),
      (error) => error.code === "DRIVER_REMARK_TOO_LONG",
      "The durable record boundary must enforce the same remark limit."
    );

    const manifest = await persistDriverOfflineDayPlan({
      manifestId,
      driverLogin,
      deviceId,
      planMetadata: { planId: null, planDate, planRevision: 7 },
      jobs: [baseJob],
      driverProfile: { login: driverLogin, name: "Offline Harness" },
      dayState: { planDate, truckPlate: "TEST-101", preDvirStatus: "complete" },
      samsaraWorkflowEnabled: false
    });
    assert.equal(manifest.jobs.length, 1);
    assert.equal(manifest.jobs[0].fingerprint, fingerprintDriverOfflineJob(baseJob));
    assert.ok(manifest.offlineSyncGrant);
    assert.equal(
      driverOfflineRouteBootstrap(manifest, baseJob.jobId).currentJobFingerprint,
      manifest.jobs[0].fingerprint
    );
    assert.equal(
      (await authenticateDriverOfflineGrant(manifest.offlineSyncGrant, { manifestId, deviceId }))?.driverLogin,
      driverLogin
    );
    assert.equal(
      await authenticateDriverOfflineGrant(manifest.offlineSyncGrant, {
        manifestId,
        deviceId: `${deviceId}-wrong`
      }),
      null
    );
    const duplicateDeviceManifest = await persistDriverOfflineDayPlan({
      manifestId: duplicateManifestId,
      driverLogin,
      deviceId: duplicateDeviceId,
      planMetadata: { planId: null, planDate, planRevision: 7 },
      jobs: [baseJob],
      driverProfile: { login: driverLogin, name: "Offline Harness" },
      dayState: { planDate, truckPlate: "TEST-101", preDvirStatus: "complete" },
      samsaraWorkflowEnabled: false
    });

    const missingPhotoJob = {
      ...baseJob,
      jobId: `offline-missing-photo-job-${suffix}`,
      driverLogin: missingPhotoDriverLogin,
      stopId: "STOP-MISSING-PHOTOS",
      requiredPhotos: 2
    };
    const missingPhotoManifest = await persistDriverOfflineDayPlan({
      manifestId: missingPhotoManifestId,
      driverLogin: missingPhotoDriverLogin,
      deviceId: missingPhotoDeviceId,
      planMetadata: { planId: null, planDate, planRevision: 1 },
      jobs: [missingPhotoJob],
      driverProfile: { login: missingPhotoDriverLogin, name: "Missing Photo Harness" },
      dayState: { planDate, truckPlate: "TEST-101", preDvirStatus: "complete" },
      samsaraWorkflowEnabled: false
    });
    const missingPhotoManifestJob = missingPhotoManifest.jobs[0];
    const missingPhotoCompletion = {
      eventId: missingPhotoEventId,
      clientSequence: 1,
      eventType: "job_completed",
      jobId: missingPhotoJob.jobId,
      jobFingerprint: missingPhotoManifestJob.fingerprint,
      predecessorFingerprint: missingPhotoManifestJob.predecessorFingerprint,
      occurredAt: occurredAt(0),
      locationStatus: "not_checked_offline",
      photos: []
    };
    const expectedMissingPhotoReason = "Job completion includes 0 of 2 required photo descriptors from its manifest. The event was retained for Dispatch review and its operational effects are blocked.";
    const eventAfterMissingPhotos = {
      eventId: missingPhotoLaterEventId,
      clientSequence: 2,
      eventType: "rest_started",
      occurredAt: occurredAt(1),
      locationStatus: "not_required",
      details: {
        restId: `missing-photo-rest-${suffix}`,
        nextJobId: missingPhotoJob.jobId
      },
      photos: []
    };
    const missingPhotoRegistration = await registerDriverOfflineEvents({
      driverLogin: missingPhotoDriverLogin,
      deviceId: missingPhotoDeviceId,
      manifestId: missingPhotoManifestId,
      events: [missingPhotoCompletion, eventAfterMissingPhotos]
    });
    assert.equal(missingPhotoRegistration[0].status, "review_required");
    assert.equal(missingPhotoRegistration[0].reviewReason, expectedMissingPhotoReason);
    assert.equal(missingPhotoRegistration[0].photos.length, 0);
    assert.equal(
      missingPhotoRegistration[1].status,
      "pending",
      "A poison event must be retained without rolling back later records in the same sync batch."
    );
    const persistedMissingPhoto = await query(
      `SELECT status, review_reason, server_received_at, COUNT(*) OVER ()::int AS event_count
         FROM driver_offline_events
        WHERE event_id = $1::uuid`,
      [missingPhotoEventId]
    );
    assert.equal(persistedMissingPhoto.rows[0].status, "review_required");
    assert.equal(persistedMissingPhoto.rows[0].review_reason, expectedMissingPhotoReason);
    assert.equal(Number(persistedMissingPhoto.rows[0].event_count), 1);

    const missingPhotoRetry = await registerDriverOfflineEvents({
      driverLogin: missingPhotoDriverLogin,
      deviceId: missingPhotoDeviceId,
      manifestId: missingPhotoManifestId,
      events: [missingPhotoCompletion]
    });
    assert.equal(missingPhotoRetry[0].eventId, missingPhotoEventId);
    assert.equal(missingPhotoRetry[0].status, "review_required");
    assert.equal(missingPhotoRetry[0].reviewReason, expectedMissingPhotoReason);
    assert.equal(
      new Date(missingPhotoRetry[0].receivedAt).toISOString(),
      new Date(persistedMissingPhoto.rows[0].server_received_at).toISOString(),
      "An exact retry must return the originally registered poison event instead of inserting it again."
    );
    let missingPhotoApplyCount = 0;
    const missingPhotoQueue = await processDriverOfflineQueue({
      driverLogin: missingPhotoDriverLogin,
      planDate,
      applyEvent: async () => {
        missingPhotoApplyCount += 1;
        return {};
      }
    });
    assert.equal(missingPhotoApplyCount, 0, "A required-photo shortage must not run operational effects.");
    assert.equal(missingPhotoQueue[0]?.status, "review_required");
    assert.equal(
      missingPhotoQueue[1]?.status,
      "blocked",
      "Operational effects after a poison event must remain blocked behind its review barrier."
    );
    assert.equal(
      Number((await query(
        "SELECT COUNT(*)::int AS count FROM driver_job_records WHERE job_id = $1",
        [missingPhotoJob.jobId]
      )).rows[0].count),
      0,
      "A poison completion must not create a completed driver job record."
    );

    const job = manifest.jobs[0];
    const started = {
      eventId: startedEventId,
      clientSequence: 1,
      eventType: "job_started",
      jobId: baseJob.jobId,
      jobFingerprint: job.fingerprint,
      predecessorFingerprint: job.predecessorFingerprint,
      occurredAt: occurredAt(0),
      locationStatus: "not_checked_offline",
      photos: []
    };
    const firstRegistration = await registerDriverOfflineEvents({
      driverLogin,
      deviceId,
      manifestId,
      events: [started]
    });
    assert.equal(firstRegistration[0].status, "pending");
    const exactRetry = await registerDriverOfflineEvents({
      driverLogin,
      deviceId,
      manifestId,
      events: [started]
    });
    assert.equal(exactRetry[0].eventId, startedEventId);
    await assert.rejects(
      registerDriverOfflineEvents({
        driverLogin,
        deviceId,
        manifestId,
        events: [{ ...started, eventId: crypto.randomUUID() }]
      }),
      (error) => error.code === "OFFLINE_EVENT_IDEMPOTENCY_CONFLICT"
    );

    const receiptInput = {
      eventId: startedEventId,
      driverLogin,
      deviceId,
      actionType: "duty",
      context: {
        manifestId,
        planDate,
        jobId: baseJob.jobId,
        truckPlate: baseJob.truckPlate
      }
    };
    const startedReceipt = await beginDriverOfflineReconciliationReceipt(receiptInput);
    assert.equal(startedReceipt.execute, true);
    const executingRetry = await beginDriverOfflineReconciliationReceipt(receiptInput);
    assert.equal(executingRetry.execute, false);
    assert.equal(executingRetry.receipt.status, "executing");
    await assert.rejects(
      beginDriverOfflineReconciliationReceipt({
        ...receiptInput,
        context: { ...receiptInput.context, truckPlate: "CHANGED-PLATE" }
      }),
      (error) => error.code === "DRIVER_OFFLINE_RECONCILIATION_IDEMPOTENCY_CONFLICT"
    );
    const appliedReceipt = await completeDriverOfflineReconciliationReceipt(
      startedReceipt.receipt.receiptId,
      { reconciliation: { samsaraDutyReconciled: true } }
    );
    assert.equal(appliedReceipt.status, "applied");
    const appliedRetry = await beginDriverOfflineReconciliationReceipt(receiptInput);
    assert.equal(appliedRetry.execute, false);
    assert.equal(appliedRetry.receipt.result.reconciliation.samsaraDutyReconciled, true);

    const completed = {
      ...started,
      eventId: completedEventId,
      clientSequence: 2,
      eventType: "job_completed",
      occurredAt: occurredAt(10),
      details: { driverRemark: "Receiving door was closed." },
      photos: [{
        photoId,
        ordinal: 0,
        recordType: "driver-pickup-photo",
        mimeType: "image/jpeg",
        byteSize: 1234,
        sha256
      }]
    };
    const completedRegistration = await registerDriverOfflineEvents({
      driverLogin,
      deviceId,
      manifestId,
      events: [completed]
    });
    assert.equal(completedRegistration[0].status, "waiting_photos");
    assert.equal(
      completedRegistration[0].details.driverRemark,
      "Receiving door was closed.",
      "The durable offline event must retain its driver remark for later synchronization."
    );
    const pendingCompletionFromAnotherDevice = await findOpenDriverOfflineJobCompletion({
      driverLogin,
      deviceId: secondDeviceId,
      planDate,
      jobId: baseJob.jobId,
      jobFingerprint: job.fingerprint,
      jobPredecessorFingerprint: job.predecessorFingerprint
    });
    assert.equal(pendingCompletionFromAnotherDevice?.eventId, completedEventId);
    assert.equal(pendingCompletionFromAnotherDevice?.status, "waiting_photos");
    assert.equal(
      await findOpenDriverOfflineJobCompletion({
        driverLogin,
        deviceId,
        planDate,
        jobId: baseJob.jobId,
        jobFingerprint: job.fingerprint,
        jobPredecessorFingerprint: job.predecessorFingerprint
      }),
      null,
      "A device must not report its own open completion as a cross-device conflict."
    );
    assert.equal(
      await findOpenDriverOfflineJobCompletion({
        driverLogin,
        deviceId: secondDeviceId,
        planDate,
        jobId: baseJob.jobId,
        jobFingerprint: "b".repeat(64),
        jobPredecessorFingerprint: job.predecessorFingerprint
      }),
      null,
      "An older completion snapshot must not block a revised authoritative job."
    );
    assert.equal(
      await findOpenDriverOfflineJobCompletion({
        driverLogin,
        deviceId: secondDeviceId,
        planDate,
        jobId: baseJob.jobId,
        jobFingerprint: job.fingerprint,
        jobPredecessorFingerprint: "reordered-predecessor"
      }),
      null,
      "A completion from an older route position must not block the reordered authoritative job."
    );
    await assert.rejects(
      registerDriverOfflineEvents({
        driverLogin,
        deviceId: duplicateDeviceId,
        manifestId: duplicateManifestId,
        events: [{
          ...completed,
          eventId: duplicateCompletionEventId,
          clientSequence: 1,
          jobFingerprint: duplicateDeviceManifest.jobs[0].fingerprint,
          predecessorFingerprint: duplicateDeviceManifest.jobs[0].predecessorFingerprint,
          photos: [{
            ...completed.photos[0],
            photoId: duplicatePhotoId
          }]
        }]
      }),
      (error) => error.status === 409
        && error.code === "DRIVER_OFFLINE_CROSS_DEVICE_COMPLETION_CONFLICT",
      "A second device must lose the registration race with a stable conflict code."
    );
    const uncertainReceiptInput = {
      eventId: completedEventId,
      driverLogin,
      deviceId,
      actionType: "dvir",
      context: { manifestId, planDate, dvirType: "post" }
    };
    const uncertainReceipt = await beginDriverOfflineReconciliationReceipt(uncertainReceiptInput);
    await markDriverOfflineReconciliationReceiptUncertain(
      uncertainReceipt.receipt.receiptId,
      Object.assign(new Error("Harness uncertain Samsara response."), { code: "HARNESS_UNCERTAIN" }),
      { partialOutcome: { assignmentAccepted: true, dutyStatusUnknown: true } }
    );
    const uncertainRetry = await beginDriverOfflineReconciliationReceipt(uncertainReceiptInput);
    assert.equal(uncertainRetry.execute, false);
    assert.equal(uncertainRetry.receipt.status, "uncertain");
    assert.equal(uncertainRetry.receipt.result.partialOutcome.assignmentAccepted, true);
    await assert.rejects(
      completeDriverOfflineReconciliationReceipt(
        uncertainReceipt.receipt.receiptId,
        { reconciliation: { samsaraReconciled: true } }
      ),
      (error) => error.code === "DRIVER_OFFLINE_RECONCILIATION_UNCERTAIN"
    );
    await authorizeOfflinePhotoUpload({
      manifestId,
      deviceId,
      driverLogin,
      eventId: completedEventId,
      photoId,
      recordType: "driver-pickup-photo",
      mimeType: "image/jpeg",
      byteSize: 1234,
      sha256
    });
    const objectReference = `r2://driver/driver-pickup-photo/2098/07/16/${photoId}/evidence.jpg`;
    const receipts = await recordDriverOfflinePhotoReceipts({
      driverLogin,
      deviceId,
      manifestId,
      photoReceipts: [{ photoId, objectReference, byteSize: 1234, sha256 }]
    });
    assert.equal(receipts[0].status, "uploaded_unverified");
    const replacementReference = `r2://driver/driver-pickup-photo/2098/07/16/${photoId}/evidence-retry.jpg`;
    const replacementReceipts = await recordDriverOfflinePhotoReceipts({
      driverLogin,
      deviceId,
      manifestId,
      photoReceipts: [{
        photoId,
        objectReference: replacementReference,
        byteSize: 1234,
        sha256
      }]
    });
    assert.equal(
      replacementReceipts[0].objectReference,
      replacementReference,
      "An unverified upload may be replaced while its local Blob is retained."
    );
    const failedVerification = await recordDriverOfflinePhotoVerificationFailure(photoId, {
      errorCode: "HARNESS_READBACK_FAILED",
      errorMessage: "Harness object read-back returned the wrong byte count."
    });
    assert.equal(failedVerification.verificationAttemptCount, 1);
    assert.equal(failedVerification.lastVerificationErrorCode, "HARNESS_READBACK_FAILED");
    assert.equal(
      failedVerification.lastVerificationError,
      "Harness object read-back returned the wrong byte count."
    );
    assert.ok(failedVerification.lastVerificationAttemptAt);
    const failedVerificationDetail = (await getDriverOfflineEvent(completedEventId)).photos
      .find((photo) => photo.photoId === photoId);
    assert.equal(
      failedVerificationDetail.lastVerificationError,
      "Harness object read-back returned the wrong byte count.",
      "Dispatch detail must expose the exact persisted photo verification failure."
    );
    const durable = await markDriverOfflinePhotoDurable(photoId, {
      objectReference: replacementReference,
      verifiedByteSize: 1234,
      verifiedSha256: sha256,
      receipt: { verifiedBy: "harness" }
    });
    assert.equal(durable.durableReceipt, true);
    assert.equal(durable.verificationAttemptCount, 2, "A successful read-back is also a verification attempt.");
    assert.equal(durable.lastVerificationErrorCode, "");
    assert.equal(durable.lastVerificationError, "", "A successful read-back must clear the prior failure.");
    await assert.rejects(
      recordDriverOfflinePhotoReceipts({
        driverLogin,
        deviceId,
        manifestId,
        photoReceipts: [{ photoId, objectReference, byteSize: 1234, sha256 }]
      }),
      (error) => error.code === "OFFLINE_PHOTO_RECEIPT_CONFLICT",
      "A durable evidence reference must remain immutable."
    );
    const queue = await getDriverOfflineSyncQueue(driverLogin, planDate);
    assert.equal(queue.find((event) => event.eventId === completedEventId)?.status, "pending");
    await markDriverOfflineEventApplied(startedEventId, { effectiveJobId: baseJob.jobId });
    await markDriverOfflineEventApplied(completedEventId, { effectiveJobId: baseJob.jobId });
    assert.equal(
      await findOpenDriverOfflineJobCompletion({
        driverLogin,
        deviceId: secondDeviceId,
        planDate,
        jobId: baseJob.jobId,
        jobFingerprint: job.fingerprint,
        jobPredecessorFingerprint: job.predecessorFingerprint
      }),
      null,
      "An applied completion must stop blocking another device."
    );

    await query(
      `INSERT INTO driver_job_records (
         job_id, driver_login, stop_type, status, source_offline_event_id
       ) VALUES ($1, $2, 'pickup', 'complete', $3::uuid)`,
      [baseJob.jobId, `${driverLogin}-other`, startedEventId]
    );
    const completionProbe = {
      eventType: "job_completed",
      eventId: completedEventId,
      driverLogin
    };
    let completionConflict = await findDriverOfflineCompletionConflict(
      completionProbe,
      { jobId: baseJob.jobId }
    );
    assert.equal(completionConflict.ownerMismatch, true);
    assert.equal(
      completionConflict.sourceEventId,
      startedEventId,
      "A completion owned by another driver must be detected by job ID globally."
    );
    await query(
      `UPDATE driver_job_records
          SET driver_login = $2,
              source_offline_event_id = $3::uuid
        WHERE job_id = $1`,
      [baseJob.jobId, driverLogin, completedEventId]
    );
    assert.equal(
      await findDriverOfflineCompletionConflict(completionProbe, { jobId: baseJob.jobId }),
      null,
      "An exact same-driver, same-event completion retry must remain idempotent."
    );
    await query(
      `UPDATE driver_job_records
          SET source_offline_event_id = $2::uuid
        WHERE job_id = $1`,
      [baseJob.jobId, startedEventId]
    );
    completionConflict = await findDriverOfflineCompletionConflict(
      completionProbe,
      { jobId: baseJob.jobId }
    );
    assert.equal(
      completionConflict.sourceEventId,
      startedEventId,
      "A different completion source for the same owner must require review."
    );
    await query(
      `UPDATE driver_job_records
          SET driver_login = $2,
              source_offline_event_id = $3::uuid
        WHERE job_id = $1`,
      [baseJob.jobId, `${driverLogin}-other`, completedEventId]
    );
    assert.ok(
      await findDriverOfflineCompletionConflict(completionProbe, { jobId: baseJob.jobId }),
      "A matching source ID must not bypass a different job-record owner."
    );

    const reviewBaseline = await countDriverOfflineReviews();
    const review = {
      ...started,
      eventId: reviewEventId,
      clientSequence: 3,
      occurredAt: occurredAt(11)
    };
    await registerDriverOfflineEvents({ driverLogin, deviceId, manifestId, events: [review] });
    const releasableReceipt = await beginDriverOfflineReconciliationReceipt({
      eventId: reviewEventId,
      driverLogin,
      deviceId,
      actionType: "duty",
      context: { manifestId, planDate, reason: "known-no-external-action" }
    });
    assert.equal(
      await releaseDriverOfflineReconciliationReceipt(releasableReceipt.receipt.receiptId),
      true,
      "A known no-op may release its executing receipt for a later safe retry."
    );
    assert.equal(
      (await beginDriverOfflineReconciliationReceipt({
        eventId: reviewEventId,
        driverLogin,
        deviceId,
        actionType: "duty",
        context: { manifestId, planDate, reason: "known-no-external-action" }
      })).execute,
      true
    );
    await markDriverOfflineEventReviewRequired(reviewEventId, { reason: "Harness plan conflict" });
    const secondManifest = await persistDriverOfflineDayPlan({
      manifestId: secondManifestId,
      driverLogin,
      deviceId: secondDeviceId,
      planMetadata: { planId: null, planDate, planRevision: 7 },
      jobs: [baseJob],
      driverProfile: { login: driverLogin, name: "Offline Harness" },
      dayState: { planDate, truckPlate: "TEST-101", preDvirStatus: "complete" },
      samsaraWorkflowEnabled: false
    });
    await registerDriverOfflineEvents({
      driverLogin,
      deviceId: secondDeviceId,
      manifestId: secondManifestId,
      events: [{
        ...started,
        eventId: crossDeviceBlockedEventId,
        clientSequence: review.clientSequence,
        jobFingerprint: secondManifest.jobs[0].fingerprint,
        predecessorFingerprint: secondManifest.jobs[0].predecessorFingerprint,
        occurredAt: occurredAt(11.5)
      }]
    });
    const firstDeviceQueue = await getDriverOfflineSyncQueue(driverLogin, planDate, { deviceId });
    assert.ok(firstDeviceQueue.length > 0);
    assert.ok(
      firstDeviceQueue.every((event) => event.deviceId === deviceId),
      "A Driver queue lookup must never mix another browser device's sequence into this device stream."
    );
    assert.equal(
      firstDeviceQueue.some((event) => event.eventId === crossDeviceBlockedEventId),
      false,
      "The first device queue must exclude a same-driver event from another device."
    );
    const secondDeviceQueue = await getDriverOfflineSyncQueue(driverLogin, planDate, { deviceId: secondDeviceId });
    assert.deepEqual(
      secondDeviceQueue.map((event) => event.eventId),
      [crossDeviceBlockedEventId],
      "The second device must retain its independent sequence even when client sequence numbers overlap."
    );
    await markDriverOfflineEventBlocked(crossDeviceBlockedEventId);
    await registerDriverOfflineEvents({
      driverLogin,
      deviceId,
      manifestId,
      events: [{
        ...started,
        eventId: blockedEventId,
        clientSequence: 4,
        occurredAt: occurredAt(12)
      }]
    });
    await markDriverOfflineEventBlocked(blockedEventId);
    assert.equal(
      await countDriverOfflineReviews(),
      reviewBaseline + 3,
      "The Dispatch badge must count review-required and blocked nonterminal records."
    );
    assert.equal((await getDriverOfflineReview(reviewEventId))?.case.originalJob.jobId, baseJob.jobId);
    const resolutionInput = {
      eventId: reviewEventId,
      action: "evidence_only",
      auditNote: "Harness evidence retained without side effects.",
      caseVersion: 2,
      idempotencyId: crypto.randomUUID(),
      resolvedBy: "offline-harness-admin"
    };
    const resolution = await resolveDriverOfflineReview(resolutionInput, {
      replayBlocked: async ({ afterClientSequence, afterEventRecordId, blockedEvents }) => {
        assert.equal(afterClientSequence, review.clientSequence);
        assert.match(afterEventRecordId, /^\d+$/);
        assert.deepEqual(
          blockedEvents.map((event) => event.eventId),
          [blockedEventId],
          "Replay must remain inside the reviewed event's browser-device sequence."
        );
        const replayed = [];
        for (const blocked of blockedEvents) {
          await releaseDriverOfflineEventForReplay(blocked.eventId);
          const applied = await markDriverOfflineEventApplied(blocked.eventId, {
            effectiveJobId: baseJob.jobId
          });
          replayed.push({
            eventId: applied.eventId,
            status: applied.status,
            effectiveJobId: applied.effectiveJobId
          });
        }
        return replayed;
      }
    });
    assert.equal(resolution.status, "evidence_only");
    assert.deepEqual(resolution.replayed.map((event) => event.status), ["applied"]);
    assert.equal(
      (await getDriverOfflineEvent(crossDeviceBlockedEventId)).status,
      "blocked",
      "Resolving one browser device must not release another device's blocked sequence."
    );
    assert.equal((await resolveDriverOfflineReview(resolutionInput)).status, "evidence_only");

    const recoveryDriverLogin = `offline-recovery-${suffix}`;
    const recoveryDeviceId = `offline-recovery-device-${suffix}`;
    const recoveryManifestId = crypto.randomUUID();
    const recoveryJob = {
      ...baseJob,
      jobId: `offline-recovery-job-${suffix}`,
      driverLogin: recoveryDriverLogin,
      stopId: "STOP-RECOVERY",
      requiredPhotos: 0
    };
    const recoveryManifest = await persistDriverOfflineDayPlan({
      manifestId: recoveryManifestId,
      driverLogin: recoveryDriverLogin,
      deviceId: recoveryDeviceId,
      planMetadata: { planId: null, planDate, planRevision: 1 },
      jobs: [recoveryJob],
      driverProfile: { login: recoveryDriverLogin, name: "Offline Recovery Harness" },
      dayState: { planDate, truckPlate: "TEST-101", preDvirStatus: "complete" },
      samsaraWorkflowEnabled: false
    });
    const recoveryStatuses = [
      "registered",
      "waiting_photos",
      "pending",
      "blocked",
      "applying",
      "resolution_pending"
    ];
    const recoveryEvents = recoveryStatuses.map((status, index) => ({
      eventId: crypto.randomUUID(),
      clientSequence: index + 1,
      eventType: "job_started",
      jobId: recoveryJob.jobId,
      jobFingerprint: recoveryManifest.jobs[0].fingerprint,
      predecessorFingerprint: recoveryManifest.jobs[0].predecessorFingerprint,
      occurredAt: occurredAt(30 + index),
      locationStatus: "not_checked_offline",
      details: {},
      photos: [],
      expectedStatus: status
    }));
    await registerDriverOfflineEvents({
      driverLogin: recoveryDriverLogin,
      deviceId: recoveryDeviceId,
      manifestId: recoveryManifestId,
      events: recoveryEvents.map(({ expectedStatus: _expectedStatus, ...event }) => event)
    });
    for (const event of recoveryEvents) {
      await query(
        `UPDATE driver_offline_events
            SET status = $2,
                review_reason = CASE WHEN $2 = 'blocked' THEN 'Harness earlier-event barrier.' ELSE '' END,
                updated_at = now() - interval '10 minutes'
          WHERE event_id = $1::uuid`,
        [event.eventId, event.expectedStatus]
      );
    }
    const immutableHashes = new Map((await query(
      `SELECT event_id::text, payload_hash
         FROM driver_offline_events
        WHERE manifest_id = $1::uuid`,
      [recoveryManifestId]
    )).rows.map((row) => [row.event_id, row.payload_hash]));
    let forbiddenOperationalApplyCount = 0;
    for (const event of [...recoveryEvents].reverse()) {
      const commonResolution = {
        eventId: event.eventId,
        auditNote: `Harness recovery policy for ${event.expectedStatus}.`,
        caseVersion: 1,
        resolvedBy: "offline-recovery-harness-admin"
      };
      await assert.rejects(
        resolveDriverOfflineReview({
          ...commonResolution,
          action: "apply_original",
          idempotencyId: crypto.randomUUID()
        }, {
          applyResolution: async () => {
            forbiddenOperationalApplyCount += 1;
            return {};
          }
        }),
        (error) => error.code === "OFFLINE_REVIEW_STATE_CONFLICT",
        `Operational resolution must remain unavailable while an event is ${event.expectedStatus}.`
      );
      const evidenceResolution = {
        ...commonResolution,
        action: "evidence_only",
        confirmed: true,
        idempotencyId: crypto.randomUUID()
      };
      if (["registered", "waiting_photos", "pending", "blocked"].includes(event.expectedStatus)) {
        await assert.rejects(
          resolveDriverOfflineReview({
            ...evidenceResolution,
            confirmed: false,
            idempotencyId: crypto.randomUUID()
          }),
          (error) => error.code === "OFFLINE_EVIDENCE_ONLY_CONFIRMATION_REQUIRED",
          `Closing a ${event.expectedStatus} record must require explicit evidence-loss confirmation.`
        );
        const recovered = await resolveDriverOfflineReview(evidenceResolution);
        assert.equal(recovered.status, "evidence_only");
        assert.equal(recovered.deviceId, recoveryDeviceId);
        assert.equal(
          (await resolveDriverOfflineReview(evidenceResolution)).status,
          "evidence_only",
          "An exact evidence-only recovery retry must remain idempotent."
        );
      } else {
        await assert.rejects(
          resolveDriverOfflineReview(evidenceResolution),
          (error) => error.code === "OFFLINE_REVIEW_STATE_CONFLICT",
          `${event.expectedStatus} must remain read-only to avoid racing an active server transaction.`
        );
      }
    }
    assert.equal(forbiddenOperationalApplyCount, 0);
    const recoveryRows = await query(
      `SELECT event_id::text, status, payload_hash
         FROM driver_offline_events
        WHERE manifest_id = $1::uuid`,
      [recoveryManifestId]
    );
    for (const row of recoveryRows.rows) {
      assert.equal(
        row.payload_hash,
        immutableHashes.get(row.event_id),
        "Recovery must retain each event's immutable payload identity."
      );
    }
    assert.equal(
      Number((await query(
        `SELECT COUNT(*)::int AS count
           FROM driver_offline_resolutions r
           JOIN driver_offline_events e ON e.id = r.event_record_id
          WHERE e.manifest_id = $1::uuid`,
        [recoveryManifestId]
      )).rows[0].count),
      4,
      "Each manually abandoned recoverable state must have an immutable resolution audit row."
    );

    const invalidTimeEvent = {
      ...started,
      eventId: crypto.randomUUID(),
      clientSequence: 5,
      occurredAt: "device-clock-unavailable"
    };
    const invalidRegistration = await registerDriverOfflineEvents({
      driverLogin,
      deviceId,
      manifestId,
      events: [invalidTimeEvent]
    });
    assert.equal(invalidRegistration[0].status, "review_required");
    assert.equal(invalidRegistration[0].occurredAtRaw, "device-clock-unavailable");
    assert.equal(invalidRegistration[0].occurrenceTimeValid, false);
    await registerDriverOfflineEvents({
      driverLogin,
      deviceId,
      manifestId,
      events: [invalidTimeEvent]
    });
    assert.equal(
      (await getDriverOfflineEvent(invalidTimeEvent.eventId)).reviewRequired,
      true,
      "An invalid timestamp retry must retain evidence without changing idempotency."
    );

    await query(
      `UPDATE driver_offline_manifests
          SET generated_at = now() - interval '2 hours',
              expires_at = now() - interval '45 minutes',
              updated_at = now()
        WHERE manifest_id = $1::uuid`,
      [manifestId]
    );
    const afterExpiryEvent = {
      ...started,
      eventId: crypto.randomUUID(),
      clientSequence: 6,
      occurredAt: new Date(Date.now() - 30 * 60 * 1000).toISOString()
    };
    const afterExpiryRegistration = await registerDriverOfflineEvents({
      driverLogin,
      deviceId,
      manifestId,
      events: [afterExpiryEvent]
    });
    assert.equal(afterExpiryRegistration[0].status, "review_required");
    assert.equal(afterExpiryRegistration[0].occurrenceTimeValid, true);
    assert.match(afterExpiryRegistration[0].reviewReason, /after its offline route manifest expired/i);
    assert.equal(
      (await registerDriverOfflineEvents({
        driverLogin,
        deviceId,
        manifestId,
        events: [afterExpiryEvent]
      }))[0].status,
      "review_required",
      "An exact retry of post-expiry evidence must remain durable and review-only."
    );

    const verification = await createDriverLocationVerification({
      driverLogin,
      deviceId,
      jobId: baseJob.jobId,
      status: "verified",
      details: { source: "harness" }
    });
    const consumed = await consumeDriverLocationVerification(verification.verificationId, {
      driverLogin,
      jobId: baseJob.jobId,
      eventId: completedEventId
    });
    assert.equal(consumed.eventId, completedEventId);

    const delayedVerification = await createDriverLocationVerification({
      driverLogin,
      deviceId,
      jobId: baseJob.jobId,
      status: "verified",
      details: { source: "delayed-sync-harness" }
    });
    await query(
      `UPDATE driver_location_verifications
          SET checked_at = now() - interval '20 minutes',
              expires_at = now() - interval '15 minutes'
        WHERE verification_id = $1::uuid`,
      [delayedVerification.verificationId]
    );
    const delayedOccurredAt = new Date(Date.now() - 17 * 60 * 1000).toISOString();
    assert.equal(
      await consumeDriverLocationVerification(delayedVerification.verificationId, {
        driverLogin,
        deviceId: `${deviceId}-wrong`,
        jobId: baseJob.jobId,
        eventId: completedEventId,
        occurredAt: delayedOccurredAt
      }),
      null,
      "Location evidence must remain bound to its browser device."
    );
    const delayedConsumed = await consumeDriverLocationVerification(delayedVerification.verificationId, {
      driverLogin,
      deviceId,
      jobId: baseJob.jobId,
      eventId: completedEventId,
      occurredAt: delayedOccurredAt
    });
    assert.equal(
      delayedConsumed.eventId,
      completedEventId,
      "A verification valid when the event occurred must survive a delayed sync."
    );

    const scopedDayState = await getDriverDayState(driverLogin, {
      date: planDate,
      samsaraAccounts: { enabled: false }
    });
    assert.equal(
      scopedDayState.planDate,
      planDate,
      "An explicitly requested offline plan must use day state from that same plan date."
    );
    const switchJob = {
      ...baseJob,
      jobId: `offline-switch-${suffix}`,
      stopId: "SWITCH-1",
      stopType: "truck_switch",
      fromTruckId: "TRUCK-ID",
      fromTruckPlate: "TEST-101",
      nextTruckId: "TRUCK-ID-2",
      nextTruckPlate: "TEST-202",
      truckId: "TRUCK-ID-2",
      truckPlate: "TEST-202",
      switchYard: "3445",
      requiredPhotos: 0
    };
    const physicalSwitch = await recordOfflineDriverTruckSwitch(driverLogin, switchJob, {
      occurredAt: occurredAt(20),
      samsaraReconciliationRequired: false
    });
    assert.equal(physicalSwitch.samsaraDisabled, true);
    assert.equal(physicalSwitch.switchRecord.status, "complete");
    assert.equal(physicalSwitch.switchRecord.to_truck_plate, "TEST-202");
    const switchDay = await query(
      `SELECT plan_date::text, current_truck_plate
         FROM driver_day_records
        WHERE driver_login = $1
          AND plan_date = $2::date`,
      [driverLogin, planDate]
    );
    assert.equal(switchDay.rows[0].plan_date, planDate);
    assert.equal(switchDay.rows[0].current_truck_plate, "TEST-202");
  });
  console.log("Driver offline repository rollback harness passed.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await rollback.rollback();
  await closeDb();
}
