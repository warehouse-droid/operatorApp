// Diagnostic only: simulate an OS bar outside the browser's reported safe area.
// This does not reproduce the physical M10T system UI or modify deployed assets.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { setup, enter } from "../test/dispatch/frontend/operator-android-camera-fixture.mjs";

const art = "test-artifacts/operator-android-bottom-bar";
test("compare current layout with a reserved strip under an unreported Android bar", async () => {
  await mkdir(art, { recursive: true });
  const run = await setup();
  const { page } = run;
  const observations = [];
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      const bar = document.createElement("div");
      bar.id = "simulated-system-bar";
      bar.textContent = "Simulated Android navigation bar — 48px";
      bar.style.cssText = "position:fixed;bottom:0;left:0;right:0;height:48px;background:#121820;color:white;z-index:999999;display:grid;place-items:center;font:16px Arial;";
      document.body.append(bar);
    });
    for (const kind of ["menu", "delivery", "receipt", "return"]) {
      if (kind !== "menu") await enter(page, kind);
      for (const reserved of [0, 48]) {
        const style = await page.addStyleTag({ content: reserved ? ".tablet-shell { height: calc(100dvh - 48px); }" : "/* Current layout. */" });
        const geometry = await page.evaluate(() => {
          const shell = document.getElementById("app");
          const bar = document.getElementById("simulated-system-bar");
          const rect = shell.getBoundingClientRect();
          const gap = parseFloat(getComputedStyle(shell).paddingBottom);
          return {
            viewport: innerHeight, visualViewport: visualViewport.height,
            barTop: bar.getBoundingClientRect().top, shellBottom: rect.bottom,
            contentLimit: rect.bottom - gap, paddingBottom: gap,
            actions: [...shell.querySelectorAll(".selected-actions, .return-review-actions, .module-tile")].map(el => ({
              selector: el.className, bottom: el.getBoundingClientRect().bottom,
            })),
          };
        });
        observations.push({ kind, reserved, ...geometry });
        if (reserved) {
          assert.equal(geometry.barTop - geometry.contentLimit, 15);
          for (const action of geometry.actions) assert.ok(action.bottom <= geometry.contentLimit, `${kind}: ${action.selector} extends below the safe work area`);
        } else assert.ok(geometry.contentLimit > geometry.barTop, "The existing 15px margin is inside the simulated overlay");
        if (kind === "receipt") await page.screenshot({ path: `${art}/${reserved ? "prototype" : "baseline"}.png` });
        await style.evaluate(el => el.remove());
      }
    }
    assert.deepEqual(run.errors, []);
  } finally {
    await writeFile(`${art}/geometry.json`, JSON.stringify({ simulated: true, physicalDeviceVerified: false, observations }, null, 2));
    await run.close();
  }
});
