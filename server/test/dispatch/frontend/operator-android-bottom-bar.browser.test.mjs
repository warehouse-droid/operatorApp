import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { setup, enter } from "./operator-android-camera-fixture.mjs";

const art = "test-artifacts/operator-android-bottom-bar";
async function start({ standalone = true, platform = "Android", touch = 10, height = 800, storedHeight } = {}) {
  const run = await setup();
  await run.page.addInitScript(({ standalone, platform, touch, storedHeight }) => {
    const match = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const result = match(query);
      if (query === "(display-mode: standalone)") Object.defineProperty(result, "matches", { value: standalone });
      return result;
    };
    Object.defineProperty(navigator, "userAgent", { value: `Mozilla/5.0 (${platform}) Chrome/151.0.0.0 Safari/537.36` });
    Object.defineProperty(navigator, "userAgentData", { value: { platform } });
    Object.defineProperty(navigator, "maxTouchPoints", { value: touch });
    Object.defineProperty(screen, "width", { value: 1280 });
    Object.defineProperty(screen, "height", { value: 800 });
    if (storedHeight) sessionStorage.setItem("mbbs.operator.safe-viewport", JSON.stringify({
      key: [screen.width, screen.height, screen.orientation?.type, innerWidth, devicePixelRatio].join(":"), height: storedHeight,
    }));
  }, { standalone, platform, touch, storedHeight });
  await run.page.setViewportSize({ width: 1280, height });
  await run.page.reload();
  await run.page.locator('[data-action="open-module"][data-module="delivery"]').waitFor();
  return run;
}
async function geometry(page) {
  return page.locator("#app").evaluate(app => {
    const rect = app.getBoundingClientRect();
    const style = getComputedStyle(app);
    return { top: rect.top, height: rect.height, bottom: rect.bottom, padding: parseFloat(style.paddingBottom),
      position: style.position, contentBottom: rect.bottom - parseFloat(style.paddingBottom),
      actions: [...app.querySelectorAll(".selected-actions, .return-review-actions, .module-tile")].map(el => el.getBoundingClientRect().bottom) };
  });
}

test("Android retains its working launch height across viewport expansion, redraws, reload and resume", async () => {
  const run = await start({ height: 752 });
  const { page } = run;
  const observations = [];
  try {
    await mkdir(art, { recursive: true });
    assert.equal((await geometry(page)).height, 752);
    assert.equal((await geometry(page)).padding, 15);
    // Simulate the reported transition: Chrome starts above a 48px bar, then
    // incorrectly includes the bar in all viewport dimensions after loading.
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const kind of ["menu", "delivery", "receipt", "return"]) {
      if (kind !== "menu") await enter(page, kind);
      for (let redraw = 0; redraw < 3; redraw++) {
        await page.evaluate(() => render());
        await page.waitForTimeout(40);
        const row = await geometry(page);
        observations.push({ kind, redraw, ...row });
        assert.equal(row.top, 0);
        assert.equal(row.padding, 15);
        assert.equal(row.height, 752);
        assert.equal(row.position, "fixed");
        assert.equal(row.contentBottom, 737);
        for (const bottom of row.actions) assert.ok(bottom <= 737, `${kind}: action overlaps the protected area`);
      }
    }
    await page.evaluate(() => {
      window.dispatchEvent(new Event("pageshow"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(40);
    assert.equal((await geometry(page)).padding, 15);
    await page.reload();
    await page.waitForFunction(() => document.getElementById("app").getBoundingClientRect().height === 752);
    assert.equal((await geometry(page)).padding, 15);
    assert.deepEqual(run.errors, []);
  } finally {
    await writeFile(`${art}/redraw-geometry.json`, JSON.stringify({ simulated: true, physicalM10TVerified: false, observations }, null, 2));
    await run.close();
  }
});

test("Android follows visual viewport changes and recovers after a keyboard-sized reduction", async () => {
  const run = await start();
  const { page } = run;
  try {
    await page.evaluate(() => {
      Object.defineProperty(visualViewport, "height", { configurable: true, get: () => 552 });
      visualViewport.dispatchEvent(new Event("resize"));
    });
    await page.waitForFunction(() => document.getElementById("app").getBoundingClientRect().height === 552);
    assert.equal((await geometry(page)).padding, 15);
    await page.evaluate(() => {
      delete visualViewport.height;
      visualViewport.dispatchEvent(new Event("resize"));
    });
    await page.waitForFunction(() => document.getElementById("app").getBoundingClientRect().height === 800);
    await page.setViewportSize({ width: 800, height: 1280 });
    await page.waitForFunction(() => document.getElementById("app").getBoundingClientRect().height === 1280);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForFunction(() => document.getElementById("app").getBoundingClientRect().height === 800);
    assert.deepEqual(run.errors, []);
  } finally { await run.close(); }
});

test("Android refreshes height after a redraw even without a viewport event", async () => {
  const run = await start();
  try {
    await run.page.evaluate(() => {
      Object.defineProperty(visualViewport, "height", { configurable: true, get: () => 752 });
      render();
    });
    await run.page.waitForFunction(() => document.getElementById("app").getBoundingClientRect().height === 752);
    assert.equal((await geometry(run.page)).padding, 15);
  } finally { await run.close(); }
});

test("pinch zoom keeps the layout height instead of shrinking the workspace", async () => {
  const run = await start();
  try {
    await run.page.evaluate(() => {
      Object.defineProperty(visualViewport, "height", { configurable: true, get: () => 400 });
      Object.defineProperty(visualViewport, "scale", { configurable: true, get: () => 2 });
      visualViewport.dispatchEvent(new Event("resize"));
    });
    await run.page.waitForTimeout(40);
    assert.equal((await geometry(run.page)).height, 800);
    assert.equal((await geometry(run.page)).padding, 15);
  } finally { await run.close(); }
});

for (const [name, options, expected] of [
  ["Android desktop mode", { platform: "Linux", touch: 10 }, "fixed"],
  ["Windows touch tablet", { platform: "Windows", touch: 10 }, "static"],
  ["Linux desktop", { platform: "Linux", touch: 0 }, "static"],
  ["Android browser tab", { platform: "Android", standalone: false }, "static"],
]) test(`${name} gets the correct bottom clearance`, async () => {
  const run = await start(options);
  try {
    assert.equal((await geometry(run.page)).padding, 15);
    assert.equal((await geometry(run.page)).position, expected);
    assert.deepEqual(run.errors, []);
  } finally { await run.close(); }
});

test("reported system insets and remembered launch height are not counted twice", async () => {
  const run = await start({ height: 752 });
  try {
    await run.page.setViewportSize({ width: 1280, height: 800 });
    const session = await run.page.context().newCDPSession(run.page);
    for (const bottom of [0, 24, 48, 72, 0]) {
      await session.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom } });
      await run.page.evaluate(() => render());
      await run.page.waitForTimeout(40);
      const row = await geometry(run.page);
      assert.equal(row.height, Math.min(752, 800 - bottom));
      assert.equal(row.padding, 15);
    }
  } finally { await run.close(); }
});

test("a corrected launch replaces an older oversized saved height", async () => {
  const run = await start({ height: 752, storedHeight: 800 });
  try {
    assert.equal((await geometry(run.page)).height, 752);
    await run.page.setViewportSize({ width: 1280, height: 800 });
    await run.page.evaluate(() => render());
    await run.page.waitForTimeout(40);
    assert.equal((await geometry(run.page)).height, 752);
  } finally { await run.close(); }
});
