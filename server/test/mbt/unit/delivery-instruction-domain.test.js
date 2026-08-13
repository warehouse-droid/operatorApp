import assert from "node:assert/strict";
import test from "node:test";

import {
  DELIVERY_INSTRUCTION_IMAGE_TYPES,
  DELIVERY_INSTRUCTION_MAX_MEDIA,
  DELIVERY_INSTRUCTION_MAX_MEDIA_BYTES,
  DELIVERY_INSTRUCTION_VIDEO_TYPES,
  assertDeliveryInstructionRevision,
  deliveryInstructionEditBlock,
  deliveryInstructionUploadReferenceMatches,
  deriveMemoDeliveryInstruction,
  normalizeDeliveryInstructionMedia,
  normalizeDeliveryInstructionText
} from "../../../src/delivery-instruction-domain.js";

test("memo extraction removes planned address/date while retaining phone and every other line", () => {
  const result = deriveMemoDeliveryInstruction(`
Delivery Address: 92 Chaplin Crescent, Toronto, ON M5P 1A5
Delivery Date: 2026-08-15
Delivery Time: 12:00-17:00
Tel: (416) 555-1212
Contact: Alice at side gate
Drop-off Loc: On grass
ON ACC
Gate code 1234
  `);

  assert.equal(result.fallbackUsed, false);
  assert.doesNotMatch(result.text, /92 Chaplin|2026-08-15|12:00-17:00/);
  for (const expected of ["Tel: (416) 555-1212", "Contact: Alice", "Drop-off Loc: On grass", "ON ACC", "Gate code 1234"]) {
    assert.match(result.text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.deepEqual(result.phones, [{ display: "(416) 555-1212", href: "+14165551212" }]);
});

test("empty memo and invalid phone-like values remain safe", () => {
  assert.deepEqual(deriveMemoDeliveryInstruction(" \r\n "), {
    text: "",
    phones: [],
    fallbackUsed: false,
    source: "empty"
  });
  assert.deepEqual(
    deriveMemoDeliveryInstruction("Contact code 123-45 only").phones,
    []
  );
});

test("ambiguous mixed address content falls back to the complete raw memo", () => {
  const memo = "Delivery Address: PO#3005690 92 Chaplin Crescent, Toronto, ON M5P 1A5 | Tel: 416-841-2217\nDrop-off Loc: On Grass";
  const result = deriveMemoDeliveryInstruction(memo);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.text, memo);
  assert.deepEqual(result.phones, [{ display: "416-841-2217", href: "+14168412217" }]);
});

test("Chinese memo labels retain telephone and placement while omitting planned fields", () => {
  const result = deriveMemoDeliveryInstruction("送货地址：18 Stanwood Crescent, North York, ON M9M 1Z9\n送货时间：8月15日中午\n联系电话：647-572-7218\n砖的放置：客人在场");
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.text, "联系电话：647-572-7218\n砖的放置：客人在场");
  assert.deepEqual(result.phones, [{ display: "647-572-7218", href: "+16475727218" }]);
});

test("additional text is line-preserving, bounded, and rejects non-text input", () => {
  assert.equal(normalizeDeliveryInstructionText("  Call first.  \r\n  Use side gate. \r\n"), "Call first.\nUse side gate.");
  assert.throws(() => normalizeDeliveryInstructionText("x".repeat(5001)), /5,000/);
  assert.throws(() => normalizeDeliveryInstructionText({ text: "unsafe" }), /text/i);
});

test("media accepts the approved formats and exact five-file, 25 MiB boundaries", () => {
  assert.equal(DELIVERY_INSTRUCTION_MAX_MEDIA, 5);
  assert.equal(DELIVERY_INSTRUCTION_MAX_MEDIA_BYTES, 25 * 1024 * 1024);
  for (const mimeType of [
    "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
    "video/mp4", "video/quicktime", "video/webm"
  ]) {
    const media = normalizeDeliveryInstructionMedia({
      mimeType,
      byteSize: DELIVERY_INSTRUCTION_MAX_MEDIA_BYTES,
      fileName: " original file "
    }, { activeCount: 4 });
    assert.equal(media.mimeType, mimeType);
    assert.equal(media.byteSize, DELIVERY_INSTRUCTION_MAX_MEDIA_BYTES);
  }
  assert(DELIVERY_INSTRUCTION_IMAGE_TYPES.every((type) => type.startsWith("image/")));
  assert(DELIVERY_INSTRUCTION_VIDEO_TYPES.every((type) => type.startsWith("video/")));
  assert.throws(
    () => normalizeDeliveryInstructionMedia({ mimeType: "video/mp4", byteSize: 1 }, { activeCount: 5 }),
    /five/i
  );
  assert.throws(
    () => normalizeDeliveryInstructionMedia({ mimeType: "video/mp4", byteSize: DELIVERY_INSTRUCTION_MAX_MEDIA_BYTES + 1 }),
    /25 MB/i
  );
  assert.throws(() => normalizeDeliveryInstructionMedia({ mimeType: "video/mp4", byteSize: 0 }), /positive/i);
  assert.throws(() => normalizeDeliveryInstructionMedia({ mimeType: "text/html", byteSize: 10 }), /type/i);
});

test("stale revisions and completed drop-offs fail closed", () => {
  assert.equal(assertDeliveryInstructionRevision(4, 4), 4);
  assert.throws(
    () => assertDeliveryInstructionRevision(3, 4),
    (error) => error?.status === 409 && error?.code === "DELIVERY_INSTRUCTION_REVISION_CONFLICT"
  );
  assert.throws(() => assertDeliveryInstructionRevision(undefined, 0), /valid expected/i);
  assert.equal(deliveryInstructionEditBlock({ dropoffCompleted: false, terminal: false }), null);
  assert.match(deliveryInstructionEditBlock({ dropoffCompleted: true, terminal: false }), /completed/i);
  assert.match(deliveryInstructionEditBlock({ dropoffCompleted: false, terminal: true }), /terminal/i);
});

test("upload registration requires the exact issued upload identity", () => {
  const uploadId = "b8f8d23d-5db0-40c3-8d3b-a76109422f2d";
  assert.equal(deliveryInstructionUploadReferenceMatches(
    `r2://sales/sales-delivery-instruction-media/2026/08/11/${uploadId}/front-gate.mp4`,
    uploadId
  ), true);
  assert.equal(deliveryInstructionUploadReferenceMatches(
    "r2://sales/sales-delivery-instruction-media/2026/08/11/another-id/front-gate.mp4",
    uploadId
  ), false);
  assert.equal(deliveryInstructionUploadReferenceMatches("r2://driver/driver-stop-photo/file.jpg", uploadId), false);
});
