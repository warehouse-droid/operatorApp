import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import {
  validateDeliveryInstructionImageBytes,
  validateDeliveryInstructionUploadedObject
} from "../../../src/delivery-instruction-media-validation.js";

test("delivery-instruction JPEG validation accepts a complete decodable image", async () => {
  const image = await sharp({
    create: { width: 960, height: 720, channels: 3, background: "#147b86" }
  }).jpeg({ quality: 72 }).toBuffer();
  const result = await validateDeliveryInstructionImageBytes(image, {
    mimeType: "image/jpeg",
    declaredByteSize: image.length
  });
  assert.deepEqual(result, {
    byteSize: image.length,
    width: 960,
    height: 720,
    mimeType: "image/jpeg"
  });
});

test("delivery-instruction JPEG validation rejects a truncated image", async () => {
  const image = await sharp({
    create: { width: 32, height: 24, channels: 3, background: "#ffffff" }
  }).jpeg().toBuffer();
  const truncated = image.subarray(0, image.length - 2);
  await assert.rejects(
    validateDeliveryInstructionImageBytes(truncated, {
      mimeType: "image/jpeg",
      declaredByteSize: truncated.length
    }),
    (error) => error.status === 422
      && error.code === "DELIVERY_INSTRUCTION_IMAGE_INVALID"
      && /incomplete or malformed/u.test(error.message)
  );
});

test("video registration skips image-object decoding", async () => {
  let fetched = false;
  const result = await validateDeliveryInstructionUploadedObject({
    mimeType: "video/mp4",
    byteSize: 10,
    fileName: "instruction.mp4"
  }, {
    fetchImpl: async () => { fetched = true; }
  });
  assert.deepEqual(result, { skipped: true, mediaKind: "video" });
  assert.equal(fetched, false);
});
