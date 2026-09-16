import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { compactDispatchOrderCard } from "../../../src/dispatch-planner-optimization.js";

test("SOA08768 can plan a customer pickup and yard drop while a blank destination stays blocked", async () => {
  const pickup = "145 Valleymede Dr, Richmond Hill, ON L4B 1T3";
  const destination = "2967 Kennedy Rd, Scarborough, ON M1V 1S9";
  const returnedOrder = { id: "SOA08768", type: "SO", sourceTable: "sales_orders",
    customer: "Return-trip fixture", address: destination, destinationAddress: destination,
    pickupAddressOverride: pickup, sourceAddress: pickup, sourceYard: "2967", pickupLocations: ["2967"],
    parseSource: "manual-dispatch-details", pallets: 2, salesQty: 2, weight: 100,
    items: [{ id: "line1", sku: "PAVER", itemType: "InvtPart", quantity: 2, pallets: 2 }] };
  const orders = [returnedOrder, { ...returnedOrder, id: "SO-NO-ADDRESS", address: "", destinationAddress: "" }]
    .map(compactDispatchOrderCard);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.endsWith(".js") || url.pathname.endsWith(".css")) {
      res.setHeader("Content-Type", url.pathname.endsWith(".js") ? "text/javascript" : "text/css");
      res.end(await readFile(new URL(`../../../public${url.pathname}`, import.meta.url)));
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/dispatch.css"></head><body><main id="dispatchApp"></main><script>function requireDispatchLogin() {}</script><script src="/dispatch.js"></script></body></html>');
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(url.pathname === "/api/dispatch/orders" ? orders : {}));
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(input => {
      orders = input.map(normalizeOrder);
      orderCatalog = structuredClone(orders);
      trucks = [{ id: "yard-test-truck", plate: "TEST", driverLogin: "yard-test-driver",
        loads: [{ id: "yard-test-load", name: "Return load", driverLogin: "yard-test-driver", stops: [] }] }];
      drivers = [{ login: "yard-test-driver", name: "Test Driver" }];
      currentPlanDate = todayLocalDate();
      currentPlan = { id: "yard-test-plan", planDate: currentPlanDate, revision: 1, status: "draft", orders, trucks };
      dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", driverOrientedPlanning: true, googleMapsEnabled: false };
      dispatchSetupLoaded = true;
      dispatchPlannerSnapshotState = "ready";
      planEditMode = true;
      planEditLeaseToken = "test-token";
      planEditLease = { active: true, sessionId: dispatchSessionId, planDate: currentPlanDate };
      app.innerHTML = renderOrderPool();
    }, orders);
    const returnCard = page.locator('.order-card[data-order="SOA08768"]');
    await expect(returnCard).not.toContainText("Missing delivery address");
    await expect(returnCard).not.toContainText("Update address");
    await expect(page.locator('.order-card[data-order="SO-NO-ADDRESS"]')).toContainText("Missing delivery address");
    const result = await page.evaluate(() => {
      const added = addOrderToLoad("SOA08768", "yard-test-load");
      const load = trucks[0].loads[0];
      const plannedStops = load.stops.map(stop => ({ type: stop.type, address: stopAddress(stop, orderById(stop.orderId)) }));
      const beforeBlank = JSON.stringify(load.stops);
      const blankAdded = addOrderToLoad("SO-NO-ADDRESS", "yard-test-load");
      return { added, plannedStops, blankAdded, blankMutatedStops: beforeBlank !== JSON.stringify(load.stops), notice: routeNotice };
    });
    assert.equal(result.added, true, result.notice);
    assert.deepEqual(result.plannedStops, [{ type: "pick", address: pickup }, { type: "drop", address: destination }]);
    assert.equal(result.blankAdded, false);
    assert.equal(result.blankMutatedStops, false);
    assert.match(result.notice, /SO-NO-ADDRESS needs a delivery address/);
    assert.deepEqual(errors, []);
    await mkdir("test-artifacts/yard-destination", { recursive: true });
    await returnCard.screenshot({ path: "test-artifacts/yard-destination/return-order-card.png" });
    await writeFile("test-artifacts/yard-destination/browser-result.json", JSON.stringify({ ...result, pageErrors: errors }, null, 2));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
