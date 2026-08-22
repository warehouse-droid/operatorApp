import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb } from "../../../src/db.js";
import {
  authenticateDriverOfflineGrant,
  getDriverOfflineManifest,
  persistDriverOfflineDayPlan,
  registerDriverOfflineEvents
} from "../../../src/driver-offline-repository.js";
import { processDriverOfflineQueue } from "../../../src/driver-offline-service.js";
import { supersedeDriverRouteArtifacts } from "../../../src/scm-dependency-management-repository.js";

after(closeDb);

test("events from a superseded Driver manifest are retained for review and never applied", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomBytes(6).toString("hex");
      const driverLogin = `superseded-${suffix}`;
      const deviceId = `device-${suffix}`;
      const manifestId = crypto.randomUUID();
      const planDate = "2097-08-19";
      const job = {
        jobId: `job-${suffix}`,
        planId: null,
        planDate,
        driverLogin,
        truckId: "TRUCK-SUPERSEDED",
        truckPlate: "TEST-937",
        loadId: "LOAD-1",
        loadName: "Superseded route",
        stopId: "STOP-1",
        stopType: "pickup",
        location: "12441",
        pickupLocation: "12441",
        orderRefs: ["TOB00937"],
        orderTypes: ["TO"],
        lineRowIds: ["1"],
        requiredPhotos: 0
      };
      const manifest = await persistDriverOfflineDayPlan({
        manifestId,
        driverLogin,
        deviceId,
        planMetadata: { planId: null, planDate, planRevision: 3 },
        jobs: [job],
        driverProfile: { login: driverLogin, name: "Superseded Harness" },
        dayState: { planDate, truckPlate: job.truckPlate, preDvirStatus: "complete" },
        samsaraWorkflowEnabled: false
      });
      const manifestJob = manifest.jobs[0];
      const event = (clientSequence) => ({
        eventId: crypto.randomUUID(),
        clientSequence,
        eventType: "job_started",
        jobId: job.jobId,
        jobFingerprint: manifestJob.fingerprint,
        predecessorFingerprint: manifestJob.predecessorFingerprint,
        occurredAt: new Date(Date.now() - (10 - clientSequence) * 1000).toISOString(),
        locationStatus: "not_checked_offline",
        photos: []
      });

      const beforeSupersede = (await registerDriverOfflineEvents({
        driverLogin,
        deviceId,
        manifestId,
        events: [event(1)]
      }))[0];
      assert.equal(beforeSupersede.status, "pending");

      await supersedeDriverRouteArtifacts({ planDate });
      const persistedManifest = await getDriverOfflineManifest(manifestId, {
        driverLogin,
        deviceId,
        touch: false
      });
      assert.ok(persistedManifest.supersededAt);
      assert.equal(await authenticateDriverOfflineGrant(manifest.offlineSyncGrant, {
        manifestId,
        deviceId,
        touch: false
      }), null);

      const afterSupersede = (await registerDriverOfflineEvents({
        driverLogin,
        deviceId,
        manifestId,
        events: [event(2)]
      }))[0];
      assert.equal(afterSupersede.status, "review_required");
      assert.match(afterSupersede.reviewReason, /route superseded/i);

      let applyCount = 0;
      const processed = await processDriverOfflineQueue({
        driverLogin,
        planDate,
        deviceId,
        applyEvent: async () => {
          applyCount += 1;
          return { applied: true };
        }
      });
      assert.equal(applyCount, 0);
      assert.deepEqual(processed.map((row) => row.status), ["review_required", "review_required"]);
      assert.match(processed[0].reviewReason, /route superseded/i);
    });
  } finally {
    await rollback.rollback();
  }
});
