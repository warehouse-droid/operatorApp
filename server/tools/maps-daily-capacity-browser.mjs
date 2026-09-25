import assert from "node:assert/strict";
import crypto from "node:crypto";
import { chromium } from "@playwright/test";
import { createOperator } from "../src/auth-repository.js";
import { config } from "../src/config.js";
import { closeDb, query } from "../src/db.js";
import { googleMapsUsageRepository } from "../src/google-maps-service.js";
import { app } from "../src/server.js";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
config.googleMaps.mode = "normal";
await query("DELETE FROM google_maps_usage_ledger");
await query("DELETE FROM google_maps_daily_reopens");
await googleMapsUsageRepository.admit({ subsystem: "dynamic_map", units: 100, mode: "normal", reason: "browser_page_load" });
await googleMapsUsageRepository.admit({ subsystem: "driver_geocode", units: 50, mode: "normal", reason: "driver_location_check" });
const username = `maps-browser-${crypto.randomUUID()}`;
const password = crypto.randomUUID();
await createOperator({ username, displayName: "Maps test admin", password, role: "admin", roles: ["admin"] });
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password })
  });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addInitScript((value) => {
    localStorage.setItem("mbbs.staff.token", value);
    localStorage.setItem("mbbs.staff.role", "admin");
    localStorage.setItem("mbbs.staff.roles", '["admin"]');
  }, token);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.request().url().startsWith(baseUrl) ? route.continue() : route.abort());
  await page.goto(`${baseUrl}/admin/maps-usage`);
  await page.waitForFunction(() => document.querySelector(".maps-usage-metrics")?.textContent.includes("150 / 150"));
  const button = page.locator('[data-action="reopen-maps-daily-capacity"]');
  assert.equal(await button.isEnabled(), true);
  await page.screenshot({ path: "test-artifacts/maps-daily-capacity/desktop-before.png", fullPage: true });
  await button.click();
  await page.waitForFunction(() => document.querySelector(".maps-usage-metrics")?.textContent.includes("150 / 300"));
  assert.equal(await page.locator('[data-action="reopen-maps-daily-capacity"]').isDisabled(), true);
  assert.equal((await googleMapsUsageRepository.summary()).rolling30Day, 150);
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".maps-usage-metrics")?.textContent.includes("150 / 300"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".maps-usage-metrics")?.textContent.includes("150 / 300"));
  await page.screenshot({ path: "test-artifacts/maps-daily-capacity/mobile-after.png", fullPage: true });
  const overflow = await page.evaluate(() => ({
    width: window.innerWidth, page: document.documentElement.scrollWidth,
    elements: [...document.querySelectorAll("body *")].filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 12).map((element) => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right }))
  }));
  console.log(JSON.stringify({ mobileLayout: overflow }));
  assert.equal(overflow.page <= overflow.width, true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ desktop: "passed", mobile: "passed", reopened: "150 to 300", reloadPreserved: true, googleRequests: 0 }));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await closeDb();
}
