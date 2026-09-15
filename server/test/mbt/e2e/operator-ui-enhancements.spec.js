import { expect, test } from "./mbt-e2e-test.js";
import { seedOperatorPickup } from "../../support/operator-ui-enhancements-fixture.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import crypto from "node:crypto";

/* global localStorage, window */

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "chromium" && process.env.OPERATOR_UI_COVERAGE === "1") {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
  }
});

test.afterEach(async ({ page, browserName }) => {
  if (browserName !== "chromium" || process.env.OPERATOR_UI_COVERAGE !== "1") {
    return;
  }
  const entries = await page.coverage.stopJSCoverage();
  const result = entries.filter((entry) => new URL(entry.url).pathname === "/operator.js")
    .map((entry) => ({ scriptId: entry.scriptId, url: "file:///app/public/operator.js", functions: entry.functions }));
  const directory = "test-artifacts/operator-ui-enhancements/coverage-tmp";
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/coverage-browser-${crypto.randomUUID()}.json`, JSON.stringify({ result }));
});

async function session(page, state, token = "operator-ui-browser-test", language = "en", accountId = "ui-operator") {
  await page.addInitScript(({ restored, auth, lang, accountId, sessionKey }) => {
    window.EventSource = class {
      addEventListener() {}
      close() {}
    };
    localStorage.setItem("mbbs.staff.token", auth);
    localStorage.setItem("mbbs.operator.token", auth);
    localStorage.setItem("mbbs.operator.locationId", "1");
    localStorage.setItem("mbbs.ui.language", lang);
    localStorage.setItem("mbbs.operator.state", JSON.stringify({ locationId: 1, ...restored, accountId, sessionKey }));
  }, { restored: state, auth: token, lang: language, accountId, sessionKey: crypto.createHash("sha256").update(token).digest("hex") });
}

const json = (route, value) => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });

async function receivingApi(page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const responses = {
      "/api/auth/me": { operator: { id: "ui-operator", display_name: "UI Test", role: "operator", roles: ["operator"], operatorYardLocationIds: [1] } },
      "/api/delivery/notifications": { total: 0, salesOrder: {}, transferOrder: {}, items: [] },
      "/api/delivery/current-draft": null,
      "/api/receiving/vendors": [],
      "/api/receiving/sources": [],
      "/api/receiving/orders": [],
      "/api/receiving/items": [],
      "/api/inventory/facets": { productTypes: [], brands: [], series: [] },
      "/api/cycle-count/draft": { lines: [] }
    };
    if (Object.hasOwn(responses, url.pathname)) {
      return json(route, responses[url.pathname]);
    }
    return route.fulfill({ status: 404, body: `Unexpected test request ${url.pathname}` });
  });
}

for (const moduleName of ["receiving", "cycle-count"]) {
  test(`${moduleName} has one Menu in the right header at desktop, tablet and phone widths`, async ({ page }) => {
    await receivingApi(page);
    await session(page, { currentModule: moduleName });
    await page.goto("/operator");
    const menu = page.locator('.topbar-actions [data-action="main-menu"]');
    await expect(menu).toHaveCount(1);
    await expect(page.locator('[data-action="main-menu"]')).toHaveCount(1);
    for (const width of [1280, 820, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const box = await menu.boundingBox();
      expect(box.x).toBeGreaterThan(width / 2);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y).toBeLessThan(180);
    }
    await menu.click();
    await expect(page.locator('[data-action="open-module"][data-module="receiving"]')).toBeVisible();
  });
}

for (const id of ["receivingSearch", "receivingItemSearch"]) {
  test(`${id} keeps its input, focus and selection while results refresh`, async ({ page }) => {
    await receivingApi(page);
    await session(page, { currentModule: "receiving" });
    await page.goto("/operator");
    const input = page.locator(`#${id}`);
    const results = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/receiving/orders");
    const original = await input.elementHandle();
    await input.fill("PO1234");
    await input.evaluate((element) => element.setSelectionRange(2, 4));
    await results;
    await expect(page.locator(".receiving-grid")).toBeVisible();
    expect(await original.evaluate((element) => element.isConnected)).toBe(true);
    await expect(input).toBeFocused();
    expect(await input.evaluate((element) => [element.selectionStart, element.selectionEnd])).toEqual([2, 4]);
    await page.keyboard.insertText("X");
    await expect(input).toHaveValue("POX34");
    await input.fill("");
    await expect(input).toBeFocused();
  });
}

test("older receiving results cannot replace a newer search or restore focus after navigation", async ({ page }) => {
  await receivingApi(page);
  await session(page, { currentModule: "receiving" });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/receiving/orders?**", async (route) => {
    const search = new URL(route.request().url()).searchParams.get("search");
    if (search === "OLD") {
      await pending;
    }
    return json(route, [{ netsuite_id: search, tranid: `${search}-RESULT`, order_type: "purchase_order", lines: [] }]);
  });
  await page.route("**/api/receiving/orders/*", (route) => json(route, { netsuite_id: new URL(route.request().url()).pathname.split("/").at(-1), lines: [] }));
  await page.goto("/operator");
  const input = page.locator("#receivingSearch");
  await input.fill("OLD");
  await page.waitForRequest((request) => request.url().includes("search=OLD"));
  await input.fill("NEW");
  await expect(page.locator(".order-card")).toContainText("NEW-RESULT");
  const response = page.waitForResponse((item) => item.url().includes("search=OLD"));
  release();
  await response;
  await expect(page.locator(".order-card")).toContainText("NEW-RESULT");
  await input.fill("PENDING");
  await page.locator('.topbar [data-action="main-menu"]').click();
  await expect(page.locator("#receivingSearch")).toHaveCount(0);
  await expect(page.locator('[data-action="open-module"][data-module="receiving"]')).toBeVisible();
});

test("saved pickup draft displays confirmed and remaining independently of Delivery view mode", async ({ page }) => {
  await receivingApi(page);
  await page.route("**/api/delivery/orders/998899", (route) => json(route, {
    netsuite_id: "998899", tranid: "PICKUP-UI-SAVED", delivery_method: "Pick-Up",
    lines: [{ id: "ui-line", sku: "ITEM-A", item_type: "InvtPart", quantity: 20,
      piece_qty: 20, to_pcs: 1, packed_piece_qty: 5, confirmed: true, loaded_qty: 0 }]
  }));
  await session(page, { currentModule: "customer-pickup", selectedId: "998899", viewMode: "packed" });
  await page.goto("/operator");
  const card = page.locator('.line-card[data-line="ui-line"]');
  await expect(card).toHaveClass(/confirmed/u);
  await expect(card).not.toHaveClass(/underpacked/u);
  await expect(card.locator(".confirmed-measure b")).toHaveText("5");
  await expect(card.locator(".remaining-measure b")).toHaveText("15");
  await expect(card).toContainText("can still adjust before Loaded");
  await expect(page.locator('[data-action="confirm-line"]')).toBeVisible();
});

for (const failedDetail of [false, true]) {
  test(`receiving ignores a late ${failedDetail ? "failed" : "successful"} detail after clearing and preserves focus on the other field`, async ({ page }) => {
    await receivingApi(page);
    await session(page, { currentModule: "receiving" });
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/receiving/orders?**", (route) => json(route, [{ netsuite_id: "LATE", tranid: "LATE-ORDER", order_type: "purchase_order" }]));
    await page.route("**/api/receiving/orders/LATE?**", async (route) => {
      await pending;
      if (failedDetail) {
        return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"outdated detail error"}' });
      }
      return json(route, { netsuite_id: "LATE", tranid: "LATE-ORDER", lines: [] });
    });
    await page.goto("/operator");
    const started = page.waitForRequest((request) => request.url().includes("/orders/LATE?"));
    await page.locator("#receivingSearch").fill("LATE");
    await started;
    await page.locator("#receivingSearch").fill("");
    await page.locator("#receivingSearch").press("Enter");
    await page.locator("#receivingItemSearch").focus();
    const completed = page.waitForResponse((response) => response.url().includes("/orders/LATE?"));
    release();
    await completed;
    await expect(page.locator(".receiving-grid")).toHaveCount(0);
    await expect(page.locator("#receivingItemSearch")).toBeFocused();
    await expect(page.locator("#toast")).not.toContainText("outdated detail error");
  });
}

test("receiving search errors keep the input focused and allow the next search", async ({ page }) => {
  await receivingApi(page);
  await session(page, { currentModule: "receiving" });
  await page.route("**/api/receiving/orders?**", async (route) => {
    const search = new URL(route.request().url()).searchParams.get("itemSearch");
    if (search === "ORDER-ERROR") {
      return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"order search failed"}' });
    }
    return json(route, search === "DETAIL-ERROR" ? [{ netsuite_id: "ERROR", tranid: "ERROR", order_type: "purchase_order" }] : []);
  });
  await page.route("**/api/receiving/orders/ERROR?**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"order detail failed"}' }));
  await page.route("**/api/receiving/items?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("search") === "ITEM-ERROR") {
      return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"product search failed"}' });
    }
    return json(route, []);
  });
  await page.goto("/operator");
  const input = page.locator("#receivingItemSearch");
  const original = await input.elementHandle();
  for (const [search, message] of [["ORDER-ERROR", "order search failed"], ["DETAIL-ERROR", "order detail failed"], ["ITEM-ERROR", "product search failed"]]) {
    await input.fill(search);
    await input.press("Enter");
    await expect(page.locator("#toast")).toContainText(message);
    await expect(input).toBeFocused();
    expect(await original.evaluate((element) => element.isConnected)).toBe(true);
  }
  await input.fill("RECOVERED");
  const recovered = page.waitForResponse((response) => response.url().includes("itemSearch=RECOVERED"));
  await input.press("Enter");
  expect((await recovered).ok()).toBe(true);
  await expect(page.locator(".receiving-grid")).toBeVisible();
  await expect(input).toBeFocused();
});

test("receiving vendor, source, keypad and language navigation retain a single header Menu", async ({ page }) => {
  await receivingApi(page);
  await session(page, { currentModule: "receiving" });
  await page.route("**/api/receiving/vendors?**", (route) => json(route, [{ vendor: "UI Vendor", order_count: 1 }]));
  await page.route("**/api/receiving/sources?**", (route) => json(route, [{ source_location_id: 28, source_location: "2967", order_count: 1 }]));
  await page.goto("/operator");
  await page.locator('[data-action="select-receiving-type"][data-order-type="purchase_order"]').click();
  await page.locator('[data-action="select-receiving-vendor"]').click();
  await expect(page.locator(".panel-title")).toContainText("UI Vendor");
  await page.locator('[data-action="receiving-key"][data-key="1"]').click();
  await expect(page.locator("#receivingSearch")).toHaveValue("1");
  await page.locator('[data-action="receiving-back"]').click();
  await expect(page.locator("#receivingSearch")).toHaveValue("");
  await page.locator('[data-action="select-receiving-type"][data-order-type="transfer_order"]').click();
  await page.locator('[data-action="select-receiving-source"]').click();
  await expect(page.locator(".panel-title")).toContainText("From 2967");
  await page.locator('[data-action="receiving-back"]').click();
  await expect(page.locator('[data-action="select-receiving-source"]')).toBeVisible();
  await page.locator('[data-action="receiving-back"]').click();
  await page.locator('[data-action="set-language"][data-language="zh-CN"]').click();
  await expect(page.locator('label.receiving-search').first()).toContainText("搜索");
  await expect(page.locator('[data-action="main-menu"]')).toHaveCount(1);
  await expect(page.locator('.topbar-actions [data-action="main-menu"]')).toBeVisible();
});

test("receiving ignores outdated product suggestions and search errors", async ({ page }) => {
  await receivingApi(page);
  await session(page, { currentModule: "receiving" });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/receiving/items?**", async (route) => {
    const search = new URL(route.request().url()).searchParams.get("search");
    if (search === "OLD") {
      await pending;
    }
    return json(route, [{ item_name: `${search} item`, order_count: 1 }]);
  });
  await page.route("**/api/receiving/orders?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("itemSearch") === "OLD") {
      await pending;
      return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"outdated search error"}' });
    }
    return json(route, []);
  });
  await page.goto("/operator");
  const started = page.waitForRequest((request) => request.url().includes("/items?") && request.url().includes("search=OLD"));
  await page.locator("#receivingItemSearch").fill("OLD");
  await started;
  await page.locator("#receivingItemSearch").fill("NEW");
  await expect(page.locator(".autocomplete-dropdown")).toContainText("NEW item");
  const completed = page.waitForResponse((response) => response.url().includes("/items?") && response.url().includes("search=OLD"));
  release();
  await completed;
  await expect(page.locator(".autocomplete-dropdown")).not.toContainText("OLD item");
  await expect(page.locator("#toast")).not.toContainText("outdated search error");
  await page.locator('[data-action="receiving-pick-item"]').click();
  await expect(page.locator("#receivingItemSearch")).toHaveValue("NEW item");
});

async function pickup(page, { language = "en", viewMode = "active" } = {}) {
  const f = await seedOperatorPickup();
  await session(page, { currentModule: "customer-pickup", selectedId: f.orderId, selectedLineId: f.lineId, viewMode }, f.token, language, f.operator.id);
  await page.goto("/operator");
  await expect(page.locator(`[data-selected-line="${f.lineId}"]`)).toBeVisible();
  return f;
}

async function setQuantity(page, value) {
  const input = page.locator('[data-pack="pieces"]');
  const current = Number(await input.inputValue());
  const direction = value > current ? "1" : "-1";
  for (let n = 0; n < Math.abs(value - current); n += 1) {
    await page.locator(`[data-action="step-qty"][data-unit="pieces"][data-delta="${direction}"]`).click();
  }
}

async function confirmLine(page) {
  const response = page.waitForResponse((item) => /\/lines\/[^/]+\/confirm$/u.test(new URL(item.url()).pathname));
  await page.locator('[data-action="confirm-line"]').click();
  expect((await response).ok()).toBe(true);
}

test("pickup confirmation displays the saved total, edits absolutely, and survives reload and loading", async ({ page }, testInfo) => {
  const f = await pickup(page);
  await setQuantity(page, 5);
  await confirmLine(page);
  const card = page.locator(`.line-card[data-line="${f.lineId}"]`);
  await expect(card).toHaveClass(/confirmed/u);
  await expect(card).toContainText("Confirmed");
  await expect(card).toContainText("can still adjust before Loaded");
  await expect(card.locator(".confirmed-measure b")).toHaveText("5");
  await expect(card.locator(".remaining-measure b")).toHaveText("15");
  await expect(page.locator('[data-pack="pieces"]')).toHaveValue("5");
  await card.screenshot({ path: `test-artifacts/operator-ui-enhancements/pickup-${testInfo.project.name}.png` });
  await confirmLine(page);
  await expect(card.locator(".confirmed-measure b")).toHaveText("5");
  await setQuantity(page, 7);
  await confirmLine(page);
  await expect(card.locator(".confirmed-measure b")).toHaveText("7");
  await expect(card.locator(".remaining-measure b")).toHaveText("13");
  await page.reload();
  await expect(page.locator('[data-pack="pieces"]')).toHaveValue("7");
  await page.locator('[data-action="start-fulfill"]').click();
  await expect(page.locator(".fulfillment-lines")).toContainText("7 PCS");
  await page.locator('[data-action="cancel-fulfill"]').click();
  await expect(card.locator(".confirmed-measure b")).toHaveText("7");
  const headers = { authorization: `Bearer ${f.token}` };
  const loaded = await page.request.post(`/api/customer-pickup/orders/${f.orderId}/load`, {
    headers, data: { locationId: 1, photoDataUrls: ["data:image/png;base64,dGVzdA=="] }
  });
  expect(await loaded.text()).not.toContain('"error"');
  expect(loaded.ok()).toBe(true);
  await page.reload();
  await expect(page.locator('[data-pack="pieces"]')).toHaveValue("13");
  await expect(card).not.toHaveClass(/confirmed/u);
});

test("pickup page confirmation can clear a confirmed line even with saved Delivery packed view", async ({ page }) => {
  const f = await pickup(page, { viewMode: "packed" });
  await setQuantity(page, 5);
  await confirmLine(page);
  await expect(page.locator('[data-pack="pieces"]')).toHaveValue("5");
  const response = page.waitForResponse((item) => item.url().endsWith("/lines/confirm-page"));
  await setQuantity(page, 0);
  await page.locator('[data-action="confirm-page"]').click();
  expect((await response).ok()).toBe(true);
  await expect(page.locator(`.line-card[data-line="${f.lineId}"]`)).not.toHaveClass(/confirmed/u);
  await expect(page.locator('[data-action="start-fulfill"]')).toBeDisabled();
});

test("pickup page reconfirmation and the load summary preserve confirmed and remaining quantities", async ({ page }) => {
  const f = await pickup(page);
  await setQuantity(page, 5);
  await confirmLine(page);
  const response = page.waitForResponse((item) => item.url().endsWith("/lines/confirm-page"));
  await page.locator('[data-action="confirm-page"]').click();
  expect((await response).ok()).toBe(true);
  await expect(page.locator(`.line-card[data-line="${f.lineId}"] .confirmed-measure b`)).toHaveText("5");
  await page.locator('[data-action="start-fulfill"]').click();
  const summary = page.locator(".fulfillment-lines");
  await expect(summary.locator("span")).toHaveText("5 PCS");
  await expect(summary.locator("small")).toHaveText("Remaining 15 PCS");
  await page.locator('[data-action="cancel-fulfill"]').click();
  await expect(page.locator('[data-pack="pieces"]')).toHaveValue("5");
});

test("pickup confirmed and remaining labels are translated in compact mode", async ({ page }) => {
  const f = await pickup(page, { language: "zh-CN" });
  await setQuantity(page, 5);
  await confirmLine(page);
  const card = page.locator(`.line-card[data-line="${f.lineId}"]`);
  await expect(card).toContainText("已确认");
  await expect(card).toContainText("剩余");
  await expect(card).toContainText("装载前仍可调整");
  await page.locator('[data-action="set-line-density"][data-density="compact"]').click();
  await expect(card.locator(".confirmed-measure b")).toHaveText("5");
  await expect(card.locator(".remaining-measure b")).toHaveText("15");
});

test("pickup HTTP confirmation keeps legacy addition, rejects unknown modes, and repeats absolute totals safely", async ({ page }) => {
  const f = await seedOperatorPickup();
  const headers = { authorization: `Bearer ${f.token}` };
  const path = `/api/customer-pickup/orders/${f.orderId}/lines/${f.lineId}/confirm`;
  for (const pieces of [5, 2]) {
    expect((await page.request.post(path, { headers, data: { pieces } })).ok()).toBe(true);
  }
  const invalid = await page.request.post(path, { headers, data: { pieces: 9, quantityMode: "invalid" } });
  expect(invalid.status()).toBe(400);
  const duplicate = await Promise.all([1, 2].map(() => page.request.post(path, { headers, data: { pieces: 7, quantityMode: "absolute" } })));
  for (const response of duplicate) {
    expect(response.ok()).toBe(true);
    const order = await response.json();
    expect(Number(order.lines[0].packed_piece_qty)).toBe(7);
  }
});

test("pickup blocks overlapping confirmations and preserves the draft after a failed save", async ({ page }) => {
  const f = await pickup(page);
  await setQuantity(page, 5);
  await confirmLine(page);
  await setQuantity(page, 7);
  let release;
  let requests = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.route("**/lines/*/confirm", async (route) => {
    requests += 1;
    await pending;
    return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"test save failed"}' });
  });
  const button = page.locator('[data-action="confirm-line"]');
  await button.dispatchEvent("click");
  await expect(button).toBeDisabled();
  await button.dispatchEvent("click");
  await expect(page.locator('[data-action="confirm-page"]')).toBeDisabled();
  await expect(page.locator('[data-action="start-fulfill"]')).toBeDisabled();
  for (const action of ["main-menu", "customer-pickup-back"]) {
    await page.locator(`[data-action="${action}"]`).click();
    await expect(page.locator("#toast")).toContainText("Confirming");
    await expect(page.locator('[data-pack="pieces"]')).toHaveValue("7");
  }
  release();
  await expect(page.locator("#toast")).toContainText("test save failed");
  await expect(button).toBeEnabled();
  expect(requests).toBe(1);
  const card = page.locator(`.line-card[data-line="${f.lineId}"]`);
  await expect(card.locator(".confirmed-measure b")).toHaveText("5");
  await expect(card.locator(".remaining-measure b")).toHaveText("15");
});
