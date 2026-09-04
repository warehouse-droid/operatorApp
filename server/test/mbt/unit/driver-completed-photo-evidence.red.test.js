// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  DRIVER_COMPLETED_VISIT_MAX_PHOTOS,
  driverCompletedPhotoReferenceMatches,
  driverCompletedVisitSource,
  driverCompletedVisitStateHash,
  mergeDriverCompletedVisitPhotos,
  normalizeDriverCompletedPhotoDescriptors,
  normalizeDriverCompletedVisitFilters,
  physicalVisitMemberJobIds,
  retainedDriverPhotoRequirement,
  uniqueDriverPhotoReferences
} from "../../../src/driver-completed-photo-evidence.js";

const sha = (digit) => String(digit).repeat(64);

test("S24: completed-visit filters are bounded and canonical", () => {
  assert.deepEqual(normalizeDriverCompletedVisitFilters({
    status: "COMPLETED",
    driverLogin: "  Driver.One ",
    stopType: "DROP",
    photoState: "below-requirement",
    completionSource: "DRIVER-OFFLINE",
    q: `  ${"order ".repeat(80)}  `,
    cursor: "42",
    limit: "999"
  }), {
    status: "complete",
    driverLogin: "driver.one",
    stopType: "dropoff",
    photoState: "below_required",
    completionSource: "driver_offline",
    q: "order ".repeat(80).trim().slice(0, 240),
    cursor: 42,
    limit: 200
  });
  assert.deepEqual(normalizeDriverCompletedVisitFilters({}), {
    status: "all",
    driverLogin: "",
    stopType: "all",
    photoState: "all",
    completionSource: "all",
    q: "",
    cursor: 0,
    limit: 50
  });
});

test("S25: completion source classification is deterministic, including mixed visits", () => {
  const online = { job_details: { schemaVersion: 1 } };
  const offline = { ...online, source_offline_event_id: crypto.randomUUID() };
  const assisted = { ...offline, job_details: { schemaVersion: 1, completionSource: "dispatch_historical_assist" } };
  assert.equal(driverCompletedVisitSource([online]), "driver_online");
  assert.equal(driverCompletedVisitSource([offline]), "driver_offline");
  assert.equal(driverCompletedVisitSource([assisted]), "dispatch_historical_assist");
  assert.equal(driverCompletedVisitSource([{ job_details: {} }]), "legacy_unknown");
  assert.equal(driverCompletedVisitSource([online, offline]), "mixed");
});

test("S26: physical-visit IDs preserve declared order and reject unsafe declarations", () => {
  assert.deepEqual(physicalVisitMemberJobIds({
    job_id: "job-b",
    job_details: { physicalVisitJobIds: ["job-a", "job-b", "job-a", ""] }
  }), ["job-a", "job-b"]);
  assert.deepEqual(physicalVisitMemberJobIds({ job_id: "legacy-job", job_details: {} }), ["legacy-job"]);
  assert.throws(
    () => physicalVisitMemberJobIds({ job_id: "job-a", job_details: { physicalVisitJobIds: ["job-b"] } }),
    (error) => error?.code === "DRIVER_COMPLETED_VISIT_DECLARATION_INVALID"
  );
});

test("S27: canonical photos are ordered, deduplicated, append-only, and capped at twenty", () => {
  const existing = [
    "r2://driver/driver-pickup-photo/old-1.jpg",
    "r2://driver/driver-pickup-photo/old-2.jpg",
    "r2://driver/driver-pickup-photo/old-1.jpg",
    "data:image/jpeg;base64,not-durable"
  ];
  assert.deepEqual(uniqueDriverPhotoReferences(existing), existing.slice(0, 2));
  assert.deepEqual(mergeDriverCompletedVisitPhotos({
    existing,
    added: [
      "r2://driver/driver-pickup-photo/old-2.jpg",
      "r2://dispatch-stop-evidence/driver-pickup-photo/new-1.jpg"
    ]
  }), [
    "r2://driver/driver-pickup-photo/old-1.jpg",
    "r2://driver/driver-pickup-photo/old-2.jpg",
    "r2://dispatch-stop-evidence/driver-pickup-photo/new-1.jpg"
  ]);
  assert.throws(
    () => mergeDriverCompletedVisitPhotos({
      existing: Array.from({ length: DRIVER_COMPLETED_VISIT_MAX_PHOTOS - 1 }, (_, index) => `r2://driver/driver-dropoff-photo/${index}.jpg`),
      added: [
        "r2://dispatch-stop-evidence/driver-dropoff-photo/new-1.jpg",
        "r2://dispatch-stop-evidence/driver-dropoff-photo/new-2.jpg"
      ]
    }),
    (error) => error?.code === "DRIVER_COMPLETED_PHOTO_LIMIT"
  );
});

test("S28: retained photos satisfy only the remaining Driver requirement", () => {
  assert.deepEqual(retainedDriverPhotoRequirement({ configuredRequiredPhotos: 2, retainedPhotos: [] }), {
    requiredPhotos: 2,
    retainedPhotoCount: 0,
    remainingRequiredPhotos: 2,
    maxPhotos: 20
  });
  assert.deepEqual(retainedDriverPhotoRequirement({
    configuredRequiredPhotos: 2,
    retainedPhotos: [
      "r2://driver/driver-pickup-photo/one.jpg",
      "r2://driver/driver-pickup-photo/two.jpg"
    ]
  }), {
    requiredPhotos: 2,
    retainedPhotoCount: 2,
    remainingRequiredPhotos: 0,
    maxPhotos: 20
  });
  assert.deepEqual(retainedDriverPhotoRequirement({
    configuredRequiredPhotos: 1,
    retainedPhotos: [],
    minimumRequiredPhotos: 0
  }), {
    requiredPhotos: 1,
    retainedPhotoCount: 0,
    remainingRequiredPhotos: 1,
    maxPhotos: 20
  });
});

test("S29: visit state hashes bind every physical member and canonical photo", () => {
  const state = {
    memberRecords: [{ id: 2, jobId: "b", status: "complete" }, { id: 1, jobId: "a", status: "complete" }],
    photos: ["r2://driver/driver-pickup-photo/one.jpg"]
  };
  const first = driverCompletedVisitStateHash(state);
  assert.match(first, /^[0-9a-f]{64}$/u);
  assert.equal(driverCompletedVisitStateHash({ ...state, memberRecords: [...state.memberRecords].reverse() }), first);
  assert.notEqual(driverCompletedVisitStateHash({
    ...state,
    photos: [...state.photos, "r2://driver/driver-pickup-photo/two.jpg"]
  }), first);
});

test("S30: supplemental descriptors and R2 references are request-bound JPEG evidence", () => {
  const requestId = crypto.randomUUID();
  const photoId = crypto.randomUUID();
  const descriptor = normalizeDriverCompletedPhotoDescriptors([{
    photoId,
    ordinal: 1,
    byteSize: 2048,
    sha256: sha(1),
    mimeType: "image/jpeg"
  }])[0];
  assert.equal(descriptor.photoId, photoId);
  assert.equal(driverCompletedPhotoReferenceMatches(
    `r2://dispatch-stop-evidence/driver-pickup-photo/2026/09/02/${requestId}-${photoId}/evidence-1.jpg`,
    { requestId, photoId, recordType: "driver-pickup-photo" }
  ), true);
  assert.equal(driverCompletedPhotoReferenceMatches(
    `r2://dispatch-assist/driver-pickup-photo/2026/09/02/${requestId}-${photoId}/evidence-1.jpg`,
    { requestId, photoId, recordType: "driver-pickup-photo" }
  ), false);
  assert.throws(
    () => normalizeDriverCompletedPhotoDescriptors([{ ...descriptor, mimeType: "image/png" }]),
    (error) => error?.code === "DRIVER_COMPLETED_PHOTO_MIME_INVALID"
  );
});
