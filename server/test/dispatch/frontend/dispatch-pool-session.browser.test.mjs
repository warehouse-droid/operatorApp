import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { before, after, test } from "node:test";
import { chromium, expect } from "@playwright/test";

let browser, server, baseUrl;
const order = (id, extra = {}) => ({
  id, type: "SO", customer: "Pool fixture", address: "1 Test Road, Toronto, ON",
  pickupLocations: ["3445"], sourceYard: "3445", pallets: 1, salesQty: 10,
  items: [{ sku: "POOL-STONE", quantity: 10, pallets: 1 }], ...extra
});
const seed = Array.from({ length: 12 }, (_, i) => order(`SOA${10000 + i}`));
const found = order("SOA09000");
const newCo = order("CO-SOA09000", {
  type: "CO", sourceTable: "local_co_orders", sourceOrderId: "SOA09000",
  sourceOrderType: "SO", destinationYard: "12441", address: "12441 Woodbine Avenue"
});

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.endsWith(".js") || url.pathname.endsWith(".css")) {
      res.setHeader("Content-Type", url.pathname.endsWith(".js") ? "text/javascript" : "text/css");
      res.end(await readFile(new URL(`../../../public${url.pathname}`, import.meta.url)));
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      for await (const chunk of req) { void chunk; }
      res.setHeader("Content-Type", "application/json");
      const search = url.searchParams.get("search");
      if (url.pathname.startsWith("/api/dispatch/v2/order-feed/")) res.end(JSON.stringify({ order: newCo }));
      else if (url.pathname === "/api/dispatch/v2/order-pool") res.end(JSON.stringify({ orders: search ? [found] : seed, nextCursor: search ? "" : "browse-next" }));
      else if (url.pathname === "/api/dispatch/orders") res.end(JSON.stringify(search ? [found] : seed));
      else res.end(JSON.stringify({ co: { co_ref: newCo.id } }));
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><html><head><link rel="stylesheet" href="/dispatch.css" />
      <style>.order-list { height: 350px; flex: none; overflow: auto; overflow-anchor: none; } .panel { width: 620px; }</style>
      </head><body><main id="dispatchApp"></main><script>
      function requireDispatchLogin() {}
      window.EventSource = class {
        constructor() { window.poolEvents = this; this.listeners = {}; }
        addEventListener(name, listener) { this.listeners[name] = listener; }
        close() {}
      };
      </script><script src="/dispatch.js"></script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});

after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve));
});

async function pageFor(t, mode = "on") {
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(baseUrl);
  await initialize(page, mode);
  return page;
}

async function initialize(page, mode = "on") {
  await page.evaluate(({ seed, mode }) => {
    trucks = []; fleet = []; currentPlanDate = "2099-09-15";
    currentPlan = { id: "pool-plan", planDate: currentPlanDate, orders: [], trucks: [] };
    dispatchConfig = { plannerOrderPoolMode: mode, googleMapsEnabled: false };
    dispatchPlannerSnapshotState = "ready";
    applyDispatchOrderFeed(seed);
    app.innerHTML = renderOrderPool();
  }, { seed, mode });
}

for (const mode of ["off", "shadow", "on"]) {
  test(`${mode}: a search discovery survives background updates, repeated searches and type changes until reload`, async t => {
    const page = await pageFor(t, mode);
    let searches = 0;
    page.on("request", req => { if (new URL(req.url()).searchParams.has("search")) searches++; });
    await page.locator("#orderSearch").fill("SOA09000");
    await expect(page.locator('[data-order="SOA09000"]')).toHaveCount(1);
    await page.evaluate(async () => {
      selectedOrderId = "SOA09000"; selectedOrderIds = new Set([selectedOrderId]);
      await runQueuedDispatchOrderPoolRefresh();
    });
    await expect(page.locator('[data-order="SOA09000"]')).toHaveCount(1);
    assert.deepEqual(await page.evaluate(() => [...selectedOrderIds]), ["SOA09000"]);
    await page.locator("#orderSearch").fill("");
    await expect(page.locator('[data-order="SOA09000"]')).toHaveCount(1);
    await page.evaluate(async () => {
      activeOrderType = "CO"; await loadDispatchOrders();
      activeOrderType = "SO"; await loadDispatchOrders();
      renderDispatchOrderPoolPatch();
    });
    await page.locator("#orderSearch").fill("soa09000");
    assert.equal(await page.evaluate(() => orderSearchLoading), false);
    await page.waitForTimeout(300);
    assert.equal(searches, 1, "A successful search is reused in this page session");
    await expect(page.locator('[data-order="SOA09000"]')).toHaveCount(1);
    await page.reload();
    await initialize(page, mode);
    await expect(page.locator('[data-order="SOA09000"]')).toHaveCount(0);
  });
}

test("background updates keep the actual input, date, card, selection and scrolled list mounted", async t => {
  const page = await pageFor(t);
  await page.locator("#orderSearch").fill("SOA1");
  await page.evaluate(() => cancelDispatchOrderSearch());
  const result = await page.evaluate(async () => {
    const input = document.getElementById("orderSearch");
    const date = document.getElementById("dispatchDate");
    const pool = app.querySelector("[data-dispatch-order-pool]");
    const list = pool.querySelector(".order-list");
    const card = list.querySelector("[data-order]");
    input.focus(); input.setSelectionRange(1, 3);
    date.value = "2099-10-01";
    list.scrollTop = 460;
    const scroll = list.scrollTop;
    const mutations = [];
    const observer = new MutationObserver(records => mutations.push(...records));
    observer.observe(list, { childList: true, subtree: true, attributes: true, characterData: true });
    await runQueuedDispatchOrderPoolRefresh();
    await Promise.resolve();
    observer.disconnect();
    return {
      sameInput: input === document.getElementById("orderSearch"),
      sameDate: date === document.getElementById("dispatchDate"),
      samePool: pool === app.querySelector("[data-dispatch-order-pool]"),
      sameList: list === pool.querySelector(".order-list"),
      sameCard: card === list.querySelector("[data-order]"),
      focused: input === document.activeElement,
      search: input.value, date: date.value, selection: [input.selectionStart, input.selectionEnd],
      scroll: list.scrollTop, previousScroll: scroll, mutations: mutations.length,
      cursor: dispatchOrderPoolNextCursor
    };
  });
  assert.deepEqual(result, {
    sameInput: true, sameDate: true, samePool: true, sameList: true, sameCard: true,
    focused: true, search: "SOA1", date: "2099-10-01", selection: [1, 3],
    scroll: result.previousScroll, previousScroll: result.previousScroll, mutations: 0, cursor: ""
  });
  assert.ok(result.scroll > 0);
});

test("changed data updates an existing card in place without resetting search", async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(seed => {
    const card = app.querySelector(`[data-order="${seed[0].id}"]`);
    const label = card.querySelector("strong");
    applyDispatchOrderFeed(seed.map((item, i) => i ? item : { ...item, customer: "Updated customer" }));
    renderDispatchOrderPoolPatch();
    return { same: card === app.querySelector(`[data-order="${seed[0].id}"]`), sameLabel: label === card.querySelector("strong"), text: label.textContent };
  }, seed);
  assert.deepEqual(result, { same: true, sameLabel: true, text: `${seed[0].id} | Updated customer` });
});

test("CO live creation enters the pool while browsing SOs and remains after a limited refresh", async t => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    connectEvents();
    window.poolEvents.listeners["app-event"]({ data: JSON.stringify({ type: "dispatch.co.updated", payload: { coRef: "CO-SOA09000" } }) });
  });
  await expect.poll(() => page.evaluate(() => orderCatalog.some(order => order.id === "CO-SOA09000"))).toBe(true);
  await page.evaluate(async () => {
    await runQueuedDispatchOrderPoolRefresh();
    activeOrderType = "CO"; renderDispatchOrderPoolPatch();
  });
  await expect(page.locator('[data-order="CO-SOA09000"]')).toHaveCount(1);
});

test("a CO saved in this tab survives subsequent pool refreshes", async t => {
  const page = await pageFor(t);
  await page.evaluate(async ({ found, newCo }) => {
    orders.push(normalizeOrder(found), normalizeOrder(newCo));
    await saveTransitCoToServer(found, newCo);
    await runQueuedDispatchOrderPoolRefresh();
    activeOrderType = "CO"; renderDispatchOrderPoolPatch();
  }, { found, newCo });
  await expect(page.locator('[data-order="CO-SOA09000"]')).toHaveCount(1);
});

test("authoritative retirement removes a retained discovery and cannot be undone by a stale feed", async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(({ found, seed }) => {
    mergeDispatchOrderSearchFeed([found]);
    setAuthoritativeOrderRetirement(found.id, true);
    applyDispatchOrderFeed([...seed, found]);
    return { inOrders: orders.some(order => order.id === found.id), inCatalog: orderCatalog.some(order => order.id === found.id) };
  }, { found, seed });
  assert.deepEqual(result, { inOrders: false, inCatalog: false });
});

test("search errors can be retried and clearing the input cancels a queued search", async t => {
  const page = await pageFor(t);
  let calls = 0;
  await page.route("**/api/dispatch/v2/order-pool?search=**", route => {
    calls++;
    return route.fulfill({ status: calls === 1 ? 503 : 200, contentType: "application/json", body: calls === 1 ? "Unavailable" : JSON.stringify({ orders: [found] }) });
  });
  await page.locator("#orderSearch").fill("SOA09000");
  await expect.poll(() => page.evaluate(() => orderSearchError)).toBe("Unavailable");
  await page.locator("#orderSearch").fill("");
  await page.locator("#orderSearch").fill("SOA09000");
  await expect(page.locator('[data-order="SOA09000"]')).toHaveCount(1);
  assert.equal(calls, 2);
  await page.locator("#orderSearch").fill("missing");
  await page.locator("#orderSearch").fill("");
  await page.waitForTimeout(300);
  assert.equal(calls, 2, "Clearing the input cancels the debounced request");
});

test("inserting an order above the viewport preserves the visible card position", async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(seed => {
    const list = app.querySelector(".order-list");
    list.style.overflowAnchor = "auto";
    list.scrollTop = 450;
    const card = [...list.children].find(card => card.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
    const before = card.getBoundingClientRect().top;
    applyDispatchOrderFeed([{ ...seed[0], id: "SO-NEW" }, ...seed]);
    renderDispatchOrderPoolPatch();
    return { connected: card.isConnected, before, after: card.getBoundingClientRect().top };
  }, seed);
  assert.equal(result.connected, true);
  assert.equal(result.after, result.before);
});

test("retained orders keep refreshed data and current assignment metadata", async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(({ found, seed }) => {
    mergeDispatchOrderSearchFeed([found]);
    applyDispatchOrderFeed([{ ...found, customer: "Fresh customer" }]);
    applyPlannedAssignments([{ orderRef: found.id, dispatchPlanId: "another-plan", dispatchPlanDate: "2099-09-16" }]);
    applyDispatchOrderFeed(seed);
    const current = orderById(found.id);
    return { customer: current.customer, planned: current.dispatchPlanned, planId: current.dispatchPlanId };
  }, { found, seed });
  assert.deepEqual(result, { customer: "Fresh customer", planned: true, planId: "another-plan" });
});

test("a delayed response for an old search cannot replace a newer result or its cursor", async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(async found => {
    const originalFetch = window.fetch;
    let resolveOld;
    window.fetch = async () => new Promise(resolve => { resolveOld = resolve; });
    searchText = "old-term";
    const pending = loadDispatchOrderSearch(searchText, ++orderSearchSequence);
    searchText = found.id; orderSearchSequence++;
    dispatchOrderPoolNextCursor = "new-search-cursor";
    mergeDispatchOrderSearchFeed([found]);
    resolveOld({ ok: true, json: async () => ({ orders: [{ ...found, id: "OLD-RESULT" }], nextCursor: "old-cursor" }) });
    await pending;
    window.fetch = originalFetch;
    return { search: searchText, cursor: dispatchOrderPoolNextCursor, stale: Boolean(orderById("OLD-RESULT")), fresh: Boolean(orderById(found.id)) };
  }, found);
  assert.deepEqual(result, { search: found.id, cursor: "new-search-cursor", stale: false, fresh: true });
});

test("a delayed SO browse cannot replace the CO tab's orders or pagination", async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(async ({ seed, newCo }) => {
    const originalFetch = window.fetch;
    let resolveSo;
    window.fetch = async url => new URL(url, location.origin).searchParams.get("type") === "SO"
      ? new Promise(resolve => { resolveSo = resolve; })
      : { ok: true, json: async () => ({ orders: [newCo], nextCursor: "co-next" }) };
    const first = loadDispatchOrders();
    activeOrderType = "CO";
    await loadDispatchOrders();
    resolveSo({ ok: true, json: async () => ({ orders: seed, nextCursor: "so-next" }) });
    await first;
    window.fetch = originalFetch;
    return { cursor: dispatchOrderPoolNextCursor, co: Boolean(orderById(newCo.id)) };
  }, { seed, newCo });
  assert.deepEqual(result, { cursor: "co-next", co: true });
});

test("a failed background feed leaves search results and selection visible", async t => {
  const page = await pageFor(t);
  await page.locator("#orderSearch").fill(found.id);
  await expect(page.locator('[data-order="SOA09000"]')).toHaveCount(1);
  await page.route("**/api/dispatch/v2/order-pool?type=**", route => route.fulfill({ status: 503, body: "Unavailable" }));
  await page.evaluate(async () => { selectedOrderId = "SOA09000"; selectedOrderIds = new Set([selectedOrderId]); await runQueuedDispatchOrderPoolRefresh(); });
  await expect(page.locator("#orderSearch")).toHaveValue(found.id);
  await expect(page.locator('[data-order="SOA09000"]')).toHaveCount(1);
  assert.deepEqual(await page.evaluate(() => [...selectedOrderIds]), [found.id]);
});
