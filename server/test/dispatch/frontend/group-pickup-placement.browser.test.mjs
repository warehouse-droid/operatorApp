import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium } from "@playwright/test";
import { validateDispatchPickupVisits } from "../../../src/dispatch-pickup-visits.js";

/* global orders, normalizeOrder, orderCatalog, trucks, fleet, currentPlanDate, currentPlan, compactCurrentPlan,
dispatchConfig, dispatchSetupLoaded, dispatchPlannerSnapshotState, planEditMode, selectedOrderIds, groupOrder,
normalizePlanBeforeSave, removeStopsForOrders, ungroupOrder, routeNotice */

async function pickupCase(stops, run) {
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
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(stops => {
      const order = (id, address) => normalizeOrder({ id, type: "SO", customer: id, address, pickupLocations: ["3445"],
        sourceYard: "3445", pallets: 2, salesQty: 2, catalogHydrated: true, itemCount: 1,
        items: [{ sku: id, itemId: id, quantity: 2, pallets: 2 }] });
      orders = [order("SOPA1", "1 Same Site Road"), order("SOPA2", "1 Same Site Road"), order("SOPC3", "9 Other Road")];
      orderCatalog = structuredClone(orders);
      trucks = [{ id: "PK-TRUCK", plate: "PK-1", name: "Pickup truck", base: "3445",
        loads: [{ id: "PK-LOAD", name: "Load 1", pickupVisitSchemaVersion: 1, stops }] }];
      fleet = structuredClone(trucks);
      currentPlanDate = "2099-11-06";
      currentPlan = compactCurrentPlan({ id: "pickup-plan", planDate: currentPlanDate, revision: 1, digest: "d", status: "draft" });
      dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = "ready"; planEditMode = true;
    }, stops);
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}

const pick = (id, refs) => ({ id, type: "pick", orderId: refs[0], orderRefs: refs, location: "3445" });
const drop = (id, orderId, location) => ({ id, type: "drop", orderId, location });
const shape = load => load.stops.map(stop => [stop.type, stop.orderId, stop.orderRefs || null]);

test("grouping two trips from the same yard leaves no pickup after the grouped drop", () => pickupCase([
  pick("p1", ["SOPA1"]), drop("d1", "SOPA1", "1 Same Site Road"),
  pick("p2", ["SOPA2"]), drop("d2", "SOPA2", "1 Same Site Road")
], async page => {
  const plan = await page.evaluate(() => {
    selectedOrderIds = new Set(["SOPA1", "SOPA2"]);
    if (!groupOrder()) throw new Error(`Grouping refused: ${routeNotice}`);
    normalizePlanBeforeSave();
    return { orders, trucks };
  });
  const stops = plan.trucks[0].loads[0].stops;
  const dropIndex = stops.findIndex(stop => stop.type === "drop");
  assert.equal(stops.slice(dropIndex + 1).some(stop => stop.type === "pick"), false, JSON.stringify(shape(plan.trucks[0].loads[0])));
  assert.deepEqual(validateDispatchPickupVisits(plan), []);
}));

test("removing an order keeps a pickup visit it shares with another order", () => pickupCase([
  pick("p1", ["SOPA1", "SOPC3"]), drop("d1", "SOPA1", "1 Same Site Road"), drop("d3", "SOPC3", "9 Other Road")
], async page => {
  const plan = await page.evaluate(() => {
    removeStopsForOrders(["SOPA1"]);
    normalizePlanBeforeSave();
    return { orders, trucks };
  });
  assert.deepEqual(shape(plan.trucks[0].loads[0]), [["pick", "SOPC3", ["SOPC3"]], ["drop", "SOPC3", null]]);
  assert.equal(plan.trucks[0].loads[0].stops[0].id, "p1");
}));

test("ungrouping keeps a pickup visit the group shares with another order", () => pickupCase([
  pick("p1", ["SOPA1", "SOPA2", "SOPC3"]), drop("d1", "SOPA1", "1 Same Site Road"), drop("d2", "SOPA2", "1 Same Site Road"),
  drop("d3", "SOPC3", "9 Other Road")
], async page => {
  const plan = await page.evaluate(() => {
    selectedOrderIds = new Set(["SOPA1", "SOPA2"]);
    if (!groupOrder()) throw new Error(`Grouping refused: ${routeNotice}`);
    normalizePlanBeforeSave();
    const groupId = [...selectedOrderIds][0];
    ungroupOrder(groupId);
    normalizePlanBeforeSave();
    return { orders, trucks };
  });
  const load = plan.trucks[0].loads[0];
  assert.equal(load.stops[0].id, "p1");
  assert.deepEqual(load.stops[0].orderRefs, ["SOPC3"]);
  assert.deepEqual(validateDispatchPickupVisits(plan), []);
}));
