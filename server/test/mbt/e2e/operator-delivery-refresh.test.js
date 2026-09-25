import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import test, { before, after } from "node:test";
import { chromium } from "@playwright/test";
import { displayFixture, displayApiResponse, palletLine } from "../../support/operator-display-refresh-fixture.mjs";

const output = process.env.DISPLAY_FIX_ARTIFACTS || "test-artifacts/operator-display-fix/browser";
let browser;
before(async () => {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
});
after(async () => { await browser?.close(); });

async function session(t, { coldPacked = false, readyToPack = false } = {}) {
  const fixture = displayFixture();
  if (readyToPack) {
    fixture.group.lines = [{ ...palletLine, quantity: 2, packed_sales_qty: 2 }];
    fixture.statusResult = { ...fixture.group, operator_status: "packed" };
  }
  const actor = { id: "display-test", display_name: "Test operator", role: "operator", roles: ["operator"], operatorYardLocationIds: [1, 28] };
  const token = "display-test-session";
  const sessionKey = crypto.createHash("sha256").update(token).digest("hex");
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });
  await context.addInitScript(({ actor: user, token: auth, sessionKey: storedSession }) => {
    localStorage.setItem("mbbs.operator.token", auth);
    localStorage.setItem("mbbs.staff.token", auth);
    localStorage.setItem("mbbs.ui.language", "en");
    localStorage.setItem("mbbs.operator.state", JSON.stringify({ accountId: user.id, sessionKey: storedSession, locationId: 1,
      currentModule: "delivery", viewMode: "active", deliveryBatchFilter: "planned", selectedId: "GOB-120607-120608" }));
    window.EventSource = class {
      constructor() { window.displayEvents = this; this.handlers = {}; }
      addEventListener(type, handler) { this.handlers[type] = handler; }
      close() {}
      emit(type = "delivery.order.updated", payload = { orderId: "996632" }) { this.handlers["app-event"]?.({ data: JSON.stringify({ type, payload }) }); }
    };
  }, { actor, token, sessionKey });
  const page = await context.newPage();
  // Batch A/B fixture dates are relative to this day; timers remain real.
  await page.clock.setFixedTime(new Date('2026-09-18T16:00:00Z'));
  page.setDefaultTimeout(10000);
  if (process.env.DISPLAY_FIX_COVERAGE === "1") {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
  }
  t.after(async () => {
    try {
      if (process.env.DISPLAY_FIX_COVERAGE === "1") {
        const coverage = await page.coverage.stopJSCoverage();
        await writeFile(`${output}/${t.name.replaceAll(/[^a-z0-9]+/giu, "-")}.coverage.json`, JSON.stringify(coverage));
      }
    } finally { await context.close(); }
  });
  const calls = [], errors = [], holds = [];
  const hold = (match, fail = false) => {
    const item = { match, fail, claimed: false };
    item.started = new Promise((resolve) => { item.startedResolve = resolve; });
    item.promise = new Promise((resolve) => { item.release = resolve; });
    holds.push(item);
    return item;
  };
  const initialPacked = coldPacked ? hold(packedSales) : null;
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) {
      const file = url.pathname === "/operator" ? "operator.html" : url.pathname.slice(1);
      try {
        const body = await readFile(path.join("public", file));
        await route.fulfill({ status: 200, contentType: ({ ".html": "text/html", ".js": "application/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream", body });
      } catch { await route.fulfill({ status: 404, body: "" }); }
      return;
    }
    calls.push(url.pathname + url.search);
    const serialized = JSON.stringify(displayApiResponse(url, fixture, actor));
    const hold = holds.find((item) => !item.claimed && item.match(url));
    if (hold) { hold.claimed = true; hold.startedResolve(); await hold.promise; }
    await route.fulfill({ status: hold?.fail ? 503 : 200, contentType: "application/json", body: hold?.fail ? JSON.stringify({ error: "Refresh unavailable" }) : serialized });
  });
  await page.goto("http://localhost/operator");
  await page.waitForFunction((cold) => selectedOrder?.netsuite_id === "GOB-120607-120608" && deliveryOrdersLoadingCount === 0 && (cold || Array.isArray(deliveryOrderBuckets.packed)), coldPacked);
  if (initialPacked) { await initialPacked.started; }
  return { page, fixture, calls, hold, initialPacked };
}

const bootstrap = (url) => url.pathname === "/api/delivery/bootstrap";
const packedSales = (url) => url.pathname === "/api/delivery/orders" && url.searchParams.get("status") === "packed" && url.searchParams.get("orderType") === "sales_order";
const idle = (page) => page.waitForFunction(() => deliveryOrdersLoadingCount === 0);
const state = (page) => page.evaluate(() => ({ view: viewMode, refs: orders.map((order) => order.tranid), selected: selectedId,
  pages: document.querySelector(".order-panel .pagination-row strong")?.textContent }));

test("P1 confirmed packing is visible while the first Packed snapshot is still pending", async (t) => {
  const { page, fixture, hold, initialPacked } = await session(t, { coldPacked: true, readyToPack: true });
  const refreshes = Array.from({ length: 3 }, () => hold(packedSales));
  fixture.packed.push(fixture.statusResult);
  try {
    await page.locator('[data-action="set-packed"]').click();
    await page.waitForFunction(() => deliveryOrderBuckets.packed?.some(order => order.netsuite_id === "GOB-120607-120608"));
    await page.locator('[data-action="view-packed"]').click();
    await page.waitForFunction(() => viewMode === "packed" && orders.some(order => order.netsuite_id === "GOB-120607-120608"), null, { timeout: 1000 });
    assert.equal(await page.locator('[data-order="GOB-120607-120608"]').count(), 1);
    initialPacked.release();
    await page.waitForTimeout(50);
    assert.ok((await state(page)).refs.includes(fixture.group.tranid), 'Old prefetch cannot erase the confirmed order');
  } finally { initialPacked.release(); refreshes.forEach(item => item.release()); }
});

test("P2 packing replaces another yard's cached membership before opening Packed", async (t) => {
  const { page, fixture, hold } = await session(t, { readyToPack: true });
  const refreshes = Array.from({ length: 3 }, () => hold(packedSales));
  await page.evaluate(() => {
    deliveryOrderBuckets.packed = [{ netsuite_id: 'OTHER-YARD', tranid: 'OTHER-YARD', outbound_location_id: 28 }];
    deliveryOrderBucketScopes.packed = 'previous-yard';
  });
  fixture.packed.push(fixture.statusResult);
  try {
    await page.locator('[data-action="set-packed"]').click();
    await page.waitForFunction(() => deliveryOrderBuckets.packed?.some(order => order.netsuite_id === "GOB-120607-120608"));
    assert.deepEqual(await page.evaluate(() => deliveryOrderBuckets.packed.map(order => order.netsuite_id)), [fixture.group.netsuite_id]);
    await page.locator('[data-action="view-packed"]').click();
    await page.waitForFunction(() => viewMode === "packed" && orders.some(order => order.netsuite_id === "GOB-120607-120608"), null, { timeout: 1000 });
    assert.equal(await page.locator('[data-order="OTHER-YARD"]').count(), 0);
  } finally { refreshes.forEach(item => item.release()); }
});

test("P3 failed packing does not create a Packed entry", async (t) => {
  const { page, fixture, hold } = await session(t, { readyToPack: true });
  const failed = hold(url => url.pathname.endsWith('/status'), true);
  await page.locator('[data-action="set-packed"]').click();
  await failed.started; failed.release();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Refresh unavailable'));
  assert.ok((await state(page)).refs.includes(fixture.group.tranid));
  assert.deepEqual(await page.evaluate(() => deliveryOrderBuckets.packed.map(order => order.netsuite_id)), ['VRMA:display']);
});

test("P4 partial packing remains in Active and also appears in Packed", async (t) => {
  const { page, fixture, hold } = await session(t, { readyToPack: true });
  fixture.group.lines[0].quantity = 3;
  await page.evaluate(() => loadDetail(selectedId));
  const delayed = hold(packedSales);
  try {
    await page.locator('[data-action="set-packed"]').click();
    await page.waitForFunction(() => orders.some(order => order.underpack_count === 1));
    assert.ok((await state(page)).refs.includes(fixture.group.tranid));
    assert.ok(await page.evaluate(() => deliveryOrderBuckets.packed.some(order => order.netsuite_id === selectedId)));
  } finally { delayed.release(); }
});

test("P5 real event-stream handler wakes pickup confirmation through the job API", async (t) => {
  const { page, fixture, calls } = await session(t);
  const endpoint = '/api/operator/netsuite-posting-jobs/browser-job';
  await page.evaluate(() => { window.postingResult = null; window.postingPromise = pollOperatorNetSuitePostingJob('browser-job').then(result => { window.postingResult = result; }); });
  await page.waitForFunction(() => operatorPostingPollWakeups.has('browser-job'));
  await page.waitForTimeout(30);
  assert.equal(calls.filter(url => url === endpoint).length, 1);
  fixture.postingJob = { status: 'completed', result: { localFinalization: { verified: true } } };
  await page.evaluate(() => window.displayEvents.emit('delivery.order.loaded', { result: { operatorNetSuitePosting: { commandId: 'browser-job' } } }));
  await page.waitForFunction(() => window.postingResult?.verified === true, null, { timeout: 500 });
  assert.equal(calls.filter(url => url === endpoint).length, 2);
  assert.equal(await page.evaluate(() => operatorPostingPollWakeups.size), 0);
});

test("R1 late Active cannot replace Packed with 13 pages", async (t) => {
  const { page, hold } = await session(t);
  const delayed = hold(bootstrap);
  await page.evaluate(() => { window.displayPending = loadOrders({ keepSelection: true }); });
  await delayed.started;
  await page.locator('[data-action="view-packed"]').click();
  delayed.release();
  await idle(page);
  assert.equal((await state(page)).view, "packed");
  assert.deepEqual((await state(page)).refs, ["VRMA-DISPLAY"]);
  assert.equal((await state(page)).pages, "1 / 1");
});

test("R2 late Packed cannot clear Active after returning to it", async (t) => {
  const { page, hold } = await session(t);
  await page.locator('[data-action="view-packed"]').click();
  const delayed = hold(packedSales);
  await page.evaluate(() => { window.displayPending = loadOrders({ keepSelection: true }); });
  await delayed.started;
  await page.locator('[data-action="view-active"]').click();
  delayed.release();
  await idle(page);
  const actual = await state(page);
  assert.equal(actual.view, "active");
  assert.equal(actual.refs.length, 38);
  assert.equal(actual.selected, "GOB-120607-120608");
});

test("R3 latest same-tab refresh wins and failed refresh preserves the list", async (t) => {
  const { page, hold, fixture } = await session(t);
  const delayed = hold(bootstrap);
  await page.evaluate(() => { window.displayPending = loadOrders({ keepSelection: true }); });
  await delayed.started;
  fixture.active = [fixture.group];
  await page.evaluate(() => loadOrders({ keepSelection: true }));
  delayed.release();
  await idle(page);
  assert.deepEqual((await state(page)).refs, [fixture.group.tranid]);
  const failed = hold(bootstrap, true);
  await page.locator('[data-action="refresh"]').click();
  await failed.started; failed.release(); await idle(page);
  assert.deepEqual((await state(page)).refs, [fixture.group.tranid]);
  assert.equal((await state(page)).selected, fixture.group.netsuite_id);
  assert.match(await page.locator("#toast").textContent(), /Refresh unavailable/u);
});

test("R6 Packed refresh retains VRMA and fetches each family once", async (t) => {
  const { page, calls } = await session(t);
  await page.locator('[data-action="view-packed"]').click();
  const start = calls.length;
  await page.evaluate(() => loadOrders({ keepSelection: true }));
  const lists = calls.slice(start).filter((url) => url.startsWith("/api/delivery/orders?") || url.startsWith("/api/delivery/vrma-orders?"));
  assert.equal(lists.length, 3);
  assert.deepEqual((await state(page)).refs, ["VRMA-DISPLAY"]);
  await page.screenshot({ path: `${output}/packed.png`, fullPage: true });
});

test("L1 both linked lines render reference quantities and no packing controls", async (t) => {
  const { page } = await session(t);
  assert.deepEqual(await page.locator(".line-card .line-info strong").allTextContents(), ["MBBS-Special Order", "PALLET"]);
  await page.locator('[data-line="456639"]').click();
  const text = await page.locator(".selected-panel").textContent();
  assert.match(text, /2,332 SQFT/u);
  assert.match(text, /Link PO/u);
  assert.match(text, /No yard load required/u);
  assert.equal(await page.locator('.selected-panel [data-action="confirm-line"]').count(), 0);
  assert.equal(await page.locator('[data-action="set-preparing"]').isDisabled(), true);
  await page.screenshot({ path: `${output}/linked-reference.png`, fullPage: true });
});

test("R4 events received during a refresh coalesce into one subsequent snapshot", async (t) => {
  const { page, hold, fixture, calls } = await session(t);
  const delayed = hold(bootstrap);
  await page.evaluate(() => { window.displayPending = loadOrders({ keepSelection: true }); });
  await delayed.started;
  const next = hold(bootstrap);
  fixture.active = [fixture.group];
  await page.evaluate(() => { for (let index = 0; index < 10; index += 1) { window.displayEvents.emit(); } });
  delayed.release();
  await next.started; next.release(); await idle(page);
  assert.deepEqual((await state(page)).refs, [fixture.group.tranid]);
  assert.equal(calls.filter((url) => url.startsWith("/api/delivery/bootstrap?")).length, 3);
});

test("R4 an invalidated Packed prefetch cannot refill a newer cache", async (t) => {
  const { page, hold, fixture, calls } = await session(t);
  const delayed = hold(packedSales);
  await page.evaluate(() => { window.displayPrefetch = primePackedDeliveryOrders({ force: true }); });
  await delayed.started;
  fixture.packed = [{ ...fixture.packed[0], netsuite_id: "VRMA:latest", tranid: "VRMA-LATEST" }];
  const next = hold(bootstrap);
  await page.evaluate(() => window.displayEvents.emit());
  await next.started; next.release(); await idle(page);
  try {
    await page.waitForFunction(() => deliveryOrderBuckets.packed?.[0]?.tranid === "VRMA-LATEST", null, { timeout: 3000 });
  } finally { delayed.release(); }
  await page.evaluate(() => window.displayPrefetch);
  assert.deepEqual(await page.evaluate(() => deliveryOrderBuckets.packed.map((order) => order.tranid)), ["VRMA-LATEST"]);
  assert.equal(calls.filter((url) => url.includes("status=packed&orderType=sales_order")).length, 3);
});

test("R5 an old yard response cannot replace a newer yard snapshot", async (t) => {
  const { page, hold, fixture } = await session(t);
  const delayed = hold(bootstrap);
  await page.evaluate(() => { window.displayPending = loadOrders({ keepSelection: true }); });
  await delayed.started;
  fixture.active = [fixture.group];
  await page.evaluate(async () => { locationId = 28; await loadOrders({ keepSelection: true }); });
  delayed.release(); await idle(page);
  assert.deepEqual((await state(page)).refs, [fixture.group.tranid]);
  assert.equal(await page.evaluate(() => locationId), 28);
});

test("R5 older detail for the same order cannot replace its newer detail", async (t) => {
  const { page, hold, fixture } = await session(t);
  const delayed = hold((url) => url.pathname.endsWith("/GOB-120607-120608"));
  await page.evaluate(() => { window.displayDetail = loadDetail(selectedId); });
  await delayed.started;
  fixture.group.lines[0].item_description = "Updated material description";
  await page.evaluate(() => loadDetail(selectedId));
  delayed.release(); await page.evaluate(() => window.displayDetail);
  assert.equal(await page.evaluate(() => selectedOrder.lines[0].item_description), "Updated material description");
});

test("R5 a pending read cannot overwrite an accepted local packing update", async (t) => {
  const { page, hold } = await session(t);
  const delayed = hold(bootstrap);
  await page.evaluate(() => { window.displayPending = loadOrders({ keepSelection: true }); });
  await delayed.started;
  await page.evaluate(() => {
    markLocalDeliveryMutation(selectedId);
    acceptRefreshedDeliveryOrder({ ...selectedOrder, operator_status: "preparing" });
    finishLocalDeliveryMutation(selectedId);
  });
  delayed.release(); await idle(page);
  assert.equal(await page.evaluate(() => selectedOrder.operator_status), "preparing");
  assert.equal(await page.evaluate(() => orders[0].operator_status), "preparing");
});

test("R7 a valid refresh preserves line selection and clamps pagination", async (t) => {
  const { page, fixture } = await session(t);
  await page.locator('[data-line="456647"]').click();
  await page.evaluate(() => loadOrders({ keepSelection: true }));
  assert.equal(await page.evaluate(() => selectedLineId), "456647");
  await page.locator('[data-action="delivery-batch-filter"][data-filter="batch_b"]').click();
  await page.evaluate(() => { orderPage = 10; renderDeliveryPanels(); });
  fixture.active = fixture.active.slice(0, 6);
  await page.evaluate(() => loadOrders({ keepSelection: true }));
  assert.equal((await state(page)).pages, "2 / 2");
});

test("R5 saved and per-load snapshots keep their own membership and filter context", async (t) => {
  const { page, fixture, hold } = await session(t);
  fixture.savedKeys = [fixture.group.netsuite_id];
  await page.evaluate(async () => { deliveryPrepMode = "saved"; await loadOrders(); });
  assert.deepEqual((await state(page)).refs, [fixture.group.tranid]);
  await page.evaluate(async () => { viewMode = "packed"; await loadOrders(); });
  assert.equal((await state(page)).refs.length, 38);
  fixture.trucks = [{ truck_plate: "A" }, { truck_plate: "B" }];
  const delayed = hold((url) => url.pathname.endsWith("/load-orders"));
  await page.evaluate(() => {
    viewMode = "active"; deliveryPrepMode = "load"; deliveryLoadViewDate = "2026-09-18"; deliveryLoadViewTruck = "A";
    window.displayPending = loadOrders();
  });
  await delayed.started;
  fixture.active = [fixture.group];
  await page.evaluate(async () => { deliveryLoadViewDate = "2026-09-19"; deliveryLoadViewTruck = "B"; await loadOrders(); });
  delayed.release(); await idle(page);
  assert.deepEqual((await state(page)).refs, [fixture.group.tranid]);
  assert.equal(await page.evaluate(() => deliveryLoadViewTruck), "B");
  fixture.trucks = [];
  await page.evaluate(() => loadOrders({ keepSelection: true }));
  assert.equal(await page.evaluate(() => deliveryLoadViewTruck), "");
  assert.deepEqual((await state(page)).refs, [fixture.group.tranid]);
});

test("R3 a failed Packed family preserves all previously displayed order types", async (t) => {
  const { page, fixture, hold } = await session(t);
  fixture.packed.push({ ...fixture.group, netsuite_id: "packed-so", tranid: "PACKED-SO", operator_status: "packed" });
  fixture.packed.push({ ...fixture.group, netsuite_id: "packed-to", tranid: "PACKED-TO", order_type: "transfer_order", operator_status: "packed" });
  await page.locator('[data-action="view-packed"]').click();
  await page.evaluate(() => loadOrders());
  const previous = await state(page);
  assert.deepEqual([...previous.refs].sort(), ["PACKED-SO", "PACKED-TO", "VRMA-DISPLAY"]);
  const failed = hold(packedSales, true);
  await page.evaluate(() => { window.displayPending = loadOrders({ keepSelection: true }).catch(() => null); });
  await failed.started; failed.release(); await idle(page);
  assert.deepEqual(await state(page), previous);
});

test("R5 leaving and returning to a tab rejects old data and old errors", async (t) => {
  const { page, hold } = await session(t);
  for (const fail of [false, true]) {
    const delayed = hold(bootstrap, fail);
    await page.evaluate(() => { window.displayPending = loadOrders({ keepSelection: true }); });
    await delayed.started;
    await page.evaluate(async () => {
      currentModule = "menu"; render(); currentModule = "delivery";
      await activateCachedDeliveryView("active");
    });
    delayed.release(); await page.evaluate(() => window.displayPending);
    assert.equal((await state(page)).refs.length, 38);
  }
});

test("R4 invalidated cached tabs and batches retain their list while revalidating", async (t) => {
  const { page, fixture, hold } = await session(t);
  fixture.packed.push({ ...fixture.packed[0], netsuite_id: "VRMA:new", tranid: "VRMA-NEW" });
  await page.evaluate(() => invalidateDeliveryOrders());
  const packed = hold(packedSales);
  await page.locator('[data-action="view-packed"]').click();
  await packed.started;
  assert.deepEqual((await state(page)).refs, ["VRMA-DISPLAY"]);
  packed.release(); await idle(page);
  assert.deepEqual((await state(page)).refs, ["VRMA-DISPLAY", "VRMA-NEW"]);
  await page.locator('[data-action="view-active"]').click();
  await idle(page);
  fixture.active = fixture.active.slice(0, 3);
  await page.evaluate(() => invalidateDeliveryOrders());
  const active = hold(bootstrap);
  await page.locator('[data-action="delivery-batch-filter"][data-filter="batch_b"]').click();
  await active.started;
  assert.equal((await state(page)).refs.length, 38);
  active.release(); await idle(page);
  assert.equal((await state(page)).refs.length, 3);
});

test("R5 delayed draft and notification reads cannot overwrite newer bootstrap metadata", async (t) => {
  const { page, fixture, hold } = await session(t);
  fixture.draft = { netsuite_id: fixture.group.netsuite_id, tranid: "Old draft" };
  fixture.notifications = { total: 99, items: [], salesOrder: {}, transferOrder: {} };
  const draft = hold((url) => url.pathname.endsWith("/current-draft"));
  const notifications = hold((url) => url.pathname.endsWith("/notifications"));
  await page.evaluate(() => { window.displayMetadata = Promise.all([loadCurrentDeliveryDraft(), loadDeliveryNotifications()]); });
  await Promise.all([draft.started, notifications.started]);
  fixture.draft.tranid = "New draft";
  fixture.notifications.total = 1;
  await page.evaluate(() => loadOrders({ keepSelection: true }));
  draft.release(); notifications.release(); await page.evaluate(() => window.displayMetadata);
  assert.deepEqual(await page.evaluate(() => [activeDeliveryDraft.tranid, deliveryNotifications.total]), ["New draft", 1]);
  fixture.draft.tranid = "Current draft";
  fixture.notifications.total = 2;
  await page.evaluate(() => Promise.all([loadCurrentDeliveryDraft(), loadDeliveryNotifications()]));
  assert.deepEqual(await page.evaluate(() => [activeDeliveryDraft.tranid, deliveryNotifications.total]), ["Current draft", 2]);
});

test("R5 obsolete detail errors are discarded and current errors retain the last detail", async (t) => {
  const { page, hold, fixture } = await session(t);
  const detail = (url) => url.pathname.endsWith("/GOB-120607-120608");
  const obsolete = hold(detail, true);
  await page.evaluate(() => { window.displayDetail = loadDetail(selectedId); });
  await obsolete.started;
  fixture.group.lines[0].item_description = "Latest detail";
  await page.evaluate(() => loadDetail(selectedId));
  obsolete.release();
  assert.equal(await page.evaluate(() => window.displayDetail), null);
  const current = hold(detail, true);
  await page.evaluate(() => { window.displayDetail = loadDetail(selectedId).then(() => "success", (error) => error.message); });
  await current.started; current.release();
  assert.equal(await page.evaluate(() => window.displayDetail), "Refresh unavailable");
  assert.equal(await page.evaluate(() => selectedOrder.lines[0].item_description), "Latest detail");
});

test("R5 completing a local order cannot let a prior refresh restore it", async (t) => {
  const { page, hold, fixture } = await session(t);
  const delayed = hold(bootstrap);
  await page.evaluate(() => { window.displayPending = loadOrders({ keepSelection: true }); });
  await delayed.started;
  await page.evaluate(() => { removeDeliveryOrderFromLocalState(selectedOrder); renderDeliveryPanels(); });
  delayed.release(); await idle(page);
  assert.ok(!(await state(page)).refs.includes(fixture.group.tranid));
  assert.ok(!(await page.evaluate(() => deliveryOrderBuckets.active.map((order) => order.tranid))).includes(fixture.group.tranid));
});

test("R5 marking a physical line Packed retains the local transition through prefetch", async (t) => {
  const { page, fixture, hold } = await session(t);
  fixture.group.lines = [{ ...fixture.group.lines[1], no_yard_load_required: false, quantity: 20, original_quantity: 20,
    operator_required_sales_qty: 20, linked_po_sales_qty: 0, packed_sales_qty: 20 }];
  await page.evaluate(() => loadDetail(selectedId));
  fixture.statusResult = { ...fixture.group, operator_status: "packed" };
  fixture.packed.push(fixture.statusResult);
  const delayed = hold(packedSales);
  await page.locator('[data-action="set-packed"]').click();
  await delayed.started;
  assert.ok(!(await state(page)).refs.includes(fixture.group.tranid));
  delayed.release();
  await page.waitForFunction(() => packedDeliveryPrefetch === null);
  assert.equal(await page.evaluate(() => deliveryOrderBuckets.packed.find((order) => order.netsuite_id === "GOB-120607-120608")?.operator_status), "packed");
});

test("R4 reconnecting the event stream continues to refresh the active list", async (t) => {
  const { page, fixture, hold } = await session(t);
  await page.evaluate(() => { window.oldDisplayEvents = window.displayEvents; window.displayEvents.onerror(); });
  await page.waitForFunction(() => window.oldDisplayEvents !== window.displayEvents);
  fixture.active = [fixture.group];
  const next = hold(bootstrap);
  await page.evaluate(() => window.displayEvents.emit());
  await next.started; next.release(); await idle(page);
  assert.deepEqual((await state(page)).refs, [fixture.group.tranid]);
});
