import assert from "node:assert/strict";
import test, { after } from "node:test";
import { writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { app } from "../../../src/server.js";
import { config } from "../../../src/config.js";
import { query, closeDb } from "../../../src/db.js";
import { updateOperatorPassword, loginOperator } from "../../../src/auth-repository.js";
import { planningFixture, command, run, storedPlan } from "../support/bin-planning-fixtures.js";
after(closeDb);

async function fixture(offset) {
  const f = await planningFixture(offset);
  const input = await command(f, "assign");
  await run(f, "save_board", { loads: [{ id: f.binLoadIds[0], name: "BIN Load 1", truckId: f.binTruckId,
    driverId: f.driverId, startMode: "fixed", start: "07:00", driverSequence: 0,
    plannedStartMinute: 420, plannedFinishMinute: 480,
    visits: [{ visitId: f.frontVisitId, expectedVisitRevision: input.expectedVisitRevision,
      assetAssignments: input.assetAssignments,
      stopTimings: [{ sequence: 1, arrival: 420, depart: 435 }, { sequence: 2, arrival: 455, depart: 480 }],
      stopOverrides: [{ sequence: 1, minutes: 15 }, { sequence: 2, minutes: 25 }] }] }] });
  const plan = await storedPlan(f.planId);
  plan.orders = [1, 2].map(n => ({ id: `CUSTOM-INSPECT-${n}`, type: "CUSTOM", customer: `Inspection customer ${n}`,
    address: "200 Inspection Street", pickupLocations: ["12441"], sourceYard: "12441",
    pallets: n, weightLbs: 1200 * n, travelMinutes: 20, windowStart: "09:00", windowEnd: "18:00",
    notes: `Delivery instruction ${n}`, localDispatchStatus: "open", planOwned: true,
    items: [{ sku: `Inspection material ${n}`, description: `Inspection material ${n}`, quantity: n, unit: "EA", lineWeight: 1200 * n }] }));
  const ordinary = plan.trucks[1].loads[0];
  Object.assign(ordinary, { startMode: "fixed", start: "15:00", driverSequence: 2,
    plannedStartMinute: 900, plannedFinishMinute: 990,
    stops: [
      { id: "inspect-pick", type: "pick", orderId: plan.orders[0].id, location: "12441" },
      ...plan.orders.map((order, i) => ({ id: `inspect-drop-${i}`, type: "drop", orderId: order.id, stopTimeOverrideMinutes: 25 }))
    ].map(stop => ({ ...stop, loadId: ordinary.id })) });
  plan.trucks[1].loads.push({ id: "inspect-return", name: "Manual Return", truckId: f.flatbedTruckId,
    truckPlate: ordinary.truckPlate, driverLogin: f.driverLogin, driverId: f.driverId, driverSequence: 3,
    returnOnly: true, manual: true, endingTrip: true, returnYard: "12441", startMode: "auto", stops: [] });
  await query("UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb, orders=$3::jsonb WHERE plan_id=$1",
    [f.planId, JSON.stringify(plan.trucks), JSON.stringify(plan.orders)]);
  await updateOperatorPassword(f.actor.operatorId, "readonly-browser-test-password");
  const token = (await loginOperator(f.actor.operatorId, "readonly-browser-test-password")).token;
  config.mbt.enabled = true; config.mbtPhase3.binDispatchEnabled = true; config.dispatch.driverOrientedPlanning = true;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ('mbt_enabled','mbt_bin_dispatch')");
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  context.setDefaultTimeout(8000);
  await context.addInitScript(({ token, f }) => {
    localStorage.setItem("mbbs.staff.token", token);
    sessionStorage.setItem("mbbs.dispatch.sessionId", f.editLease.sessionId);
    sessionStorage.setItem("mbbs.dispatch.editLease.v1", JSON.stringify({ planDate: f.planDate,
      sessionId: f.editLease.sessionId, editLeaseToken: f.editLease.token, expiresAt: new Date(Date.now() + 600000).toISOString() }));
  }, { token, f });
  const page = await context.newPage(); const errors = [];
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  page.on("pageerror", error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { f, page, errors, async open(path) {
    await page.goto(`${url}${path}?planDate=${f.planDate}`);
    await expect.poll(() => page.evaluate(() => isDispatchPlanEditor())).toBe(true);
  }, async close() {
    try {
      await writeFile(`test-artifacts/readonly-coverage-${offset}.json`, JSON.stringify(await page.coverage.stopJSCoverage()));
    } finally {
      try { await browser.close(); }
      finally { await new Promise(resolve => server.close(resolve)); }
    }
  } };
}

async function hoverText(page, target) {
  await target.hover();
  await expect(page.locator("#orderTooltip")).toHaveClass(/tooltip/);
  return page.locator("#orderTooltip").innerText();
}
async function details(page) {
  const preview = page.locator(".load-preview-panel");
  return Promise.all([".preview-stop-list", ".preview-details-grid", ".timing-detail-list", ".assigned-order-list"]
    .map(selector => preview.locator(selector).innerText()));
}
async function assertLocked(page, card) {
  assert.equal(await card.locator('[draggable="true"]').count(), 0);
  assert.equal(await card.getAttribute("draggable"), "false");
  const active = await card.locator("input:enabled, select:enabled, button:enabled").evaluateAll(elements => elements.map(el => el.dataset.action));
  assert.deepEqual(active, ["select-load"]);
  const firstStop = card.locator('.stop-card[data-stop]').first();
  if (await firstStop.count()) {
    await firstStop.click();
    await expect(page.locator('.load-preview-panel')).toBeVisible();
    await page.locator('[data-action="close-load-preview"]').click();
  }
  await card.locator('[data-action="select-load"]').click();
  const preview = page.locator(".load-preview-panel");
  await expect(preview).toContainText("Read only");
  assert.deepEqual(await preview.locator("input:enabled, select:enabled, button:enabled").evaluateAll(elements => elements.map(el => el.dataset.action)),
    ["close-load-preview", "toggle-sequence"]);
  await preview.getByRole("button", { name: "Collapse", exact: true }).click();
  await expect(preview.locator(".preview-stop-list")).toHaveClass(/collapsed/);
  await preview.getByRole("button", { name: "Expand", exact: true }).click();
  await preview.locator('[data-action="clear-load"]').dispatchEvent("click");
  await preview.locator('[data-action="delete-load"]').dispatchEvent("click");
  await preview.locator('[data-load-start]').evaluate(el => { el.value = "23:00"; el.dispatchEvent(new Event("change", { bubbles: true })); });
  const route = await page.evaluate(async () => {
    const { truck, load } = selectedLoad();
    const estimate = await googleRouteForLoad(truck, load, { reason: 'manual_refresh' });
    if (globalThis.MbbsBinPlanning) optimizeSelectedRoute();
    return { estimate, queued: routeLoadsNeedingEstimate().some(entry => entry.load.id === load.id) };
  });
  assert.deepEqual(route, { estimate: null, queued: false });
  assert.equal(await page.locator(".modal-overlay").count(), 0);
}

test("read-only Dispatch loads in BIN reuse exact card, hover and preview information without writes", { timeout: 120000 }, async () => {
  const env = await fixture(2400); const { page, f } = env;
  try {
    await env.open("/dispatch/planning");
    // Persist the shared renderer's timing as fixture data; Custom Order creation
    // and its stable identity validator belong to separate integration tests.
    const timedTrucks = await page.evaluate(() => trucksWithTimingMetadata());
    await query("UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1", [f.planId, JSON.stringify(timedTrucks)]);
    await env.open("/dispatch/planning");
    assert.equal(await page.evaluate(() => localPlanDirty), false, await page.evaluate(() => routeNotice));
    const card = page.locator(`[data-load-card="${f.flatbedLoadId}"]`);
    const sequence = await card.locator(".stop-list").innerText();
    const loadTooltip = await hoverText(page, card.locator(".load-title"));
    const stopTooltip = await hoverText(page, card.locator('[data-stop="inspect-drop-0"]'));
    assert.match(stopTooltip, /Inspection material 1/);
    await card.locator('[data-action="select-load"]').click();
    const expectedDetails = await details(page);
    await env.open("/mbt/planning");
    const before = await page.evaluate(() => JSON.stringify(trucks));
    const persisted = await storedPlan(f.planId);
    const writes = [];
    page.on("request", req => { if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method()) && /\/api\/(mbt\/planning\/commands|dispatch\/plans)/.test(req.url())) writes.push(req.url()); });
    await expect(card).toContainText("Read only");
    await expect(card).toHaveCSS("background-color", "rgb(238, 240, 243)");
    assert.equal(await card.locator("a").count(), 0);
    assert.equal(await card.locator(".stop-list").innerText(), sequence);
    assert.equal(await hoverText(page, card.locator(".load-title")), loadTooltip);
    assert.equal(await hoverText(page, card.locator('[data-stop="inspect-drop-0"]')), stopTooltip);
    await expect(card.locator("[data-load-truck]")).toHaveValue(f.flatbedTruckId);
    const transition = page.locator(`[data-truck-switch-for="${f.flatbedLoadId}"]`);
    await expect(transition).toContainText("Truck Switch");
    await expect(transition.locator(".truck-switch-plates")).toContainText("P3B");
    await expect(transition.locator(".truck-switch-plates")).toContainText("P3F");
    await expect(transition.locator(".truck-switch-stop")).toContainText("Switch");
    await expect(transition.locator("[data-load-switch-yard]")).toBeDisabled();
    await assertLocked(page, card);
    assert.deepEqual(await details(page), expectedDetails);
    await page.evaluate(() => renderDispatchPlannerPatch());
    assert.equal(await page.evaluate(() => selectedLoadId), f.flatbedLoadId);
    await page.screenshot({ path: "test-artifacts/readonly-dispatch-preview.png", fullPage: true });
    await page.locator('[data-action="close-load-preview"]').click();
    await assertLocked(page, page.locator('[data-driver-load-card="inspect-return"]'));
    await expect(page.locator(".load-preview-panel")).toContainText("Return yard");
    await page.locator('[data-action="close-load-preview"]').click();
    await card.locator('[data-stop="inspect-drop-0"]').dispatchEvent("dblclick");
    assert.ok(page.url().includes("/mbt/planning"));
    await card.locator(".stop-list").dispatchEvent("drop", { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
    assert.equal(await page.evaluate(() => JSON.stringify(trucks)), before);
    assert.equal(await page.evaluate(() => localPlanDirty), false);
    assert.deepEqual(await storedPlan(f.planId), persisted);
    assert.deepEqual(writes, []); assert.deepEqual(env.errors, []);
  } finally { await env.close(); }
});

test("BIN planning preserves Dispatch stop times and load intervals when service estimates change", { timeout: 120000 }, async () => {
  const env = await fixture(2403); const { page, f } = env;
  try {
    await env.open("/dispatch/planning");
    const timedTrucks = await page.evaluate(() => trucksWithTimingMetadata());
    await query("UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1", [f.planId, JSON.stringify(timedTrucks)]);
    const ordinary = timedTrucks.find(truck => truck.id === f.flatbedTruckId);
    const persisted = await storedPlan(f.planId);
    await env.open("/mbt/planning");
    const actual = await page.evaluate(truckId => {
      // A different route fallback or updated driver defaults must not stretch
      // Dispatch's saved loads while their start times remain fixed.
      for (const driver of drivers) Object.assign(driver, {
        ownYardFixedMinutes: 240, vendorFixedMinutes: 240, deliveryFixedMinutes: 240, minutesPerPallet: 50
      });
      const before = JSON.stringify(trucks);
      const truck = trucks.find(item => item.id === truckId);
      const result = truck.loads.map(load => {
        const stats = loadStats(truck, load);
        return { id: load.id, start: stats.start, finish: stats.finish,
          rows: stats.rows.filter(Boolean).map(row => ({ id: row.stop.id, arrival: row.arrival, depart: row.depart })) };
      });
      return { result, conflict: localDispatchLoadAssignmentConflict(), unchanged: before === JSON.stringify(trucks) };
    }, f.flatbedTruckId);
    assert.deepEqual(actual.result, ordinary.loads.map(load => ({ id: load.id,
      start: load.plannedStartMinute, finish: load.plannedFinishMinute,
      rows: load.stops.map(stop => ({ id: stop.id, arrival: stop.timing.arrival, depart: stop.timing.depart })) })));
    assert.equal(actual.conflict, null);
    assert.equal(actual.unchanged, true);
    assert.deepEqual(await storedPlan(f.planId), persisted);
    assert.deepEqual(env.errors, []);
  } finally { await env.close(); }
});

test("Dispatch can inspect BIN stops and saved timing through the shared preview with MBT disabled", { timeout: 120000 }, async () => {
  const env = await fixture(2401); const { page, f } = env;
  try {
    config.mbt.enabled = false; config.mbtPhase3.binDispatchEnabled = false;
    const mbtRequests = [];
    page.on("request", req => { if (req.url().includes("/api/mbt/")) mbtRequests.push(req.url()); });
    await env.open("/dispatch/planning");
    const before = await page.evaluate(() => JSON.stringify(trucks));
    const persisted = await storedPlan(f.planId);
    const card = page.locator(`[data-load-card="${f.binLoadIds[0]}"]`);
    await expect(card.locator(".stop-card[data-stop]")).toHaveCount(2);
    assert.equal(await card.locator("a").count(), 0);
    await expect(card).toContainText("Collect empty 14YD bin");
    await expect(card).toContainText("Deliver empty 14YD bin");
    await expect(card).toContainText("100 Test Route");
    await expect(card).toContainText("07:35");
    assert.match(await hoverText(page, card.locator(".load-title")), /08:00/);
    assert.match(await hoverText(page, card.locator(".stop-card[data-stop]").last()), /100 Test Route/);
    await assertLocked(page, card);
    const preview = page.locator(".load-preview-panel");
    await expect(preview).toContainText("Maps Preview");
    await expect(preview).toContainText("Plan, Forecast, Actual and Variance");
    await expect(preview.locator(".preview-stop-list")).toContainText("07:35");
    await expect(preview.locator(".assigned-order-list")).not.toContainText("No assigned orders");
    await page.screenshot({ path: "test-artifacts/readonly-bin-preview.png", fullPage: true });
    await page.locator('[data-action="close-load-preview"]').click();
    assert.equal(await page.evaluate(() => JSON.stringify(trucks)), before);
    assert.equal(await page.evaluate(() => localPlanDirty), false);
    assert.deepEqual(await storedPlan(f.planId), persisted);
    assert.deepEqual(mbtRequests, []); assert.deepEqual(env.errors, []);
  } finally { await env.close(); config.mbt.enabled = true; config.mbtPhase3.binDispatchEnabled = true; }
});

test("BIN planning shows a driver's assigned flatbed followed by the shared flatbed-to-BIN truck switch", { timeout: 120000 }, async () => {
  const env = await fixture(2402); const { page, f } = env;
  try {
    const plan = await storedPlan(f.planId);
    const bin = plan.trucks[0].loads[0];
    Object.assign(bin, { driverSequence: 4, start: "18:00", startTime: "18:00", plannedStartMinute: 1080, plannedFinishMinute: 1140 });
    bin.stops.forEach(stop => { stop.timing.arrival += 660; stop.timing.depart += 660; });
    await query("UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1", [f.planId, JSON.stringify(plan.trucks)]);
    const persisted = await storedPlan(f.planId);
    await env.open("/mbt/planning");
    const lane = page.locator(`[data-driver-lane="${f.driverLogin}"]`);
    await expect(lane.locator(`[data-load-card="${f.flatbedLoadId}"] [data-load-truck]`)).toHaveValue(f.flatbedTruckId);
    await expect(lane.locator(`[data-load-card="${f.binLoadIds[0]}"] [data-load-truck]`)).toHaveValue(f.binTruckId);
    const transition = lane.locator(`[data-truck-switch-for="${f.binLoadIds[0]}"]`);
    assert.match(await transition.locator(".truck-switch-plates").innerText(), /P3F.*→.*P3B/);
    await expect(transition.locator(".truck-switch-stop")).toContainText("Switch");
    await expect(transition.locator("[data-load-switch-yard]")).toBeEnabled();
    await page.screenshot({ path: "test-artifacts/readonly-flatbed-to-bin-switch.png", fullPage: true });
    assert.equal(await page.evaluate(() => localPlanDirty), false);
    assert.deepEqual(await storedPlan(f.planId), persisted);
    assert.deepEqual(env.errors, []);
    await page.evaluate(() => releaseDispatchEditMode());
    let releaseAdoption; let releaseSearch; let adoptionStarted;
    const adoptionGate = new Promise(resolve => { releaseAdoption = resolve; });
    const searchGate = new Promise(resolve => { releaseSearch = resolve; });
    const started = new Promise(resolve => { adoptionStarted = resolve; });
    let requests = 0;
    await page.route('**/api/mbt/planning?*', async route => {
      if (new URL(route.request().url()).searchParams.get('planDate') === '2099-12-09') {
        requests++;
        if (requests === 1) { adoptionStarted(); await adoptionGate; }
        else await searchGate;
      }
      await route.continue();
    });
    const navigation = page.evaluate(() => loadPlanForDate('2099-12-09', { createIfMissing: false }));
    try {
      await started;
      await page.evaluate(() => { globalThis.readonlySearchDuringNavigation = loadDispatchOrders(); });
      releaseAdoption();
      await navigation;
      assert.equal(await page.evaluate(() => mbtBinDispatchFeed.planDate), '2099-12-09');
    } finally {
      releaseAdoption(); releaseSearch();
      await page.evaluate(() => globalThis.readonlySearchDuringNavigation);
    }
  } finally { await env.close(); }
});
