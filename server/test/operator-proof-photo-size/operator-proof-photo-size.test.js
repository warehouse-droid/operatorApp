// 2026-11-06, SN1404273: Operator refused the load confirmation with "Photos are too large. Retake
// fewer or smaller photos." Load and Receive photos were stored exactly as the camera produced them
// (Android native camera JPEGs, Windows ImageCapture at the sensor maximum), and one confirmation allows
// 16 MB of photos in total. They are now resized to a 2048 px long edge (JPEG 0.86) when taken, as
// driver photos are. Return photos keep their 1800 px / JPEG 0.84 compression.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(process.env.OPERATOR_PROOF_PHOTO_SOURCE || "public/operator.js", "utf8");
const extract = name => {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert(start >= 0, `operator.js has no function ${name}`);
  return source.slice(start, start + source.slice(start).search(/^}/m) + 1);
};
const constants = () => {
  const lines = source.match(/^const OPERATOR_PROOF_PHOTO_[A-Z_]+ = [^;]+;$/gm) || [];
  assert.equal(lines.length, 2, "operator.js defines the proof photo size and quality");
  return lines.join("\n");
};

// A full-resolution camera photo: 4080 x 3060 (12.5 MP), about 6 MB as a data URL.
const CAMERA_PHOTO = `data:image/jpeg;base64,${"A".repeat(8_000_000)}`;
const RESIZED = "data:image/jpeg;base64,cmVzaXplZA==";

function setup({ width = 4080, height = 3060, decodes = true } = {}) {
  const canvases = [], toasts = [];
  class FakeImage {
    set src(value) {
      this.loaded = value; this.naturalWidth = decodes ? width : 0; this.naturalHeight = decodes ? height : 0;
      queueMicrotask(() => (decodes ? this.onload() : this.onerror(new Error("cannot decode"))));
    }
  }
  const context = vm.createContext({
    Image: FakeImage, String, Math, Number,
    document: {
      getElementById: () => ({ videoWidth: width, videoHeight: height }),
      createElement(tag) {
        assert.equal(tag, "canvas");
        const canvas = { width: 0, height: 0, drawn: null, type: null, quality: null,
          getContext: () => ({ drawImage: (_image, _x, _y, w, h) => { canvas.drawn = [w, h]; } }),
          toDataURL(type, quality) { canvas.type = type; canvas.quality = quality; return RESIZED; } };
        canvases.push(canvas); return canvas;
      }
    },
    captured: CAMERA_PHOTO,
    captureNativeCameraPhoto: async () => context.captured,
    captureCameraPhotoDataUrl: async () => context.captured,
    operatorPhotoCameraContext: () => ({ key: "same" }),
    fulfillmentPhotoDataUrls: [], fulfillmentActivePhotoSlot: 0, fulfillmentCameraStream: {}, fulfillmentPhotoSlotFloor: () => 2,
    receiptPhotoDataUrls: [], receiptActivePhotoSlot: 0, receiptCameraStream: {},
    returnPhotoSlot: 0, returnPhotoTarget: { open: true }, returnPhotos: [], returnDirty: false,
    returnPhotoTargetsMatch: () => true, returnTargetPhotos: () => context.returnPhotos,
    setReturnTargetPhotos: photos => { context.returnPhotos = photos; },
    render() {}, showToast: message => toasts.push(message), t: (_key, fallback) => fallback,
  });
  return { context, canvases, toasts };
}
const load = (context, names, withConstants = true) =>
  vm.runInContext([withConstants ? constants() : "", ...names.map(extract)].join("\n"), context);
const PROOF = ["compressReturnPhoto", "compressOperatorProofPhoto", "nextPhotoSlot"];

test("SN1404273: Android native Load and Receive photos are resized to a 2048 px long edge", async () => {
  for (const kind of ["fulfillment", "receipt"]) {
    const { context, canvases, toasts } = setup();
    load(context, [...PROOF, "captureNativeOperatorPhoto"]);
    await context.captureNativeOperatorPhoto({ kind, key: "same" });
    const stored = kind === "receipt" ? context.receiptPhotoDataUrls : context.fulfillmentPhotoDataUrls;
    assert.deepEqual([...stored], [RESIZED], kind);
    assert.equal(canvases.length, 1, kind);
    assert.deepEqual([canvases[0].width, canvases[0].height], [2048, 1536], kind);
    assert.deepEqual(canvases[0].drawn, [2048, 1536], kind);
    assert.equal(canvases[0].type, "image/jpeg"); assert.equal(canvases[0].quality, 0.86);
    assert.deepEqual(toasts, []);
  }
});

test("Windows camera Load and Receive photos are resized to a 2048 px long edge", async () => {
  for (const [kind, capture] of [["fulfillment", "captureFulfillmentPhoto"], ["receipt", "captureReceiptPhoto"]]) {
    // Portrait: the long edge is the height.
    const { context, canvases, toasts } = setup({ width: 3060, height: 4080 });
    load(context, [...PROOF, capture]);
    await context[capture]();
    const stored = kind === "receipt" ? context.receiptPhotoDataUrls : context.fulfillmentPhotoDataUrls;
    assert.deepEqual([...stored], [RESIZED], kind);
    assert.deepEqual([canvases[0].width, canvases[0].height], [1536, 2048], kind);
    assert.equal(canvases[0].quality, 0.86);
    assert.equal(kind === "receipt" ? context.receiptActivePhotoSlot : context.fulfillmentActivePhotoSlot, 1, "next slot");
    assert.deepEqual(toasts, []);
  }
});

test("a photo the browser cannot decode is kept as taken", async () => {
  const { context, canvases, toasts } = setup({ decodes: false });
  load(context, [...PROOF, "captureNativeOperatorPhoto", "captureFulfillmentPhoto"]);
  await context.captureNativeOperatorPhoto({ kind: "receipt", key: "same" });
  await context.captureFulfillmentPhoto();
  assert.equal(context.receiptPhotoDataUrls[0], CAMERA_PHOTO);
  assert.equal(context.fulfillmentPhotoDataUrls[0], CAMERA_PHOTO);
  assert.equal(canvases.length, 0); assert.deepEqual(toasts, []);
});

test("a photo already within 2048 px and under 1.5 MB is kept unchanged", async () => {
  const { context, canvases } = setup({ width: 2048, height: 1536 });
  context.captured = `data:image/jpeg;base64,${"B".repeat(1_900_000)}`;
  load(context, [...PROOF, "captureNativeOperatorPhoto"]);
  await context.captureNativeOperatorPhoto({ kind: "fulfillment", key: "same" });
  assert.equal(context.fulfillmentPhotoDataUrls[0], context.captured);
  assert.equal(canvases.length, 0);
});

test("Return photos keep their 1800 px long edge and JPEG 0.84", async () => {
  const { context, canvases } = setup();
  load(context, ["compressReturnPhoto", "nextPhotoSlot", "captureNativeOperatorPhoto"], false);
  context.compressOperatorProofPhoto = async () => assert.fail("Return photos use compressReturnPhoto");
  await context.captureNativeOperatorPhoto({ kind: "return", key: "same" });
  assert.deepEqual([...context.returnPhotos], [RESIZED]);
  assert.deepEqual([canvases[0].width, canvases[0].height], [1800, 1350]);
  assert.equal(canvases[0].quality, 0.84);
});
