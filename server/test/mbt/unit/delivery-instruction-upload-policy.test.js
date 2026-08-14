import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../../../src/config.js";
import { createPhotoUploadToken } from "../../../src/photo-upload.js";

test("delivery-instruction source uploads allow image/video files up to 25 MiB without changing default evidence policy", () => {
  const original = config.photoUpload;
  try {
    config.photoUpload = {
      ...original,
      workerUrl: "https://uploads.example.test",
      tokenSecret: "delivery-instruction-test-secret", // secret-scan: allow non-secret test fixture
      maxMb: 10
    };
    const defaultTicket = createPhotoUploadToken({
      actor: { id: "dispatcher-1", role: "dispatcher" },
      source: "dispatch",
      recordType: "driver-stop-photo"
    });
    assert.equal(defaultTicket.maxMb, 10);
    assert(!defaultTicket.allowedTypes.includes("video/mp4"));

    const instructionTicket = createPhotoUploadToken({
      actor: { id: "dispatcher-1", role: "dispatcher" },
      source: "dispatch",
      recordType: "sales-delivery-instruction-media",
      metadata: { orderId: 123, orderRef: "SOB00123", photoId: "upload-id" },
      options: {
        maxBytes: 25 * 1024 * 1024,
        allowedTypes: ["image/jpeg", "video/mp4", "video/quicktime", "video/webm"]
      }
    });
    assert.equal(instructionTicket.maxBytes, 25 * 1024 * 1024);
    assert.deepEqual(instructionTicket.allowedTypes, [
      "image/jpeg",
      "video/mp4",
      "video/quicktime",
      "video/webm"
    ]);
  } finally {
    config.photoUpload = original;
  }
});
