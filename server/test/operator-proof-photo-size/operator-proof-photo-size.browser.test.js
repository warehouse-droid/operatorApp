// 2026-11-06, SN1404273: in real Chromium, four 12 MP Load photos as the camera produced them (about
// 5 MB each) are refused by the Operator photo outbox ("Photos are too large. Retake fewer or smaller
// photos."); the same photos resized by compressOperatorProofPhoto (2048 px, about 1 MB) are accepted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, before } from "node:test";
import { chromium } from "playwright";

const operator = readFileSync(process.env.OPERATOR_PROOF_PHOTO_SOURCE || "public/operator.js", "utf8");
const outbox = readFileSync("public/operator-photo-outbox.js", "utf8");
const extract = name => {
  const start = operator.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert(start >= 0, `operator.js has no function ${name}`);
  return operator.slice(start, start + operator.slice(start).search(/^}/m) + 1);
};
const constants = () => {
  const lines = operator.match(/^const OPERATOR_PROOF_PHOTO_[A-Z_]+ = [^;]+;$/gm) || [];
  assert.equal(lines.length, 2, "operator.js defines the proof photo size and quality");
  return lines.join("\n");
};
const ORIGIN = "https://operator.test";
let browser;

before(async () => { browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] }); });
after(async () => { await browser?.close(); });

async function openPage() {
  const context = await browser.newContext({ serviceWorkers: "block" });
  // A secure origin, so IndexedDB and crypto.subtle behave as on the Operator site.
  await context.route(`${ORIGIN}/**`, route => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>photos</title>" }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ content: outbox });
  await page.addScriptTag({ content: [constants(), extract("compressReturnPhoto"), extract("compressOperatorProofPhoto"), `
    // A camera-like photo: a gradient with fine random texture (JPEG 0.92, as the camera path stores).
    window.cameraPhoto = (width, height, seed) => {
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d"), fill = ctx.createLinearGradient(0, 0, width, height);
      fill.addColorStop(0, "#5b6f86"); fill.addColorStop(1, "#c9b48a"); ctx.fillStyle = fill; ctx.fillRect(0, 0, width, height);
      const small = new OffscreenCanvas(Math.ceil(width / 2), Math.ceil(height / 2)), sctx = small.getContext("2d");
      const data = sctx.createImageData(small.width, small.height); let state = seed >>> 0;
      for (let i = 0; i < data.data.length; i += 4) {
        state = (state * 1664525 + 1013904223) >>> 0; const value = state >>> 24;
        data.data[i] = value; data.data[i + 1] = (value * 7) & 255; data.data[i + 2] = (value * 13) & 255; data.data[i + 3] = 110;
      }
      sctx.putImageData(data, 0, 0); ctx.drawImage(small, 0, 0, width, height);
      return canvas.toDataURL("image/jpeg", 0.92);
    };
    window.photoSize = async url => { const image = new Image(); image.src = url; await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight, bytes: atob(url.slice(url.indexOf(",") + 1)).length }; };
  `].join("\n") });
  return { page, errors, close: () => context.close() };
}

test("SN1404273: four 12 MP photos are refused as taken and accepted once resized", async () => {
  const run = await openPage();
  try {
    const result = await run.page.evaluate(async () => {
      const originals = [1, 2, 3, 4].map(seed => window.cameraPhoto(4000, 3000, seed));
      const refused = await window.OperatorPhotoOutbox.prepare({ actorId: "operator", requestId: crypto.randomUUID(), photos: originals })
        .then(() => null, error => error.message);
      const resized = [];
      for (const photo of originals) resized.push(await compressOperatorProofPhoto(photo));
      const accepted = await window.OperatorPhotoOutbox.prepare({ actorId: "operator", requestId: crypto.randomUUID(), photos: resized });
      return { refused, originals: await Promise.all(originals.map(window.photoSize)), resized: await Promise.all(resized.map(window.photoSize)),
        manifest: accepted.backgroundPhotos.map(photo => photo.byteSize) };
    });
    const total = sizes => sizes.reduce((sum, size) => sum + size.bytes, 0);
    assert.ok(total(result.originals) > 16 * 1024 * 1024, `photos as taken: ${total(result.originals)} bytes`);
    assert.equal(result.refused, "Photos are too large. Retake fewer or smaller photos.");
    for (const size of result.resized) {
      assert.deepEqual([size.width, size.height], [2048, 1536]);
      assert.ok(size.bytes < 2 * 1024 * 1024, `resized photo: ${size.bytes} bytes`);
    }
    assert.ok(total(result.resized) * 3 < total(result.originals), "resized photos are a fraction of the originals");
    assert.deepEqual(result.manifest, result.resized.map(size => size.bytes));
    assert.deepEqual(run.errors, []);
  } finally { await run.close(); }
});

test("a portrait photo stays portrait at 1536 x 2048", async () => {
  const run = await openPage();
  try {
    const size = await run.page.evaluate(async () => window.photoSize(await compressOperatorProofPhoto(window.cameraPhoto(3000, 4000, 9))));
    assert.deepEqual([size.width, size.height], [1536, 2048]);
    assert.deepEqual(run.errors, []);
  } finally { await run.close(); }
});
