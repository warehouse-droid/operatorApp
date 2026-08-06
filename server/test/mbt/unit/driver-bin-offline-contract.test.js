import assert from "node:assert/strict";
import test from "node:test";

import {
  fingerprintDriverOfflineJob,
  fingerprintDriverOfflineJobContent,
  sanitizeDriverOfflineEventDetails,
  sanitizeDriverOfflineJob
} from "../../../src/driver-offline-repository.js";
import { planJobsForDriver } from "../../../src/driver-repository.js";

const VISIT_ID = "00000000-0000-4000-8000-000000000901";
const STEP_ID = "00000000-0000-4000-8000-000000000902";
const ASSET_ID = "00000000-0000-4000-8000-000000000903";

function mixedPlan() {
  return {
    id: "900901",
    planDate: "2039-08-03",
    orders: [],
    summary: {},
    trucks: [{
      id: "900902",
      plate: "P3-BIN-PWA",
      driverLogin: "p3-driver-pwa",
      driver: "P3 Driver PWA",
      loads: [{
        id: "P3-BIN-PWA-LOAD",
        name: "BIN Load",
        driverLogin: "p3-driver-pwa",
        driverName: "P3 Driver PWA",
        stops: [{
          id: "P3-BIN-PWA-SCAN",
          type: "pickup",
          actionCode: "collect_empty_bin",
          yardCode: "12441",
          displayName: "Collect exact BIN",
          evidenceRequirements: [{ code: "outgoing_bin_scan", type: "bin_scan", minimumCount: 1 }],
          mbt: {
            visitId: VISIT_ID,
            stopGroupId: VISIT_ID,
            stopSequence: 1,
            mandatory: true,
            capabilitySnapshot: { truckType: "bin", binTypeCode: "14YD" }
          }
        }]
      }]
    }]
  };
}

function completeJob() {
  return {
    ...planJobsForDriver(mixedPlan(), "p3-driver-pwa", { allowBin: true })[0],
    requiredPhotos: 1,
    mbt: {
      schemaVersion: "mbt-driver-bin-job-v1",
      minimumClientVersion: "2026.08.03.1",
      contractId: "00000000-0000-4000-8000-000000000904",
      contractNumber: "MBT-P3-PWA",
      visitId: VISIT_ID,
      visitReference: "BIN-MBT-P3-PWA-V1",
      visitNumber: 1,
      issuedVisitRevision: 3,
      serviceAction: "delivery",
      actionCode: "collect_empty_bin",
      visitStepId: STEP_ID,
      stepSequence: 0,
      stopGroupId: VISIT_ID,
      stopSequence: 1,
      mandatory: true,
      serviceTemplateVersionId: "00000000-0000-4000-8000-000000000905",
      templateRevision: 2,
      binTypeId: "00000000-0000-4000-8000-000000000906",
      binTypeCode: "14YD",
      exactAssets: {
        expected: null,
        outgoing: {
          assetId: ASSET_ID,
          assetCode: "BIN-PWA-14-001",
          qrCode: "QR-BIN-PWA-14-001",
          binTypeCode: "14YD",
          lifecycleStatus: "reserved",
          locationKind: "yard",
          locationReference: "12441",
          stateRevision: 4
        },
        incoming: null
      },
      dumpSiteId: null,
      materialId: null,
      customerSiteProfileId: "00000000-0000-4000-8000-000000000907",
      customer: { displayName: "Synthetic customer" },
      site: { addressLine1: "100 Test Route", city: "Toronto", province: "ON" },
      evidenceRequirements: [{
        requirementId: "00000000-0000-4000-8000-000000000908",
        evidenceCode: "outgoing_bin_scan",
        evidenceType: "bin_scan",
        minimumCount: 1,
        required: true
      }],
      movementExpectation: { beforeStatus: "reserved", afterStatus: "on_truck" },
      capabilitySnapshot: { truckType: "bin", binTypeCode: "14YD" },
      assignment: {
        planId: "900901",
        planRevision: 2,
        loadId: "P3-BIN-PWA-LOAD",
        truckId: "900902",
        driverId: "900903"
      },
      executionSnapshotHash: "a".repeat(64)
    }
  };
}

test("P3-F18: BIN Driver projection is explicit opt-in and keeps complete mandatory stops", () => {
  assert.throws(
    () => planJobsForDriver(mixedPlan(), "p3-driver-pwa"),
    (error) => error?.code === "MBT_DRIVER_BIN_DISABLED"
  );
  const jobs = planJobsForDriver(mixedPlan(), "p3-driver-pwa", { allowBin: true });
  assert.equal(jobs.length, 1);
  assert.deepEqual({
    stopType: jobs[0].stopType,
    actionCode: jobs[0].mbt.actionCode,
    visitId: jobs[0].mbt.visitId,
    orderRefs: jobs[0].orderRefs,
    orderTypes: jobs[0].orderTypes
  }, {
    stopType: "pickup",
    actionCode: "collect_empty_bin",
    visitId: VISIT_ID,
    orderRefs: [],
    orderTypes: ["BIN"]
  });
});

test("P3-F18/P3-F19: manifest sanitization retains the complete frozen BIN snapshot", () => {
  const job = completeJob();
  const sanitized = sanitizeDriverOfflineJob(job);
  assert.deepEqual(sanitized.mbt, job.mbt);
  assert.equal(sanitized.orderRefs.length, 0);
  assert.deepEqual(sanitized.orderTypes, ["BIN"]);
  assert.equal(sanitized.mbt.exactAssets.outgoing.assetId, ASSET_ID);
  assert.notEqual(
    fingerprintDriverOfflineJob(sanitized),
    fingerprintDriverOfflineJob({
      ...sanitized,
      mbt: { ...sanitized.mbt, actionCode: "deliver_bin" }
    })
  );
});

test("P3-F18/P3-F21: offline completion sanitization retains strict scan, photo, note, signature, and receipt evidence", () => {
  const details = sanitizeDriverOfflineEventDetails("job_completed", {
    driverRemark: "Local driver remark",
    mbt: {
      schemaVersion: "mbt-driver-bin-event-v1",
      actionCode: "dump_bin",
      scans: [{
        evidenceCode: "outgoing_bin_scan",
        assetRole: "outgoing",
        assetId: ASSET_ID,
        scannedValue: "QR-BIN-PWA-14-001"
      }],
      photoEvidence: [{ evidenceCode: "dump_receipt_photo", ordinal: 0 }],
      notes: [{ evidenceCode: "condition_note", text: "No damage" }],
      signatures: [{ evidenceCode: "site_signature", signedBy: "Test Receiver", signaturePhotoOrdinal: 1 }],
      receipt: {
        dumpSiteId: "00000000-0000-4000-8000-000000000909",
        materialId: "00000000-0000-4000-8000-000000000910",
        ticketNumber: "TICKET-PWA-1",
        weight: "1.250000",
        quantity: null,
        unitOfMeasure: "TON",
        subtotalMinor: 10000,
        taxMinor: 1300,
        totalMinor: 11300,
        currency: "CAD",
        receiptPhotoOrdinal: 0
      }
    }
  });
  assert.equal(details.driverRemark, "Local driver remark");
  assert.equal(details.mbt.schemaVersion, "mbt-driver-bin-event-v1");
  assert.equal(details.mbt.scans[0].assetId, ASSET_ID);
  assert.equal(details.mbt.receipt.totalMinor, 11300);
  assert.equal(details.mbt.signatures[0].signedBy, "Test Receiver");
});

test("P3-F18/P3-F21: unknown BIN evidence fields fail closed at the offline boundary", () => {
  assert.throws(
    () => sanitizeDriverOfflineEventDetails("job_completed", {
      mbt: {
        actionCode: "deliver_bin",
        scans: [],
        photoEvidence: [],
        notes: [],
        signatures: [],
        receipt: null,
        permissiveUnknownField: true
      }
    }),
    (error) => error?.code === "MBT_DRIVER_BIN_EVENT_INVALID"
  );
});

test("P3-F19: operational asset-state progress keeps later frozen BIN job identities stable", () => {
  const original = sanitizeDriverOfflineJob(completeJob());
  const progressed = structuredClone(original);
  Object.assign(progressed.mbt.exactAssets.outgoing, {
    lifecycleStatus: "on_truck",
    locationKind: "truck",
    locationReference: "P3-BIN-PWA",
    stateRevision: original.mbt.exactAssets.outgoing.stateRevision + 1
  });
  assert.equal(fingerprintDriverOfflineJob(progressed), fingerprintDriverOfflineJob(original));
  assert.equal(
    fingerprintDriverOfflineJobContent(progressed),
    fingerprintDriverOfflineJobContent(original)
  );

  progressed.mbt.exactAssets.outgoing.assetId = "00000000-0000-4000-8000-000000000999";
  assert.notEqual(fingerprintDriverOfflineJob(progressed), fingerprintDriverOfflineJob(original));
  assert.notEqual(
    fingerprintDriverOfflineJobContent(progressed),
    fingerprintDriverOfflineJobContent(original)
  );
});

test("P3-F19: a client-version deployment cannot weaken or silently rewrite a frozen fingerprint", () => {
  const issued = sanitizeDriverOfflineJob(completeJob());
  const newerProjection = structuredClone(issued);
  newerProjection.mbt.minimumClientVersion = "2026.08.05.3";

  assert.notEqual(
    fingerprintDriverOfflineJob(newerProjection),
    fingerprintDriverOfflineJob(issued),
    "The manifest comparison must deliberately normalize compatibility metadata; the fingerprint stays immutable."
  );
});
