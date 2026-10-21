import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { setup, enter, frames } from "../test/dispatch/frontend/operator-android-camera-fixture.mjs";

const art = "test-artifacts/operator-android-camera-release";
const actions = { delivery: "start-camera", receipt: "start-receipt-camera", return: "return-start-camera" };
async function photo(page) {
  return Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 240; canvas.height = 180;
    const context = canvas.getContext("2d"); context.fillStyle = "#14ae64"; context.fillRect(0, 0, 240, 180);
    return canvas.toDataURL("image/jpeg").split(",")[1];
  }), "base64");
}
async function choose(page, action, buffer) {
  const chooser = page.waitForEvent("filechooser");
  await page.locator(`[data-action="${action}"]`).click();
  const picker = await chooser;
  assert.equal(await picker.element().getAttribute("capture"), "environment");
  assert.equal(await picker.element().getAttribute("accept"), "image/*");
  await picker.setFiles({ name: "camera.jpg", mimeType: "image/jpeg", buffer });
}
for (const [width, height] of [[1280, 752], [1024, 552], [800, 432], [768, 960]]) test(`default tablet layout ${width}x${height} keeps workspaces and final actions in the visible screen`, async () => {
  const run = await setup(), { page } = run;
  try {
    await page.setViewportSize({ width, height });
    const failures = [], geometry = [];
    for (const kind of ["menu", "delivery", "receipt", "return"]) {
      if (kind !== "menu") await enter(page, kind);
      await page.waitForFunction(() => !operatorPhotoCamera.opening);
      const extra = page.locator('[data-action="add-fulfillment-photo"], [data-action="add-receipt-photo"], [data-action="return-add-photo"]');
      if (await extra.count()) {
        const reachable = await extra.evaluate(el => {
          const box = el.getBoundingClientRect();
          for (let parent = el.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent), area = parent.getBoundingClientRect();
            if (["auto", "scroll"].includes(style.overflowY)) return true;
            if (["hidden", "clip"].includes(style.overflowY) && (box.bottom > area.bottom || box.top < area.top)) return false;
          }
          return box.bottom <= innerHeight - 15;
        });
        if (!reachable) failures.push({ kind, control: "Add another photo is clipped and unreachable" });
      }
      const result = await page.evaluate(() => {
        const app = document.querySelector("#app"), box = app.getBoundingClientRect();
        const elements = [...app.querySelectorAll(':scope > section, .selected-actions, .return-review-actions, .module-tile')];
        return { height: innerHeight, shell: box.toJSON(), scroll: document.documentElement.scrollHeight,
          boxes: elements.map(el => ({ selector: el.className, ...el.getBoundingClientRect().toJSON() })) };
      });
      geometry.push({ kind, ...result });
      for (const box of result.boxes) {
        if (box.bottom > height - 15 + 1 || box.right > width + 1 || box.left < -1) failures.push({ kind, ...box });
      }
      await page.screenshot({ path: `${art}/layout-${process.env.OPERATOR_ANDROID_BASELINE === "1" ? "baseline" : "candidate"}-${width}x${height}-${kind}.png` });
    }
    await writeFile(`${art}/geometry-${process.env.OPERATOR_ANDROID_BASELINE === "1" ? "baseline" : "candidate"}-${width}x${height}.json`, JSON.stringify(geometry, null, 2));
    assert.deepEqual(failures, [], "Controls must be inside the viewport, above the bottom padding");
    assert.deepEqual(run.errors, []);
  } finally { await run.close(); }
});

test("shell follows the visible viewport when Android system UI reduces usable height", async () => {
  const run = await setup(), { page } = run;
  try {
    await page.setViewportSize({ width: 1024, height: 600 });
    await page.evaluate(() => {
      Object.defineProperty(visualViewport, "height", { configurable: true, get: () => 552 });
      visualViewport.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(50);
    assert.equal(await page.locator("#app").evaluate(el => el.getBoundingClientRect().height), 552);
    await page.evaluate(() => { delete visualViewport.height; visualViewport.dispatchEvent(new Event("resize")); });
    await page.waitForTimeout(50);
    assert.equal(await page.locator("#app").evaluate(el => el.getBoundingClientRect().height), 600);
  } finally { await run.close(); }
});
