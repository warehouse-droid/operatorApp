import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium, expect } from "@playwright/test";

test("SOA09326 shows 195 Milner and saves a separate pickup in the real Dispatch page", async () => {
  const address = "195 Milner Ave, Scarborough, ON M1S 3R1";
  const orders = ["SOA09464", "SOA09326"].map((id, index) => ({ id, type: "SO", customer: id,
    sourceYard: "2967", pickupLocations: ["2967"], pickupAddressOverride: index ? address : "",
    sourceAddress: index ? address : "2967 Kennedy Road, Toronto, ON", address: `${id} Customer Road`,
    pallets: 1, items: [{ sku: id, itemType: "InvtPart", quantity: 20, pallets: 1 }] }));
  const saves = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (/\.(js|css)$/u.test(url.pathname)) {
      res.setHeader("Content-Type", url.pathname.endsWith(".js") ? "text/javascript" : "text/css");
      return res.end(await readFile(new URL(`../../../public${url.pathname}`, import.meta.url)));
    }
    if (!url.pathname.startsWith("/api/")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end('<link rel="stylesheet" href="/dispatch.css"><main id="dispatchApp"></main><script>function requireDispatchLogin() {}</script><script src="/dispatch-address-guard.js"></script><script src="/dispatch.js"></script>');
    }
    let body = ""; for await (const chunk of req) { body += chunk; }
    let result = {};
    if (url.pathname === "/api/dispatch/orders") result = orders;
    if (url.pathname === "/api/dispatch/plans/pickup-test" && req.method === "PUT") {
      const payload = JSON.parse(body); saves.push(payload);
      result = { ...payload, id: "pickup-test", revision: saves.length + 1, status: "draft" };
    }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result));
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(input => {
      orders = input.map(normalizeOrder); orderCatalog = structuredClone(orders);
      drivers = [{ name: "Aurther", login: "aurther" }];
      const load = { id: "LOAD", name: "Load 2", pickupVisitSchemaVersion: 1, stops: [] };
      trucks = [{ id: "T", plate: "BL27129", driver: "Aurther", driverLogin: "aurther", base: "2967", loads: [load] }];
      fleet = structuredClone(trucks);
      currentPlanDate = todayLocalDate(); currentPlan = { id: "pickup-test", planDate: currentPlanDate, revision: 1, status: "draft", orders, trucks };
      dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = "ready"; planEditMode = true;
      planEditLeaseToken = "test-token"; planEditLease = { active: true, sessionId: dispatchSessionId, planDate: currentPlanDate };
      localPlanDirty = true; render({ save: false });
    }, orders);
    await expect(page.locator('.order-card[data-order="SOA09326"]')).toContainText(`Pickup ${address}`);
    const route = await page.evaluate(() => {
      if (!addOrderToLoad("SOA09464", "LOAD") || !addOrderToLoad("SOA09326", "LOAD")) throw new Error(routeNotice);
      normalizePlanBeforeSave(); render({ save: false });
      return trucks[0].loads[0].stops.filter(stop => stop.type === "pick").map(stop => ({
        orderRefs: stop.orderRefs, location: stop.location, place: resolveStopPlace(stop, stopOrder(stop))
      }));
    });
    assert.equal(route.length, 2);
    assert.deepEqual(route.map(stop => stop.orderRefs), [["SOA09464"], ["SOA09326"]]);
    assert.equal(route[1].place.address, address);
    assert.equal(route[1].location, "2967");
    await page.evaluate(async () => { await saveCurrentPlanNow(); });
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0].trucks[0].loads[0].stops.filter(stop => stop.type === "pick").map(stop => stop.orderRefs), [["SOA09464"], ["SOA09326"]]);
    const regrouped = await page.evaluate(() => {
      // Exercise the same save preparation used after editing a shared visit.
      const load = trucks[0].loads[0];
      const picks = load.stops.filter(stop => stop.type === "pick");
      load.stops = load.stops.filter(stop => stop !== picks[1]);
      picks[0].orderRefs.push("SOA09326");
      normalizePlanBeforeSave();
      return load.stops.filter(stop => stop.type === "pick").map(stop => stop.orderRefs);
    });
    assert.deepEqual(regrouped, [["SOA09464"], ["SOA09326"]]);
    const split = await page.evaluate(() => {
      const third = { ...structuredClone(orderById("SOA09464")), id: "SO-THIRD" };
      orders.push(third);
      if (!addOrderToLoad(third.id, "LOAD")) throw new Error(routeNotice);
      const load = trucks[0].loads[0];
      const visits = load.stops.filter(stop => stop.type === "pick");
      const before = JSON.stringify(load.stops);
      const options = pickupSplitDestinationOptions(load, visits[0], [third.id]);
      const accepted = splitPickupVisit(load.id, visits[0].id, [third.id], `target:${visits[1].id}`);
      return { accepted, unchanged: before === JSON.stringify(load.stops),
        invalidOption: options.some(option => option.value === `target:${visits[1].id}`) };
    });
    assert.deepEqual(split, { accepted: false, unchanged: true, invalidOption: false });
    await mkdir("test-artifacts/pickup-override", { recursive: true });
    await page.screenshot({ path: "test-artifacts/pickup-override/dispatch.png" });
    await writeFile("test-artifacts/pickup-override/browser-coverage.json", JSON.stringify(await page.coverage.stopJSCoverage()));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
