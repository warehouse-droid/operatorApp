import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";
import { normalizeOperatorPreferences } from "../../../src/operator-preferences-policy.js";

const publicRoot = path.resolve("public");
const server = createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname;
  const target = path.resolve(publicRoot, name === "/operator" ? "operator.html" : name === "/driver" ? "driver.html" : name.slice(1));
  if (!target.startsWith(publicRoot + path.sep)) { response.writeHead(404).end(); return; }
  try {
    const data = await readFile(target);
    response.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(target)] || "application/octet-stream" }).end(data);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const saved = new Map();
const calls = [];
const failures = { get: false, put: false };
const errors = [];
const token = "preferences-browser-test";
const sessionKey = crypto.createHash("sha256").update(token).digest("hex");
const artifacts = process.env.DISPLAY_TEST_ARTIFACTS || "/tmp/operator-display-artifacts";
await mkdir(artifacts, { recursive: true });

async function session(account = "operator-a") {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 800 }, hasTouch: true });
  await context.addInitScript(({ account, token, sessionKey }) => {
    const activeAccount = localStorage.getItem("display-test-account") || account;
    localStorage.setItem("mbbs.staff.token", token);
    localStorage.setItem("mbbs.operator.token", token);
    localStorage.setItem("mbbs.operator.locationId", "1");
    localStorage.setItem("mbbs.ui.language", "zh-CN");
    localStorage.setItem("mbbs.operator.state", JSON.stringify({ accountId: activeAccount, sessionKey, locationId: 1, currentModule: "menu" }));
    window.EventSource = class { addEventListener() {} close() {} };
    window.testAccount = activeAccount;
  }, { account, token, sessionKey });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const actor = await page.evaluate(() => window.testAccount);
    let body = {};
    let status = 200;
    if (url.pathname === "/api/auth/me") body = { operator: { id: actor, display_name: "Test operator", role: "operator", roles: ["operator"], operatorYardLocationIds: [1] } };
    else if (url.pathname === "/api/operator/preferences") {
      if ((request.method() === "PUT" && failures.put) || (request.method() === "GET" && failures.get)) { status = 503; body = { error: "test unavailable" }; }
      else {
        if (request.method() === "PUT") saved.set(actor, normalizeOperatorPreferences(request.postDataJSON()));
        body = saved.get(actor) || normalizeOperatorPreferences();
      }
    } else if (url.pathname.endsWith("/notifications")) body = { total: 0, items: [], salesOrder: {}, transferOrder: {} };
    else if (url.pathname.endsWith("/current-draft")) body = null;
    else if (url.pathname === "/api/customer-pickup/lookup" || url.pathname === "/api/returns/orders/lookup") {
      calls.push({ path: url.pathname, body: request.postDataJSON() });
      await new Promise((resolve) => setTimeout(resolve, 80));
      status = 404; body = { error: "Test order not found" };
    }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(`${base}/operator`);
  await page.locator('[data-action="open-display-settings"]').waitFor();
  return { page, context };
}
async function openSettings(page) {
  const response = page.waitForResponse((r) => r.url().endsWith("/api/operator/preferences") && r.request().method() === "GET");
  await page.locator('[data-action="open-display-settings"]').click();
  await response;
  await page.locator("[data-style-row]").first().waitFor();
  await page.waitForFunction(() => document.querySelector(".display-settings-message")?.textContent !== "加载中");
}
const row = (page, area, role) => page.locator(`[data-style-row][data-area="${area}"][data-role="${role}"]`);
async function saveSettings(page) {
  const response = page.waitForResponse((r) => r.url().endsWith("/api/operator/preferences") && r.request().method() === "PUT");
  await page.locator('[data-display-settings-form] button[type="submit"]').click();
  await response;
  await page.waitForFunction(() => document.querySelector(".display-settings-message")?.textContent.includes("设置已保存"));
}
async function previewOrder(page) {
  await page.evaluate(() => {
    currentModule = "customer-pickup";
    const line = { id: "line-a", item_id: "item-a", item_type: "InvtPart", sku: "ITEM-A", item_name: "ITEM-A", item_description: "测试商品说明，一段较长的商品描述", unit: "PCS", quantity: 20, piece_qty: 20, to_pcs: 1, packed_piece_qty: 0, loaded_qty: 0 };
    selectedOrder = { netsuite_id: "order-a", tranid: "SOB001234", customer: "Test", operator_status: "open", lines: [line] };
    selectedId = "order-a"; selectedLineId = "line-a"; compactLineMode = false; render();
  });
}
async function assertSingleRowTopbar(page) {
  const layout = await page.locator(".topbar").evaluate((bar) => {
    const bounds = bar.getBoundingClientRect();
    const toggle = bar.querySelector(".topbar-language");
    const language = toggle.getBoundingClientRect();
    const start = bar.querySelector(".topbar-start").getBoundingClientRect();
    const actions = bar.querySelector(".topbar-actions").getBoundingClientRect();
    return {
      rows: getComputedStyle(bar).gridTemplateRows.split(" ").length,
      languagePosition: getComputedStyle(toggle).position,
      centerOffset: Math.abs(language.x + language.width / 2 - bounds.x - bounds.width / 2),
      verticalOffset: Math.abs(language.y + language.height / 2 - bounds.y - bounds.height / 2),
      leftClear: start.right <= language.left,
      rightClear: actions.left >= language.right,
      sameRow: Math.abs(start.y + start.height / 2 - actions.y - actions.height / 2) < 1,
      nowrap: getComputedStyle(bar.querySelector(".topbar-actions")).flexWrap,
      actionLabelsStayOnOneLine: [...bar.querySelector(".topbar-actions").children].every((child) => getComputedStyle(child).whiteSpace === "nowrap")
    };
  });
  assert.equal(layout.rows, 1, "Top bar must have exactly one row");
  assert.equal(layout.languagePosition, "absolute");
  assert.ok(layout.centerOffset < 1 && layout.verticalOffset < 1, "Language switch must stay centered");
  assert.ok(layout.leftClear && layout.rightClear && layout.sameRow, "Top-bar controls overlap or span multiple rows");
  assert.equal(layout.nowrap, "nowrap");
  assert.equal(layout.actionLabelsStayOnOneLine, true, "Top-bar button and status text must not wrap");
}

try {
  const { page, context } = await session();
  for (const [width, height] of [[1280, 800], [1024, 768], [768, 1024], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await assertSingleRowTopbar(page);
  }
  await openSettings(page);
  for (const [width, height] of [[1280, 800], [1024, 768], [768, 1024], [390, 844]]) {
    await page.setViewportSize({ width, height });
    for (const language of ["en", "zh-CN"]) {
      await page.locator(`.topbar-language [data-language="${language}"]`).click();
      await assertSingleRowTopbar(page);
      await page.locator('.topbar [data-pref-action="back"]').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('.topbar [data-pref-action="back"]').isVisible(), true);
    }
  }
  await row(page, "detail", "itemNames").locator("[data-pref-size]").fill("27");
  await page.locator('.topbar [data-pref-action="back"]').click();
  await page.locator('[data-action="open-display-settings"]').waitFor();
  assert.equal(saved.has("operator-a"), false, "Back must not save the draft");
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSettings(page);
  assert.equal(await row(page, "detail", "itemNames").locator("[data-pref-size]").inputValue(), "17");
  assert.equal(await page.locator("[data-style-row]").count(), 10);
  await row(page, "general", "itemNames").locator("[data-pref-size]").fill("23");
  await row(page, "general", "itemNames").locator("[data-pref-hex]").fill("#123456");
  await row(page, "detail", "itemNames").locator('[data-pref-step="1"]').click();
  assert.equal(await row(page, "detail", "itemNames").locator("[data-pref-size]").inputValue(), "24");
  await row(page, "detail", "itemNames").locator("[data-pref-size]").fill("31");
  await row(page, "detail", "itemNames").locator("[data-pref-hex]").fill("#234567");
  assert.deepEqual(await row(page, "detail", "itemNames").locator("[data-pref-demo]").evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).color]), ["31px", "rgb(35, 69, 103)"]);
  await page.locator('[data-pref-spacing="detail"]').selectOption("spacious");
  await page.screenshot({ path: path.join(artifacts, "settings.png"), fullPage: true });
  await saveSettings(page);
  await page.locator('[data-pref-action="cancel"]').click();
  await previewOrder(page);
  assert.deepEqual(await page.locator(".line-info>strong").first().evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).color]), ["31px", "rgb(35, 69, 103)"]);
  assert.match(await page.locator(".detail-panel").innerText(), /件/);
  for (const [width, height] of [[1280, 800], [1024, 768], [768, 1024], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await assertSingleRowTopbar(page);
    assert.ok(await page.locator(".detail-panel").evaluate((el) => el.scrollWidth <= el.clientWidth + 2), `detail horizontal overflow at ${width}`);
  }
  await page.screenshot({ path: path.join(artifacts, "detail-phone.png"), fullPage: true });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.locator('[data-action="main-menu"]').click();

  // A second device receives the saved account settings.
  const second = await session();
  await openSettings(second.page);
  assert.equal(await row(second.page, "detail", "itemNames").locator("[data-pref-size]").inputValue(), "31");
  await second.context.close();

  // Failed saves keep the editable draft; cancel leaves server settings intact.
  await openSettings(page);
  await row(page, "detail", "itemNames").locator("[data-pref-size]").fill("33");
  failures.put = true;
  await page.locator('[data-display-settings-form] button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector(".display-settings-message")?.textContent.includes("设置未保存"));
  assert.equal(await row(page, "detail", "itemNames").locator("[data-pref-size]").inputValue(), "33");
  assert.equal(saved.get("operator-a").styles.detail.itemNames.fontSizePx, 31);
  failures.put = false;
  await page.locator('[data-pref-action="cancel"]').click();

  // Largest allowed fonts must remain usable in either list mode and orientation.
  await openSettings(page);
  for (const size of await page.locator("[data-pref-size]").all()) await size.fill("48");
  await page.locator('[data-pref-spacing="general"]').selectOption("spacious");
  await saveSettings(page);
  await page.locator('[data-pref-action="cancel"]').click();
  await previewOrder(page);
  for (const [width, height] of [[1280, 800], [1024, 768], [768, 1024], [390, 844]]) {
    await page.setViewportSize({ width, height });
    for (const compact of [false, true]) {
      await page.evaluate((value) => { compactLineMode = value; render(); }, compact);
      await assertSingleRowTopbar(page);
      for (const selector of [".topbar", ".detail-panel", ".line-card"]) {
        assert.ok(await page.locator(selector).first().evaluate((el) => el.scrollWidth <= el.clientWidth + 2), `${selector} overflows at 48px/${width}/${compact}`);
      }
      assert.ok(await page.locator(".line-card .measure").first().evaluate((el) => el.clientWidth >= 240), `48px measurement is cramped at ${width}/${compact}`);
      await page.locator(".confirm-page-button").scrollIntoViewIfNeeded();
      assert.equal(await page.locator(".confirm-page-button").isVisible(), true);
    }
  }
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: path.join(artifacts, "detail-maximum.png"), fullPage: true });
  await page.locator('[data-action="main-menu"]').click();

  // Style reset preserves the device-keyboard choice, and removes all CSS overrides.
  await openSettings(page);
  await page.locator("[data-pref-keyboard]").check();
  await page.locator('[data-pref-action="reset"]').click();
  assert.equal(await page.locator("[data-pref-keyboard]").isChecked(), true);
  await saveSettings(page);
  assert.equal(await page.locator("#operator-account-styles").textContent(), "");
  await page.locator('[data-pref-action="cancel"]').click();
  await previewOrder(page);
  assert.equal(await page.locator(".line-info>strong").first().evaluate((el) => getComputedStyle(el).fontSize), "17px");
  await page.locator('[data-action="main-menu"]').click();
  await page.locator('[data-module="customer-pickup"]').click();
  assert.equal(await page.locator("#customerPickupScan").getAttribute("inputmode"), "text");
  await page.locator('[data-action="main-menu"]').click();
  await openSettings(page);
  await page.locator("[data-pref-keyboard]").uncheck();
  await saveSettings(page);
  await page.locator('[data-pref-action="cancel"]').click();
  await page.locator('[data-module="customer-pickup"]').click();
  const input = page.locator("#customerPickupScan");
  assert.equal(await input.getAttribute("inputmode"), "none");
  assert.equal(await input.getAttribute("readonly"), null);
  for (const key of ["SOB", "0", "0", "1", "2", "SOM", "back", "3"]) await page.locator(`[data-order-key="${key}"]`).click();
  assert.equal(await input.inputValue(), "SOM0013");
  await input.evaluate((el) => el.setSelectionRange(5, 7));
  await page.locator('[data-order-key="8"]').tap();
  assert.equal(await input.inputValue(), "SOM008");
  await page.locator('[data-order-key="clear"]').click();
  await input.focus();
  const beforePickup = calls.length;
  await page.keyboard.type("SOB000123");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".sync-alert.danger")?.textContent.includes("Test order not found"));
  assert.equal(calls.length, beforePickup + 1);
  assert.equal(calls.at(-1).body.code, "SOB000123");
  assert.equal(await input.getAttribute("inputmode"), "none");

  await page.evaluate(() => { resetReturnWorkflow("stock"); currentModule = "stock-return"; render(); });
  await assertSingleRowTopbar(page);
  const returnInput = page.locator("#returnOrderLookup");
  assert.equal(await returnInput.getAttribute("inputmode"), "none");
  await returnInput.focus();
  const beforeReturn = calls.length;
  await page.keyboard.type("SOB000124");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !returnBusy);
  assert.equal(calls.length, beforeReturn + 1);
  assert.equal(calls.at(-1).body.code, "SOB000124");
  await page.screenshot({ path: path.join(artifacts, "return-keypad.png"), fullPage: true });

  // Cached values are never shared between account identities.
  await page.evaluate(() => {
    const cached = OperatorDisplaySettings.normalize({ useDeviceKeyboard: true, styles: { detail: { itemNames: { fontSizePx: 41, color: "#654321" } } } });
    localStorage.setItem("mbbs.operator.preferences.operator-a", JSON.stringify(cached));
    localStorage.setItem("display-test-account", "operator-b");
  });
  failures.get = true;
  await page.reload();
  await page.locator('[data-action="open-display-settings"]').waitFor();
  await openSettings(page);
  assert.equal(await row(page, "detail", "itemNames").locator("[data-pref-size]").inputValue(), "17");
  assert.equal(await page.locator("[data-pref-keyboard]").isChecked(), false);
  failures.get = false;
  await context.close();

  const driverContext = await browser.newContext({ serviceWorkers: "block" });
  await driverContext.addInitScript(() => localStorage.setItem("mbbs.ui.language", "zh-CN"));
  const driver = await driverContext.newPage();
  await driver.route("**/api/**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: "{}" }));
  await driver.goto(`${base}/driver`);
  await driver.waitForFunction(() => typeof unitPills === "function");
  const pills = await driver.evaluate(() => unitPills(["PLT", "LYR", "SEC", "PCS", "SQFT", "PC"].map((unit) => ({ unit, value: 2 }))));
  for (const label of ["板", "层", "组", "件", "SQFT", "PC"]) assert.ok(pills.includes(`2 ${label}</span>`));
  await driverContext.close();
  assert.deepEqual(errors, []);
  console.log("PASS: settings, pixel/colour rendering, reset, account sync/isolation, failure recovery, keypad/scanner events, responsive layouts, and driver units.");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
