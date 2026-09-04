// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  driverCompletedPhotoReferenceMatches,
  normalizeDriverCompletedPhotoDescriptors,
  physicalVisitMemberJobIds
} from "../../../src/driver-completed-photo-evidence.js";

const sha = "a".repeat(64);

function validDescriptor(overrides = {}) {
  return {
    photoId: crypto.randomUUID(),
    ordinal: 1,
    byteSize: 2048,
    sha256: sha,
    mimeType: "image/jpeg",
    ...overrides
  };
}

test("S47: malformed, duplicate, oversized, and non-JPEG supplemental descriptors fail closed", () => {
  const invalidCases = [
    null,
    {},
    [validDescriptor({ photoId: "not-a-uuid" })],
    [validDescriptor({ ordinal: 0 })],
    [validDescriptor({ ordinal: 21 })],
    [validDescriptor({ byteSize: 0 })],
    [validDescriptor({ byteSize: 2 * 1024 * 1024 + 1 })],
    [validDescriptor({ sha256: "bad" })],
    [validDescriptor({ mimeType: "image/png" })]
  ];
  for (const value of invalidCases) {
    assert.throws(() => normalizeDriverCompletedPhotoDescriptors(value));
  }

  const photoId = crypto.randomUUID();
  assert.throws(() => normalizeDriverCompletedPhotoDescriptors([
    validDescriptor({ photoId, ordinal: 1 }),
    validDescriptor({ photoId, ordinal: 2 })
  ]), (error) => error?.code === "DRIVER_COMPLETED_PHOTO_DUPLICATE");
  assert.throws(() => normalizeDriverCompletedPhotoDescriptors([
    validDescriptor({ ordinal: 1 }),
    validDescriptor({ ordinal: 1 })
  ]), (error) => error?.code === "DRIVER_COMPLETED_PHOTO_DUPLICATE");
  assert.throws(
    () => normalizeDriverCompletedPhotoDescriptors([validDescriptor()], { requireReferences: true }),
    (error) => error?.code === "DRIVER_COMPLETED_PHOTO_REFERENCE_REQUIRED"
  );
});

test("S48: R2 evidence references cannot cross request, photo, namespace, record type, or date layout", () => {
  const requestId = crypto.randomUUID();
  const photoId = crypto.randomUUID();
  const expected = {
    requestId,
    photoId,
    recordType: "driver-dropoff-photo"
  };
  const subject = `${requestId}-${photoId}`;
  const valid = `r2://dispatch-stop-evidence/driver-dropoff-photo/2026/09/02/${subject}/evidence.jpg`;
  assert.equal(driverCompletedPhotoReferenceMatches(valid, expected), true);
  for (const forged of [
    valid.replace("dispatch-stop-evidence", "driver"),
    valid.replace("driver-dropoff-photo", "driver-pickup-photo"),
    valid.replace(subject, `${crypto.randomUUID()}-${photoId}`),
    valid.replace(subject, `${requestId}-${crypto.randomUUID()}`),
    valid.replace("/2026/09/02/", "/26/9/2/"),
    valid.replace("r2://", "https://")
  ]) {
    assert.equal(driverCompletedPhotoReferenceMatches(forged, expected), false, forged);
  }
});

test("S49: hostile physical-visit declarations remain bounded and must contain their own job", () => {
  const jobIds = Array.from({ length: 800 }, (_, index) => `job-${index}`);
  jobIds.splice(700, 0, "own-job");
  assert.throws(
    () => physicalVisitMemberJobIds({
      job_id: "own-job",
      job_details: { physicalVisitJobIds: jobIds }
    }),
    (error) => error?.code === "DRIVER_COMPLETED_VISIT_DECLARATION_INVALID"
  );
  const bounded = physicalVisitMemberJobIds({
    job_id: "own-job",
    job_details: { physicalVisitJobIds: ["own-job", ...jobIds, "own-job"] }
  });
  assert.equal(bounded.length, 500);
  assert.equal(bounded[0], "own-job");
  assert.equal(new Set(bounded).size, bounded.length);
});
