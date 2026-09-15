import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import test, { before, after } from "node:test";
import { chromium } from "playwright";

let browser, server, base;
before(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  server = createServer(async (req, res) => {
    const name = new URL(req.url, "http://test").pathname;
    const file = name === "/operator" ? "operator.html" : name === "/admin" ? "admin.html" : name.slice(1);
    if (!/^[a-zA-Z0-9./_-]+$/.test(file) || file.includes("..")) return res.writeHead(404).end();
    try {
      const bytes = await readFile(path.resolve("public", file));
      res.writeHead(200, { "content-type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(file)] || "application/octet-stream" }).end(bytes);
    } catch { res.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await browser?.close(); if (server) await new Promise((resolve) => server.close(resolve)); });

async function fixture(grants, run, { language = "en", role = "operator", restored } = {}) {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  const state = { account: { id: "yard-browser-a", display_name: "Yard Operator A", role, roles: [role], yardLocationIds: [1, 28, 15, 26], operatorYardLocationIds: grants }, token: "test-login-one", calls: [], delay: null };
  await page.addInitScript(({ lang }) => {
    window.EventSource = class {
      constructor() { window.yardTestEvents = this; this.listeners = {}; }
      addEventListener(name, callback) { this.listeners[name] = callback; }
      close() {}
    };
    if (!sessionStorage.getItem("yard-test-initialized")) {
      localStorage.setItem("mbbs.staff.token", "test-login-one");
      localStorage.setItem("mbbs.ui.language", lang);
      sessionStorage.setItem("yard-test-initialized", "1");
    }
  }, { lang: language });
  if (restored) await page.addInitScript((value) => {
    if (!sessionStorage.getItem("yard-test-restored")) {
      localStorage.setItem("mbbs.operator.state", JSON.stringify(value));
      sessionStorage.setItem("yard-test-restored", "1");
    }
  }, restored);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    state.calls.push(url.pathname + url.search);
    let response = [];
    if (url.pathname === "/api/auth/me" || url.pathname === "/api/auth/login") response = { operator: state.account, token: state.token };
    else if (url.pathname === "/api/auth/bootstrap-needed") response = { needed: false };
    else if (url.pathname === "/api/auth/logout") response = { ok: true };
    else if (url.pathname === "/api/delivery/notifications") response = { total: 0, salesOrder: {}, transferOrder: {}, items: [] };
    else if (url.pathname === "/api/delivery/current-draft") response = null;
    else if (url.pathname === "/api/delivery/bootstrap") response = { activeOrders: [], packedOrders: [], notifications: { total: 0, items: [] }, currentDraft: null, requests: [], savedOrderKeys: [] };
    else if (url.pathname === "/api/returns/reasons") response = { reasons: [], yardSettings: [] };
    if (state.delay && url.pathname === "/api/receiving/orders") response = await state.delay;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(response) }).catch(() => {});
  });
  const coverageEnabled = process.env.OPERATOR_YARD_COVERAGE === "1";
  let profiler;
  const coverageErrors = [];
  async function collectCoverage() {
    const coverage = await profiler.send("Profiler.takePreciseCoverage");
    const result = coverage.result.filter((entry) => {
      try { return ["/operator.js", "/control.js", "/i18n.js"].includes(new URL(entry.url).pathname); } catch { return false; }
    }).map((entry) => ({ ...entry, url: `file:///app/public${new URL(entry.url).pathname}` }));
    const directory = "test-artifacts/operator-yard-access/coverage-tmp";
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/coverage-browser-${crypto.randomUUID()}.json`, JSON.stringify({ result }));
  }
  if (coverageEnabled) {
    profiler = await context.newCDPSession(page);
    await profiler.send("Profiler.enable");
    await profiler.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    await profiler.send("Debugger.enable");
    const source = await readFile("public/operator.js", "utf8");
    const reloadLine = source.slice(0, source.indexOf("  window.location.reload();", source.indexOf("function reloadOperatorWorkspace"))).split("\n").length - 1;
    await profiler.send("Debugger.setBreakpointByUrl", { lineNumber: reloadLine, urlRegex: "operator\\.js(?:\\?|$)" });
    // Capture reload/logout before the old V8 context disappears. Normal browser
    // verification also runs without this coverage-only debugger checkpoint.
    profiler.on("Debugger.paused", async () => {
      try { await collectCoverage(); } catch (error) { coverageErrors.push(error.message); }
      finally { await profiler.send("Debugger.resume").catch(() => {}); }
    });
  }
  state.captureCoverage = coverageEnabled ? collectCoverage : async () => {};
  try { await page.goto(`${base}/operator`); await run(page, state); }
  finally {
    if (coverageEnabled) {
      await collectCoverage();
      await profiler.detach();
      assert.deepEqual(coverageErrors, []);
    }
    await context.close();
  }
}
const menu = (page) => page.locator('[data-action="open-module"][data-module="delivery"]').waitFor({ timeout: 6000 });

test("zero grants shows no-access, logout, and no operational requests", async () => {
  await fixture([], async (page, state) => {
    await page.getByText("No Operator yard access assigned. Contact an administrator.", { exact: true }).waitFor({ timeout: 5000 });
    assert.equal(await page.locator('[data-action="logout"]').count(), 1);
    await page.evaluate(() => window.yardTestEvents.listeners["app-event"]({ data: JSON.stringify({ type: "delivery.order.updated", payload: {} }) }));
    await page.waitForLoadState("networkidle");
    assert.equal(state.calls.some((call) => /^\/api\/(delivery|receiving|returns)\//.test(call)), false);
  });
});

test("one grant opens its menu directly and offers no other yard", async () => {
  await fixture([28], async (page) => {
    await menu(page);
    assert.match(await page.locator(".topbar-location").innerText(), /2967/);
    assert.equal(await page.locator('[data-action="toggle-location-dropdown"]').isDisabled(), true);
    assert.equal(await page.locator("#locationSelect").count(), 0);
  });
});

test("multiple grants choose each login, persist during reload, and discard another account's saved order", async () => {
  await fixture([28, 26], async (page, state) => {
    await page.locator("#locationSelect").waitFor();
    assert.deepEqual(await page.locator("#locationSelect option").evaluateAll((options) => options.map((option) => option.value)), ["28", "26"]);
    await page.selectOption("#locationSelect", "26");
    await page.locator('[data-action="save-location"]').click();
    await menu(page);
    await page.reload();
    await menu(page);
    assert.match(await page.locator(".topbar-location").innerText(), /150/);
    await page.locator('[data-action="logout"]').click();
    await page.locator("#loginUsername").waitFor();
    state.token = "test-login-two";
    await page.locator("#loginUsername").fill("same-account");
    await page.locator("#loginPassword").fill("test-password");
    await page.locator('[data-form="login"] button[type="submit"]').click();
    await page.locator("#locationSelect").waitFor({ timeout: 6000 });
    assert.equal(state.calls.some((call) => call.includes("PRIVATE-OLD-ORDER")), false);
  }, { restored: { accountId: "another-account", sessionKey: "another-login", locationId: 1, currentModule: "customer-pickup", selectedId: "PRIVATE-OLD-ORDER" } });
});

test("authorized yard switch resets operational selections and survives reload", async () => {
  await fixture([1, 28], async (page) => {
    await page.locator("#locationSelect").waitFor();
    await page.locator('[data-action="save-location"]').click();
    await menu(page);
    await page.locator('[data-action="toggle-location-dropdown"]').click();
    assert.deepEqual(await page.locator(".location-dropdown button").evaluateAll((buttons) => buttons.map((button) => button.dataset.locationId)), ["1", "28"]);
    await page.locator('[data-action="set-location-dropdown"][data-location-id="28"]').click();
    await menu(page);
    assert.match(await page.locator(".topbar-location").innerText(), /2967/);
    await page.reload();
    await menu(page);
    assert.match(await page.locator(".topbar-location").innerText(), /2967/);
  });
});

test("permission revocation on focus removes inaccessible data and yard selection", async () => {
  await fixture([1], async (page, state) => {
    await menu(page);
    state.account = { ...state.account, operatorYardLocationIds: [] };
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByText("No Operator yard access assigned. Contact an administrator.", { exact: true }).waitFor({ timeout: 6000 });
    assert.equal(await page.locator(".module-menu").count(), 0);
  });
});

test("admin retains all four yard choices", async () => {
  await fixture([], async (page) => {
    await page.locator("#locationSelect").waitFor();
    assert.deepEqual(await page.locator("#locationSelect option").evaluateAll((options) => options.map((option) => option.value)), ["1", "28", "15", "26"]);
  }, { role: "admin" });
});

for (const language of ["en", "zh-CN"]) {
  test(`Delivery Active/Packed fill the panel, match Batch/Saved sizing and preserve filters (${language})`, async () => {
    await fixture([1], async (page) => {
      await menu(page);
      await page.evaluate(() => { currentModule = "delivery"; render(); });
      const active = await page.locator('[data-action="view-active"]').boundingBox();
      const packed = await page.locator('[data-action="view-packed"]').boundingBox();
      const batch = await page.locator('.delivery-mode-segment button').first().boundingBox();
      const saved = await page.locator('.delivery-mode-segment button').last().boundingBox();
      assert.ok(Math.abs(active.width - batch.width) < 2, `Active ${active.width}, Batch ${batch.width}`);
      assert.ok(Math.abs(packed.width - saved.width) < 2);
      assert.equal(active.height, batch.height);
      assert.equal(await page.locator(".order-panel-heading-actions > strong").count(), 0);
      assert.equal(await page.locator(".batch-segment b").count(), 4);
      await page.locator('[data-action="view-packed"]').click();
      await page.locator('[data-action="view-packed"].active').waitFor();
      assert.match(await page.locator('[data-action="view-packed"]').getAttribute("class"), /active/);
    }, { language, restored: { locationId: 1, currentModule: "menu" } });
  });
}

test("pallet balance editor shows only 60 available and keeps lookup status and quantity controls", async () => {
  await fixture([1], async (page) => {
    await menu(page);
    const html = await page.evaluate(() => {
      returnMode = "pallet";
      returnPalletBalance = { fulfilled: 100, netsuiteReturned: 30, localReserved: 10, available: 60, lookedUpAt: "2026-09-15T00:00:00Z" };
      return renderReturnPalletEditor();
    });
    await page.locator("#app").evaluate((element, value) => { element.innerHTML = value; }, html);
    assert.equal(await page.locator(".return-balance-grid > div").count(), 1);
    assert.match(await page.locator(".return-balance-grid").innerText(), /Available to return[\s\S]*60 PALLET/);
    assert.doesNotMatch(await page.locator(".return-balance-grid").innerText(), /Fulfilled|NetSuite returned|Local reserved/);
    assert.equal(await page.locator(".return-lookup-time").count(), 1);
    assert.equal(await page.locator('[data-action="return-step-quantity"]').count(), 2);
  }, { restored: { locationId: 1, currentModule: "menu" } });
});

test("another account's login discards a delayed receiving response and opens only its assigned yard", async () => {
  await fixture([1], async (page, state) => {
    await menu(page);
    let release;
    state.delay = new Promise((resolve) => { release = resolve; });
    await page.locator('[data-action="open-module"][data-module="receiving"]').click();
    const pendingOrder = page.waitForRequest((request) => request.url().includes("/api/receiving/orders"));
    await page.locator("#receivingSearch").fill("OLD");
    await pendingOrder;
    state.account = { ...state.account, id: "yard-browser-b", operatorYardLocationIds: [28] };
    state.token = "test-login-b";
    await page.evaluate(() => {
      localStorage.setItem("mbbs.staff.token", "test-login-b");
      window.dispatchEvent(new StorageEvent("storage", { key: "mbbs.staff.token", newValue: "test-login-b" }));
    });
    release([{ netsuite_id: "OLD-PRIVATE", tranid: "OLD-PRIVATE", destination_location_id: 1 }]);
    await menu(page);
    assert.match(await page.locator(".topbar-location").innerText(), /2967/);
    assert.doesNotMatch(await page.locator("#app").innerText(), /OLD-PRIVATE/);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("mbbs.operator.state")).accountId), "yard-browser-b");
  });
});

test("removing a different yard preserves active work at a still-authorized yard", async () => {
  await fixture([1, 28], async (page, state) => {
    await page.locator("#locationSelect").waitFor();
    await page.locator('[data-action="save-location"]').click();
    await menu(page);
    await page.evaluate(() => { currentModule = "pallet-return"; returnStage = "entry"; returnDirty = true; render(); window.yardWorkWitness = true; });
    state.account = { ...state.account, operatorYardLocationIds: [1] };
    const changed = page.waitForResponse((response) => response.url().includes("/api/auth/me"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await changed;
    await page.waitForFunction(() => operator.operatorYardLocationIds.length === 1);
    assert.equal(await page.evaluate(() => Boolean(window.yardWorkWitness && returnDirty)), true);
    assert.equal(await page.locator('[data-action="toggle-location-dropdown"]').isDisabled(), true);
  });
});

test("a locked return prevents yard switching and a forged unauthorized choice is ignored", async () => {
  await fixture([1, 28], async (page) => {
    await page.locator("#locationSelect").waitFor();
    await page.locator('[data-action="save-location"]').click();
    await menu(page);
    await page.evaluate(() => {
      currentModule = "pallet-return"; returnStage = "entry"; returnDirty = true; render();
      const fake = document.createElement("button"); fake.dataset.action = "set-location-dropdown"; fake.dataset.locationId = "28"; app.append(fake); fake.click();
    });
    assert.equal(await page.evaluate(() => locationId), 1);
    await page.evaluate(() => {
      currentModule = "menu"; returnDirty = false; returnStage = "lookup"; render();
      const fake = document.createElement("button"); fake.dataset.action = "set-location-dropdown"; fake.dataset.locationId = "15"; app.append(fake); fake.click();
    });
    assert.equal(await page.evaluate(() => locationId), 1);
  });
});

test("admin account creation and editing submit independent Operator yard checkboxes", async () => {
  await fixture([], async (page, state) => {
    page.on("dialog", (dialog) => dialog.dismiss());
    await page.goto(`${base}/admin`);
    await page.waitForFunction(() => typeof renderNewOperatorDetail === "function");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => { app.innerHTML = renderNewOperatorDetail(); });
    assert.equal(await page.locator("[data-new-operator-yard]").count(), 4);
    assert.equal(await page.locator("[data-new-operator-yard]:checked").count(), 0);
    await page.locator("#newUsername").fill("new-operator");
    await page.locator("#newDisplayName").fill("New Operator");
    await page.locator("#newPassword").fill("test-password");
    await page.locator('[data-new-sales-yard][value="28"]').check();
    await page.locator('[data-new-operator-yard][value="1"]').check();
    const creating = page.waitForRequest((request) => request.url().endsWith("/api/operators") && request.method() === "POST");
    await page.locator('[data-form="create-operator"] button[type="submit"]').click();
    const created = (await creating).postDataJSON();
    assert.deepEqual(created.yardLocationIds, [28]);
    assert.deepEqual(created.operatorYardLocationIds, [1]);
    await state.captureCoverage();
    await page.goto(`${base}/admin`);
    await page.waitForFunction(() => typeof renderOperatorDetail === "function");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => { app.innerHTML = renderOperatorDetail({ id: "edit-account", username: "edit", display_name: "Edit", role: "operator", roles: ["operator"], yardLocationIds: [28], operatorYardLocationIds: [1], active: true }); });
    await page.locator('[data-account-operator-yard][value="1"]').uncheck();
    await page.locator('[data-account-operator-yard][value="26"]').check();
    const updating = page.waitForRequest((request) => request.url().endsWith("/api/operators/edit-account/roles"));
    await page.locator('[data-action="save-account-roles"]').click();
    const updated = (await updating).postDataJSON();
    assert.deepEqual(updated.yardLocationIds, [28]);
    assert.deepEqual(updated.operatorYardLocationIds, [26]);
  }, { role: "admin" });
});

test("refreshing no-access after an administrator assigns one yard opens that yard", async () => {
  await fixture([], async (page, state) => {
    await page.locator('[data-action="refresh-yard-access"]').waitFor();
    state.account = { ...state.account, operatorYardLocationIds: [26] };
    await page.locator('[data-action="refresh-yard-access"]').click();
    await menu(page);
    assert.match(await page.locator(".topbar-location").innerText(), /150/);
  });
});

for (const status of [401, 403]) {
  test(`an API ${status} clears inaccessible work before showing the next screen`, async () => {
    await fixture([1], async (page, state) => {
      await menu(page);
      await page.route("**/api/delivery/orders?**", (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: "Access changed", code: "OPERATOR_YARD_FORBIDDEN" }) }));
      if (status === 403) state.account = { ...state.account, operatorYardLocationIds: [] };
      await page.evaluate(() => {
        selectedId = "old-private-order";
        void api("/api/delivery/orders?locationId=1").catch(() => {});
      });
      if (status === 401) {
        await page.locator("#loginUsername").waitFor();
        assert.equal(await page.evaluate(() => localStorage.getItem("mbbs.staff.token")), null);
      } else await page.locator('[data-action="refresh-yard-access"]').waitFor();
      assert.doesNotMatch(await page.locator("#app").innerText(), /old-private-order/);
    });
  });
}

test("inventory synchronization and return photo tickets use only the selected authorized yard", async () => {
  await fixture([1], async (page) => {
    await menu(page);
    await page.route("**/api/inventory/facets?**", (route) => route.fulfill({ contentType: "application/json", body: '{"productTypes":[],"brands":[],"series":[]}' }));
    await page.route("**/api/cycle-count/draft", (route) => route.fulfill({ contentType: "application/json", body: '{"lines":[]}' }));
    const sync = page.waitForRequest((request) => request.url().endsWith("/api/inventory/sync"));
    await page.evaluate(() => { void syncInventory().catch(() => {}); });
    assert.deepEqual((await sync).postDataJSON().locationIds, [1]);
    await page.route("**/api/operator/photo-upload-token", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ uploadUrl: `${base}/fake-upload`, token: "test-upload-ticket" }) }));
    await page.route("**/fake-upload", (route) => route.fulfill({ contentType: "application/json", body: '{"key":"operator/return/test-photo"}' }));
    const ticket = page.waitForRequest((request) => request.url().endsWith("/api/operator/photo-upload-token"));
    const uploaded = await page.evaluate(() => uploadOperatorPhoto("data:image/jpeg;base64,dGVzdA==", { recordType: "operator-return-photo" }));
    assert.equal((await ticket).postDataJSON().locationId, 1);
    assert.equal(uploaded, "r2://operator/return/test-photo");
  });
});


test("a revoked persisted yard is removed before restoring that account's saved order", async () => {
  await fixture([28], async (page, state) => {
    await menu(page);
    assert.match(await page.locator(".topbar-location").innerText(), /2967/);
    assert.equal(state.calls.some((call) => call.includes("REVOKED-ORDER")), false);
  }, { restored: { accountId: "yard-browser-a", sessionKey: crypto.createHash("sha256").update("test-login-one").digest("hex"), locationId: 1, currentModule: "customer-pickup", selectedId: "REVOKED-ORDER" } });
});

test("live access updates refresh grants, and an unchanged no-access refresh stays usable", async () => {
  await fixture([], async (page, state) => {
    await page.locator('[data-action="refresh-yard-access"]').click();
    await page.locator('[data-action="refresh-yard-access"]').waitFor();
    state.account = { ...state.account, operatorYardLocationIds: [1] };
    await page.evaluate(() => window.yardTestEvents.listeners["app-event"]({ data: JSON.stringify({ type: "operator.access.updated", payload: {} }) }));
    await menu(page);
    assert.match(await page.locator(".topbar-location").innerText(), /3445/);
  });
});


test("an access update during an older pending check queues a fresh permission read", async () => {
  await fixture([1], async (page, state) => {
    await menu(page);
    const previous = state.account;
    let release, signal, requests = 0;
    const pending = new Promise((resolve) => { release = resolve; });
    const requested = new Promise((resolve) => { signal = resolve; });
    await page.route("**/api/auth/me", async (route) => {
      requests += 1;
      if (requests === 1) {
        signal();
        await pending;
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ operator: previous }) });
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ operator: state.account }) });
    });
    await page.evaluate(() => { void refreshOperatorAccess(); });
    await requested;
    state.account = { ...state.account, operatorYardLocationIds: [] };
    await page.evaluate(() => window.yardTestEvents.listeners["app-event"]({ data: JSON.stringify({ type: "operator.access.updated", payload: {} }) }));
    release();
    await page.locator('[data-action="refresh-yard-access"]').waitFor({ timeout: 6000 });
    assert.ok(requests >= 2, "the updated grants must be fetched after the stale response");
    assert.equal(await page.locator(".module-menu").count(), 0);
  });
});


test("reconnecting after the server closes a changed account's stream refreshes its grants", async () => {
  await fixture([1], async (page, state) => {
    await menu(page);
    state.account = { ...state.account, operatorYardLocationIds: [] };
    await page.evaluate(() => window.yardTestEvents.listeners["app-event"]({ data: JSON.stringify({ type: "connected", payload: {} }) }));
    await page.locator('[data-action="refresh-yard-access"]').waitFor({ timeout: 6000 });
    assert.equal(await page.locator(".module-menu").count(), 0);
  });
});
