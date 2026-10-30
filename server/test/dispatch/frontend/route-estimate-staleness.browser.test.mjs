import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium } from "@playwright/test";

/* global orders, normalizeOrder, orderCatalog, trucks, fleet, currentPlanDate, currentPlan, compactCurrentPlan,
dispatchConfig, dispatchSetupLoaded, dispatchPlannerSnapshotState, routeEstimates, mapStopsForLoad,
routeEstimateMeta, routeLegMinutesForLoad, loadStats, trucksWithTimingMetadata, estimateForLoad */

// A cached Google estimate carries one travel leg per gap between the stops it
// was computed for. Distinctive leg values make reuse on another stop order visible.
async function routeCase(run) {
  const errors = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.endsWith(".js")) {
      res.setHeader("Content-Type", "text/javascript");
      res.end(await readFile(new URL(`../../../public${url.pathname}`, import.meta.url))); return;
    }
    if (!url.pathname.startsWith("/api/")) {
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><main id="dispatchApp"></main><script>function requireDispatchLogin() {}</script><script src="/dispatch-edit-activity.js"></script><script src="/dispatch.js"></script>'); return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
      const order = (id, address) => normalizeOrder({ id, type: "SO", customer: id, address, pickupLocations: ["3445"],
        sourceYard: "3445", pallets: 1, salesQty: 1, weight: 100, catalogHydrated: true,
        items: [{ sku: "ROUTE", itemName: "Route test", quantity: 1, pallets: 1 }] });
      orders = [order("SOR1", "10 First Street, Toronto, ON"), order("SOR2", "20 Second Street, Toronto, ON"),
        order("SOR3", "30 Third Street, Toronto, ON")];
      orderCatalog = structuredClone(orders);
      const loads = [{ id: "ROUTE-LOAD", name: "Load 1", stops: [
        { id: "pick", type: "pick", orderId: "SOR1", orderRefs: ["SOR1", "SOR2", "SOR3"], location: "3445" },
        ...orders.map(item => ({ id: `drop-${item.id}`, type: "drop", orderId: item.id, location: item.address }))
      ] }];
      trucks = [{ id: "ROUTE-TRUCK", plate: "ROUTE", name: "Route truck", base: "3445", capacity: 24, loads }];
      fleet = structuredClone(trucks);
      currentPlanDate = "2099-11-02";
      currentPlan = compactCurrentPlan({ id: "route-plan", planDate: currentPlanDate, revision: 1, digest: "d", status: "draft" });
      dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = "ready";
      const truck = trucks[0], load = truck.loads[0];
      const stops = mapStopsForLoad(load, truck);
      const meta = routeEstimateMeta(truck, load, stops);
      const legs = stops.slice(1).map((_, index) => 111 * (index + 1));
      routeEstimates[load.id] = { source: "google", legMinutes: legs, rawLegMinutes: legs, stayMinutes: 0,
        driveMinutes: legs.reduce((sum, value) => sum + value, 0), totalMinutes: legs.reduce((sum, value) => sum + value, 0),
        routeSignature: meta.signature, routeEstimateId: meta.id };
    });
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}

const span = stats => stats.finish - stats.start;

test("a matching estimate supplies the Google leg times", () => routeCase(async page => {
  const result = await page.evaluate(() => ({ legs: routeLegMinutesForLoad(trucks[0].loads[0]),
    span: loadStats(trucks[0], trucks[0].loads[0]).finish - loadStats(trucks[0], trucks[0].loads[0]).start }));
  assert.deepEqual(result.legs.slice(0, 2), [111, 222]);
  assert.ok(result.span >= 111 + 222 + 333, `span ${result.span}`);
}));

test("reordering drops stops reusing legs computed for the old stop order", () => routeCase(async page => {
  const result = await page.evaluate(() => {
    const truck = trucks[0], load = truck.loads[0];
    load.stops = [load.stops[0], load.stops[3], load.stops[1], load.stops[2]];
    const stats = loadStats(truck, load);
    const saved = trucksWithTimingMetadata()[0].loads[0];
    return { legs: routeLegMinutesForLoad(load), estimate: estimateForLoad(load), stats: { start: stats.start, finish: stats.finish },
      saved: { routeEstimate: saved.routeEstimate || null, start: saved.plannedStartMinute, finish: saved.plannedFinishMinute } };
  });
  assert.deepEqual(result.legs, []);
  assert.equal(result.estimate, null);
  assert.ok(span(result.stats) < 333, `span ${span(result.stats)} still uses stale legs`);
  assert.equal(result.saved.routeEstimate, null);
  assert.equal(result.saved.finish - result.saved.start, span(result.stats));
}));

test("a changed stop time keeps the driving legs of the same route", () => routeCase(async page => {
  const result = await page.evaluate(() => {
    const truck = trucks[0], load = truck.loads[0];
    orders.find(order => order.id === "SOR2").pallets = 9;
    orders.find(order => order.id === "SOR2").items[0].pallets = 9;
    return { legs: routeLegMinutesForLoad(load) };
  });
  assert.deepEqual(result.legs.slice(0, 2), [111, 222]);
}));

test("removing a drop stops reusing the old leg list", () => routeCase(async page => {
  const result = await page.evaluate(() => {
    const truck = trucks[0], load = truck.loads[0];
    load.stops = load.stops.filter(stop => stop.id !== "drop-SOR2");
    load.stops[0].orderRefs = ["SOR1", "SOR3"];
    const stats = loadStats(truck, load);
    return { legs: routeLegMinutesForLoad(load), start: stats.start, finish: stats.finish };
  });
  assert.deepEqual(result.legs, []);
  assert.ok(span(result) < 333, `span ${span(result)} still uses stale legs`);
}));
