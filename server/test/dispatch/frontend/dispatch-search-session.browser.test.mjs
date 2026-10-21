import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";

const source = process.env.DISPATCH_SEARCH_SOURCE || new URL("../../../public/dispatch.js", import.meta.url);
const date = "2026-01-01";
const session = "dispatch-search-session-test";
const token = "dispatch-search-lease-test";
const requests = [];
const coverage = [];
const order = id => ({ id, type: "TO", customer: "Transfer fixture", address: "12441 Woodbine Avenue",
  pickupLocations: ["3445"], sourceYard: "3445", pallets: 1,
  items: [{ sku: "TRANSFER-STONE", quantity: 10, pallets: 1 }] });
let server, browser, baseUrl;

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/dispatch.js") {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      res.end(await readFile(source));
    } else if (url.pathname.startsWith("/api/")) {
      let rawBody = "";
      for await (const chunk of req) rawBody += chunk;
      res.setHeader("Content-Type", "application/json");
      const record = { path: url.pathname, params: Object.fromEntries(url.searchParams),
        lease: req.headers["x-dispatch-edit-lease"], method: req.method,
        body: rawBody ? JSON.parse(rawBody) : null };
      requests.push(record);
      if (url.pathname.endsWith("/commands")) {
        if (record.body.sessionId !== session || record.lease !== token) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "A dispatch browser session is required." }));
          return;
        }
        const savedPlan = { ...record.body.payload, id: "search-session-plan", planDate: date,
          status: "draft", revision: record.body.baseRevision + 1,
          digest: "saved-search-plan-digest", savedAt: new Date().toISOString() };
        res.end(JSON.stringify({ applied: true, plan: savedPlan }));
        return;
      }
      if (url.pathname.endsWith("/edit-lease/heartbeat")) {
        res.end(JSON.stringify({ lease: { active: true, planDate: date, sessionId: session,
          expiresAt: "2099-12-31T23:59:59Z" } }));
        return;
      }
      if (url.pathname === "/api/dispatch/planned-assignments") {
        res.end("[]");
        return;
      }
      if (url.pathname.endsWith("/executed-order-reviews")) {
        res.end(JSON.stringify({ reviews: [] }));
        return;
      }
      if (url.searchParams.has("historyPlanDate")) {
        if (!url.searchParams.get("sessionId")) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "A dispatch browser session is required." }));
          return;
        }
        if (record.params.historyPlanDate !== date || record.params.sessionId !== session || record.lease !== token) {
          res.statusCode = 409;
          res.end(JSON.stringify({ error: "Enter Edit Mode before changing this dispatch plan." }));
          return;
        }
      }
      const feed = [order(url.searchParams.get("search") || "TOB01164")];
      res.end(JSON.stringify(url.pathname === "/api/dispatch/orders" ? feed : { orders: feed, nextCursor: "" }));
    } else {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end('<main id="dispatchApp"></main><script>function requireDispatchLogin() {}</script><script src="/dispatch.js"></script>');
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});

after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve));
  if (process.env.DISPATCH_SEARCH_COVERAGE) {
    await mkdir(process.env.DISPATCH_SEARCH_COVERAGE, { recursive: true });
    await writeFile(`${process.env.DISPATCH_SEARCH_COVERAGE}/browser.json`, JSON.stringify(coverage));
  }
});

async function pageFor(t, mode, { history = true, edit = true, planning = false } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(async () => {
    coverage.push(...await page.coverage.stopJSCoverage());
    await page.close();
    assert.deepEqual(errors, []);
  });
  await page.addInitScript(session => sessionStorage.setItem("mbbs.dispatch.sessionId", session), session);
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.goto(baseUrl);
  await page.evaluate(({ mode, history, edit, planning, date, token }) => {
    trucks = []; fleet = [];
    if (planning) {
      fleet = [{ plate: "SEARCH-TEST-101", capacityLbs: 48000, baseYard: "3445" }];
      trucks = fleet.map((vehicle, index) => makeTruckFromFleet(vehicle, index));
      selectedLoadId = trucks[0].loads[0].id;
    }
    currentPlanDate = history ? date : "2099-01-01";
    currentPlan = { id: "search-session-plan", planDate: currentPlanDate, status: "draft",
      revision: 1, digest: "initial-search-plan-digest", orders: [], trucks: [] };
    dispatchConfig = { plannerOrderPoolMode: mode, plannerCommandMode: "on", googleMapsEnabled: false };
    dispatchPlannerSnapshotState = "ready";
    planEditMode = edit;
    planEditLeaseToken = token;
    planEditLease = { active: true, planDate: currentPlanDate, sessionId: dispatchSessionId, expiresAt: "2099-12-31T23:59:59Z" };
    orders = []; orderCatalog = [];
    app.innerHTML = renderOrderPool();
  }, { mode, history, edit, planning, date, token });
  return page;
}

function assertHistory(record) {
  assert.equal(record.params.historyPlanDate, date);
  assert.equal(record.params.sessionId, session);
  assert.equal(record.lease, token);
}

for (const mode of ["off", "shadow", "on"]) {
  test(`${mode}: search, plan and save TOB01164 then search TOB01163 without reloading`, async t => {
    const page = await pageFor(t, mode, { planning: true });
    const start = requests.length;
    await page.locator("#orderSearch").fill("TOB01164");
    await expect(page.locator('[data-order="TOB01164"]')).toHaveCount(1);
    const saved = await page.evaluate(async () => {
      const added = addOrderToLoad("TOB01164", trucks[0].loads[0].id);
      if (!added) throw new Error(`Add to load failed: ${routeNotice}`);
      commitPlanMutation("drop_order_or_stop", null, { forceSave: true });
      const result = await saveCurrentPlanNow();
      await heartbeatDispatchEditLease();
      return { result, revision: currentPlan.revision, sessionId: dispatchSessionId,
        editMode: planEditMode, leaseToken: planEditLeaseToken,
        stops: trucks[0].loads[0].stops.map(stop => ({ orderId: stop.orderId, type: stop.type })) };
    });
    assert.equal(saved.result.saved, true);
    assert.equal(saved.revision, 2);
    assert.equal(saved.sessionId, session);
    assert.equal(saved.editMode, true);
    assert.equal(saved.leaseToken, token);
    assert.ok(saved.stops.some(stop => stop.orderId === "TOB01164" && stop.type === "drop"));
    const save = requests.slice(start).find(record => record.path.endsWith("/commands"));
    assert.ok(save, "The real save path must issue a plan command");
    assert.equal(save.body.sessionId, session);
    assert.equal(save.lease, token);
    assert.ok(save.body.payload.orders.some(order => order.id === "TOB01164"));
    assert.ok(save.body.payload.trucks.some(truck => truck.loads.some(load =>
      load.stops.some(stop => stop.orderId === "TOB01164" && stop.type === "drop"))));
    await page.locator("#orderSearch").fill("TOB01163");
    await expect.poll(() => page.evaluate(() => orderSearchLoading)).toBe(false);
    await expect(page.locator('[data-order="TOB01163"]')).toHaveCount(1);
    assert.equal(await page.evaluate(() => orderSearchError), "");
    const searches = requests.slice(start).filter(record => record.params.search);
    assert.deepEqual(searches.map(record => record.params.search), ["TOB01164", "TOB01163"]);
    searches.forEach(assertHistory);
    searches.forEach(record => assert.equal(record.path,
      mode === "off" ? "/api/dispatch/orders" : "/api/dispatch/v2/order-pool"));
  });

  test(`${mode}: historical searches find TOB01164 and TOB01163 with the leased tab session`, async t => {
    const page = await pageFor(t, mode);
    for (const ref of ["TOB01164", "TOB01163"]) {
      const received = page.waitForRequest(req => new URL(req.url()).searchParams.get("search") === ref);
      await page.locator("#orderSearch").fill(ref);
      await received;
      await expect.poll(() => page.evaluate(() => orderSearchLoading)).toBe(false);
      assert.equal(await page.evaluate(() => orderSearchError), "");
      await expect(page.locator(`[data-order="${ref}"]`)).toHaveCount(1);
      const record = requests.findLast(row => row.params.search === ref);
      assertHistory(record);
      assert.equal(record.path, mode === "off" ? "/api/dispatch/orders" : "/api/dispatch/v2/order-pool");
    }
  });

  test(`${mode}: historical browse and sync carry the same session`, async t => {
    const page = await pageFor(t, mode);
    const start = requests.length;
    const loaded = await page.evaluate(async () => {
      activeOrderType = "TO";
      const browse = await loadDispatchOrders();
      const sync = await loadDispatchOrders({ sync: true });
      return { browse, sync };
    });
    assert.deepEqual(loaded, { browse: true, sync: true });
    const records = requests.slice(start);
    assert.equal(records.length, 2);
    records.forEach(assertHistory);
    assert.equal(records[1].path, "/api/dispatch/sync");
    assert.equal(records[1].method, "POST");
    if (mode !== "off") {
      assert.equal(records[0].params.type, "TO");
      assert.equal(records[0].params.limit, "200");
    }
  });
}

test("historical search pagination retains date, session, token, search and cursor", async t => {
  const page = await pageFor(t, "on");
  const start = requests.length;
  await page.evaluate(async () => {
    searchText = "TOB01163";
    dispatchOrderPoolNextCursor = "next?cursor&value=2";
    await loadMoreDispatchOrders();
  });
  assert.equal(await page.evaluate(() => orderSearchError), "");
  assert.equal(requests.length, start + 1);
  const record = requests.at(-1);
  assertHistory(record);
  assert.equal(record.params.search, "TOB01163");
  assert.equal(record.params.cursor, "next?cursor&value=2");
  assert.equal(record.params.limit, "200");
});

test("current and historical view searches omit history credentials in every pool mode", async t => {
  for (const mode of ["off", "shadow", "on"]) {
    for (const history of [true, false]) {
      const page = await pageFor(t, mode, { history, edit: !history });
      const start = requests.length;
      await page.locator("#orderSearch").fill("TOB01164");
      await expect(page.locator('[data-order="TOB01164"]')).toHaveCount(1);
      const record = requests.slice(start).find(row => row.params.search === "TOB01164");
      assert.ok(record);
      assert.equal(record.params.historyPlanDate, undefined);
      assert.equal(record.params.sessionId, undefined);
      assert.equal(record.lease, undefined);
    }
  }
});

test("a rejected historical lease reports the error and never merges the requested order", async t => {
  const page = await pageFor(t, "on");
  await page.evaluate(() => { planEditLeaseToken = "rejected-lease"; });
  await page.locator("#orderSearch").fill("TOB01163");
  await expect.poll(() => page.evaluate(() => orderSearchError)).toContain("Enter Edit Mode");
  await expect(page.locator('[data-order="TOB01163"]')).toHaveCount(0);
});
