import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { setup, enter, frames } from "./operator-android-camera-fixture.mjs";

const art = "test-artifacts/operator-android-camera-release";
const actions = { delivery: "start-camera", receipt: "start-receipt-camera", return: "return-start-camera" };

test("an Android tablet reporting Linux desktop mode still uses native capture", async () => {
  const run = await setup(), { page } = run;
  try {
    await page.evaluate(() => {
      Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36" });
      Object.defineProperty(navigator, "userAgentData", { configurable: true, value: { platform: "Linux", mobile: false } });
      Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 10 });
    });
    await enter(page, "receipt");
    assert.equal(await page.evaluate(() => window.cameraCheck.calls.length), 0);
    await choose(page, "start-receipt-camera", await photo(page));
    await page.waitForFunction(() => receiptPhotoDataUrls.filter(Boolean).length === 1);
    assert.equal(await page.evaluate(() => window.cameraCheck.calls.length), 0);
  } finally { await run.close(); }
});

async function photo(page) {
  return Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 240; canvas.height = 180;
    const context = canvas.getContext("2d"); context.fillStyle = "#14ae64"; context.fillRect(0, 0, 240, 180);
    return canvas.toDataURL("image/jpeg").split(",")[1];
  }), "base64");
}
async function choose(page, action, buffer) {
  const [picker] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 5000 }),
    page.locator(`[data-action="${action}"]`).click({ timeout: 5000 }),
  ]);
  assert.equal(await picker.element().getAttribute("capture"), "environment");
  assert.equal(await picker.element().getAttribute("accept"), "image/*");
  await picker.setFiles({ name: "camera.jpg", mimeType: "image/jpeg", buffer });
}
for (const kind of ["delivery", "receipt", "return"]) test(`Android ${kind}: native photo capture never opens a browser stream, including background and resume`, async () => {
  const run = await setup(), { page } = run;
  try {
    await enter(page, kind);
    assert.equal(await page.evaluate(() => window.cameraCheck.calls.length), 0);
    await choose(page, actions[kind], await photo(page));
    await page.waitForFunction(kind => (kind === "receipt" ? receiptPhotoDataUrls : kind === "return" ? returnTargetPhotos() : fulfillmentPhotoDataUrls).filter(Boolean).length === 1, kind);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange")); render();
      delete document.visibilityState; document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal(await page.evaluate(() => window.cameraCheck.calls.length), 0);
    assert.equal(await page.locator('input[type="file"]').count(), 0);
    assert.deepEqual(run.errors, []);
  } finally { await run.close(); }
});

test("Windows close and rerender detach previous video elements and end tracks", async () => {
  const run = await setup(false), { page } = run;
  try {
    await enter(page, "receipt"); await frames(page);
    await page.evaluate(() => { window.previousVideo = document.querySelector("#receiptCamera"); render(); });
    assert.equal(await page.evaluate(() => window.previousVideo.srcObject), null);
    await frames(page);
    await page.evaluate(() => { window.previousVideo = document.querySelector("#receiptCamera"); });
    await page.locator('[data-action="stop-receipt-camera"]').click();
    assert.equal(await page.evaluate(() => window.previousVideo.srcObject), null);
    assert.equal(await page.evaluate(() => window.cameraCheck.tracks.every(track => track.readyState === "ended")), true);
    assert.deepEqual(run.errors, []);
  } finally { await run.close(); }
});

test("Android cancelling or returning a photo after changing orders cannot change proof", async () => {
  const run = await setup(), { page } = run;
  try {
    await enter(page, "receipt");
    assert.equal(await page.evaluate(() => window.cameraCheck.calls.length), 0);
    const chooser = page.waitForEvent("filechooser");
    await page.locator('[data-action="start-receipt-camera"]').click();
    const input = (await chooser).element();
    await input.dispatchEvent("cancel");
    assert.equal(await page.evaluate(() => receiptPhotoDataUrls.filter(Boolean).length), 0);
    const next = page.waitForEvent("filechooser");
    await page.locator('[data-action="start-receipt-camera"]').click();
    const picker = await next;
    await page.evaluate(() => { receiptRequestId = "new-order"; receiptOrder.netsuite_id = "other-order"; render(); });
    await picker.setFiles({ name: "camera.jpg", mimeType: "image/jpeg", buffer: await photo(page) });
    await page.waitForFunction(() => !document.querySelector('input[type="file"]'));
    assert.equal(await page.evaluate(() => receiptPhotoDataUrls.filter(Boolean).length), 0);
    assert.deepEqual(run.errors, []);
  } finally { await run.close(); }
});

test("Android barcode buttons use camera photos without starting Quagga LiveStream", async () => {
  const run = await setup(), { page } = run;
  try {
    for (const kind of ["pickup", "return"]) {
      await page.evaluate(kind => {
        currentModule = kind === "pickup" ? "customer-pickup-scan" : "stock-return";
        if (kind === "return") { resetReturnWorkflow("stock"); returnView = "workflow"; returnStage = "lookup"; }
        render();
        window.scannerOpened = false;
        window.Quagga = { init: () => { window.scannerOpened = true; }, decodeSingle: (_config, done) => done(null) };
      }, kind);
      const start = kind === "pickup" ? "start-pickup-scanner" : "return-start-scanner";
      const click = page.locator(`[data-action="${start}"]`);
      const chooser = page.waitForEvent("filechooser");
      await click.click();
      await chooser;
      assert.equal(await page.evaluate(() => window.scannerOpened), false);
      assert.equal(await page.locator('input[type="file"][capture="environment"]').count(), 1);
      await page.locator('input[type="file"]').dispatchEvent("cancel");
      assert.equal(await page.evaluate(() => window.cameraCheck.calls.length), 0);
    }
  } finally { await run.close(); }
});

test("Android Damage records a native camera photo across app background and return", async () => {
  const run = await setup(), { page } = run;
  try {
    await page.route('**/api/inventory/damage/**', async route => {
      const data = route.request().url().includes('/config') ? { reasons: [], month: "2026-09" }
        : { item_id: 42, item_name: "Damage fixture", to_pcs: 1, sales_unit: "PCS" };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.evaluate(async () => { currentModule = "damage"; await operatorInventory.open("damage");
      const button = document.createElement("button"); button.dataset.invAction = "damage-item"; button.dataset.id = "42"; app.appendChild(button); button.click(); });
    await page.locator('[data-inv-action="camera"]:enabled').waitFor();
    const chooser = page.waitForEvent("filechooser");
    await page.locator('[data-inv-action="camera"]').click();
    await chooser;
    assert.equal(await page.evaluate(() => window.cameraCheck.calls.length), 0);
    assert.equal(await page.locator('input[type="file"]').count(), 1);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      delete document.visibilityState; document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.locator('input[type="file"]').setInputFiles({ name: "damage.jpg", mimeType: "image/jpeg", buffer: await photo(page) });
    await page.locator('.damage-photos img').waitFor();
    assert.equal(await page.evaluate(() => window.cameraCheck.calls.length), 0);
    assert.deepEqual(run.errors, []);
  } finally { await run.close(); }
});

test("a barcode photo sends the decoded order to the existing pickup lookup", async () => {
  const run = await setup(), { page } = run;
  try {
    const bodies = [];
    await page.route('**/api/customer-pickup/lookup', async route => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ lines: [] }) });
    });
    await page.evaluate(() => {
      currentModule = "customer-pickup-scan"; render();
      window.Quagga = { decodeSingle: (_config, done) => done({ codeResult: { code: "SOB121625" } }) };
    });
    await choose(page, "start-pickup-scanner", await photo(page));
    await page.waitForFunction(() => document.querySelector("#toast.show") || !document.querySelector('input[type="file"]'));
    await page.waitForTimeout(100);
    assert.equal(bodies[0]?.code, "SOB121625");
    assert.equal(await page.evaluate(() => window.cameraCheck.calls.length), 0);
  } finally { await run.close(); }
});

test("native barcode decoder reads a real Code 39 image and reports a blank photo", async () => {
  const run = await setup(), { page } = run;
  try {
    await page.addScriptTag({ url: "/vendor/quagga2/quagga.min.js?v=1.12.1" });
    const result = await page.evaluate(async () => {
      const canvas = document.createElement("canvas"); canvas.width = 1000; canvas.height = 350;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, 1000, 350);
      const blank = canvas.toDataURL("image/png");
      const patterns = { "*": 0x094, S: 0x046, O: 0x112, B: 0x049, 1: 0x121, 2: 0x061, 6: 0x070, 5: 0x130 };
      let x = 70; ctx.fillStyle = "black";
      for (const letter of "*SOB121625*") {
        for (let bit = 8; bit >= 0; bit--) {
          const width = patterns[letter] & (1 << bit) ? 9 : 3;
          if (bit % 2 === 0) ctx.fillRect(x, 70, width, 210);
          x += width;
        }
        x += 3;
      }
      return { code: await decodeCameraPhoto(canvas.toDataURL("image/png")), blank: await decodeCameraPhoto(blank) };
    });
    assert.equal(result.code, "SOB121625"); assert.equal(result.blank, "");
    assert.equal(await page.evaluate(() => window.cameraCheck.calls.length), 0);
  } finally { await run.close(); }
});

test("return barcode photo uses return lookup and a blank photo leaves the workflow unchanged", async () => {
  const run = await setup(), { page } = run;
  try {
    const bodies = [];
    await page.route('**/api/returns/orders/lookup', async route => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "fixture lookup ends here" }) });
    });
    await page.evaluate(() => {
      currentModule = "stock-return"; resetReturnWorkflow("stock"); returnView = "workflow"; returnStage = "lookup"; render();
      window.Quagga = { decodeSingle: (_config, done) => done({ codeResult: { code: "SOB121625" } }) };
    });
    await writeFile(`${art}/return-lookup-state.json`, JSON.stringify(await page.evaluate(() => ({ currentModule, returnBusy, returnStage, returnView, locationId, text: app.innerText })), null, 2));
    await choose(page, "return-start-scanner", await photo(page));
    await page.waitForFunction(() => document.querySelector(".sync-alert")?.textContent.includes("fixture lookup"));
    assert.equal(bodies[0]?.code, "SOB121625");
    await page.evaluate(() => { window.Quagga.decodeSingle = (_config, done) => done(null); });
    await choose(page, "return-start-scanner", await photo(page));
    await page.locator('#toast').getByText(/No barcode found/).waitFor();
    assert.equal(bodies.length, 1);
    assert.equal(await page.evaluate(() => window.cameraCheck.calls.length), 0);
  } finally { await run.close(); }
});

test("native picker errors release the input and permit a later capture", async () => {
  const run = await setup(), { page } = run;
  try {
    await enter(page, "receipt");
    await page.evaluate(() => {
      const click = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function() { HTMLInputElement.prototype.click = click; throw new Error("Picker unavailable"); };
    });
    await page.locator('[data-action="start-receipt-camera"]').click();
    await page.locator('#toast').getByText('Picker unavailable').waitFor();
    assert.equal(await page.locator('input[type="file"]').count(), 0);
    await choose(page, "start-receipt-camera", await photo(page));
    await page.waitForFunction(() => receiptPhotoDataUrls.filter(Boolean).length === 1);
    assert.equal(await page.evaluate(() => window.cameraCheck.calls.length), 0);
  } finally { await run.close(); }
});
