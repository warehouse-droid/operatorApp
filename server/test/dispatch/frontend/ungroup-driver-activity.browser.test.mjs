import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium } from "@playwright/test";

/* global orders, normalizeOrder, orderCatalog, trucks, fleet, currentPlanDate, currentPlan, compactCurrentPlan,
dispatchConfig, dispatchSetupLoaded, dispatchPlannerSnapshotState, planEditMode, driverJobStatuses,
ungroupOrderWithPoCheck, routeNotice */

// The server rejects removing a stop the driver already started. Ungroup must
// refuse up front, like Group does, instead of leaving a draft every save rejects.
async function ungroupCase(activity, run) {
  const requests = [];
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
    requests.push(url.pathname);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(url.pathname.endsWith("/po-allocations") ? { allocations: [] } : {}));
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(activity => {
      const child = id => ({ id, type: "TO", customer: id, address: "1 Group Street", pickupLocations: ["3445"],
        items: [{ sku: "G", quantity: 1 }] });
      orders = [normalizeOrder({ ...child("GTO-1-2"), childOrders: ["TO1", "TO2"],
        childOrderDetails: [child("TO1"), child("TO2")] })];
      orderCatalog = structuredClone(orders);
      trucks = [{ id: "UG-TRUCK", plate: "UG-1", name: "Ungroup truck", base: "3445", loads: [{ id: "UG-LOAD",
        name: "Load 1", stops: [{ id: "pick", type: "pick", orderId: "GTO-1-2", orderRefs: ["GTO-1-2"], location: "3445" },
          { id: "drop", type: "drop", orderId: "GTO-1-2", location: "1 Group Street" }] }] }];
      fleet = structuredClone(trucks);
      currentPlanDate = "2099-11-04";
      currentPlan = compactCurrentPlan({ id: "ungroup-plan", planDate: currentPlanDate, revision: 1, digest: "d", status: "draft" });
      dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = "ready"; planEditMode = true;
      driverJobStatuses = activity ? [{ load_id: "UG-LOAD", stop_id: "pick", stop_type: "pickup", status: "complete",
        order_refs: ["GTO-1-2"] }] : [];
    }, activity);
    await run(page, requests);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}

const ungroup = page => page.evaluate(async () => ({ result: await ungroupOrderWithPoCheck("GTO-1-2"),
  notice: routeNotice, orderIds: orders.map(order => order.id), stops: trucks[0].loads[0].stops.map(stop => stop.id) }));

test("ungroup refuses a group whose load the driver already started", () => ungroupCase(true, async page => {
  const state = await ungroup(page);
  assert.equal(state.result, false);
  assert.match(state.notice, /Cannot ungroup GTO-1-2[\s\S]*driver activity has already started/u);
  assert.deepEqual(state.orderIds, ["GTO-1-2"]);
  assert.deepEqual(state.stops, ["pick", "drop"]);
}));

test("ungroup still works before the driver starts", () => ungroupCase(false, async page => {
  const state = await ungroup(page);
  assert.notEqual(state.result, false);
  assert.deepEqual(state.orderIds.sort(), ["TO1", "TO2"]);
}));
