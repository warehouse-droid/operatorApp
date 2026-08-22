// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  historicalAssistPhotoReferenceMatches,
  historicalAssistStateHash,
  normalizeHistoricalAssistPhotoDescriptors
} from "../../../src/driver-historical-assist-repository.js";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const PHOTO_ID = "22222222-2222-4222-8222-222222222222";
const SHA = "a".repeat(64);

test("S15: upload descriptors are bounded, canonical, unique, and JPEG-only", () => {
  assert.deepEqual(normalizeHistoricalAssistPhotoDescriptors([{
    photoId: PHOTO_ID,
    ordinal: 1,
    byteSize: 12345,
    sha256: SHA.toUpperCase(),
    mimeType: "image/jpeg"
  }]), [{
    photoId: PHOTO_ID,
    ordinal: 1,
    byteSize: 12345,
    sha256: SHA,
    mimeType: "image/jpeg",
    objectReference: ""
  }]);

  for (const descriptors of [
    [{ photoId: "not-uuid", ordinal: 1, byteSize: 12, sha256: SHA, mimeType: "image/jpeg" }],
    [{ photoId: PHOTO_ID, ordinal: 0, byteSize: 12, sha256: SHA, mimeType: "image/jpeg" }],
    [{ photoId: PHOTO_ID, ordinal: 1, byteSize: 0, sha256: SHA, mimeType: "image/jpeg" }],
    [{ photoId: PHOTO_ID, ordinal: 1, byteSize: 2 * 1024 * 1024 + 1, sha256: SHA, mimeType: "image/jpeg" }],
    [{ photoId: PHOTO_ID, ordinal: 1, byteSize: 12, sha256: "bad", mimeType: "image/jpeg" }],
    [{ photoId: PHOTO_ID, ordinal: 1, byteSize: 12, sha256: SHA, mimeType: "image/png" }],
    [
      { photoId: PHOTO_ID, ordinal: 1, byteSize: 12, sha256: SHA, mimeType: "image/jpeg" },
      { photoId: PHOTO_ID, ordinal: 2, byteSize: 12, sha256: SHA, mimeType: "image/jpeg" }
    ]
  ]) {
    assert.throws(() => normalizeHistoricalAssistPhotoDescriptors(descriptors));
  }
  assert.throws(() => normalizeHistoricalAssistPhotoDescriptors(Array.from({ length: 21 }, (_, index) => ({
    photoId: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
    ordinal: index + 1,
    byteSize: 12,
    sha256: SHA,
    mimeType: "image/jpeg"
  }))));
});

test("S16: completion requires durable references bound to each issued photo ID", () => {
  const prefix = `dispatch-assist/driver-dropoff-photo/2026/08/20/${PHOTO_ID}`;
  assert.equal(historicalAssistPhotoReferenceMatches(`r2://${prefix}/image.jpg`, {
    photoId: PHOTO_ID,
    recordType: "driver-dropoff-photo"
  }), true);
  for (const reference of [
    `${prefix}/image.jpg`,
    `r2://dispatch-assist/driver-pickup-photo/2026/08/20/${PHOTO_ID}/image.jpg`,
    `r2://driver/driver-dropoff-photo/2026/08/20/${PHOTO_ID}/image.jpg`,
    `r2://dispatch-assist/driver-dropoff-photo/2026/08/20/${REQUEST_ID}/image.jpg`,
    "r2://dispatch-assist/driver-dropoff-photo/../../secret"
  ]) {
    assert.equal(historicalAssistPhotoReferenceMatches(reference, {
      photoId: PHOTO_ID,
      recordType: "driver-dropoff-photo"
    }), false, reference);
  }

  assert.throws(() => normalizeHistoricalAssistPhotoDescriptors([{
    photoId: PHOTO_ID,
    ordinal: 1,
    byteSize: 12345,
    sha256: SHA,
    mimeType: "image/jpeg"
  }], { requireReferences: true }));

  const requestBound = `r2://dispatch-assist/driver-dropoff-photo/2026/08/20/${REQUEST_ID}-${PHOTO_ID}/image.jpg`;
  assert.equal(historicalAssistPhotoReferenceMatches(requestBound, {
    requestId: REQUEST_ID,
    photoId: PHOTO_ID,
    recordType: "driver-dropoff-photo"
  }), true);
  assert.equal(historicalAssistPhotoReferenceMatches(`r2://${prefix}/image.jpg`, {
    requestId: REQUEST_ID,
    photoId: PHOTO_ID,
    recordType: "driver-dropoff-photo"
  }), false);
});

test("S17: visit state hashes are stable but bind plan revision and completion state", () => {
  const base = {
    planId: 41,
    planDate: "2026-08-19",
    planRevision: 7,
    driverLogin: "li",
    jobIds: ["drop-a", "drop-b"],
    records: [{ jobId: "drop-a", status: "in_progress", startedAt: "2026-08-19T14:00:00.000Z" }]
  };
  const first = historicalAssistStateHash(base);
  assert.match(first, /^[0-9a-f]{64}$/u);
  assert.equal(historicalAssistStateHash(structuredClone(base)), first);
  assert.equal(historicalAssistStateHash({
    records: base.records,
    jobIds: base.jobIds,
    driverLogin: base.driverLogin,
    planRevision: base.planRevision,
    planDate: base.planDate,
    planId: base.planId
  }), first);
  assert.notEqual(historicalAssistStateHash({ ...base, planRevision: 8 }), first);
  assert.notEqual(historicalAssistStateHash({
    ...base,
    records: [{ jobId: "drop-a", status: "complete", completedAt: "2026-08-19T14:05:00.000Z" }]
  }), first);
});
