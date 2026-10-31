import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium } from "@playwright/test";

/* global orders, normalizeOrder, orderCatalog, trucks, fleet, currentPlanDate, currentPlan, compactCurrentPlan,
dispatchConfig, dispatchSetupLoaded, dispatchPlannerSnapshotState, planEditMode, ungroupOrder, orderById,
splitOrderPlanningBlock, splitSiblingsForOrder */

// Members of a group on a load carry the group's assignment. Ungrouping takes
// the group off the load, so the members return unplanned, as Unsplit does.
test("ungrouped members return unplanned and can be unsplit at once", async () => {
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
    const result = await page.evaluate(() => {
      const planned = { dispatchPlanned: true, dispatchPlanId: "plan-9", dispatchPlanDate: "2099-11-10",
        dispatchTruckPlate: "TRK-1", dispatchLoadName: "Load 1", plannedOrderRef: "GSO-PLAN-1" };
      const split = id => ({ id, type: "SO", originalOrderId: "SOP", customer: "C", address: "1 Plan Road",
        pickupLocations: ["3445"], items: [{ sku: "P", quantity: 1 }], ...planned });
      orders = [normalizeOrder({ ...split("GSO-PLAN-1"), originalOrderId: "", childOrders: ["SOP-S1", "SOP-S2"],
        childOrderDetails: [split("SOP-S1"), split("SOP-S2")] })];
      orderCatalog = structuredClone(orders); fleet = [];
      trucks = [{ id: "t1", plate: "TRK-1", loads: [{ id: "l1", name: "Load 1",
        stops: [{ id: "drop-g", type: "drop", orderId: "GSO-PLAN-1" }] }] }];
      currentPlanDate = "2099-11-10";
      currentPlan = compactCurrentPlan({ id: "plan-9", planDate: currentPlanDate, revision: 1, digest: "d", status: "draft" });
      dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = "ready"; planEditMode = true;
      ungroupOrder("GSO-PLAN-1");
      const child = orderById("SOP-S1");
      return { planned: [child.dispatchPlanned, child.dispatchPlanDate, child.dispatchLoadName, child.plannedOrderRef],
        unsplit: splitOrderPlanningBlock(splitSiblingsForOrder(child)) };
    });
    assert.deepEqual(result, { planned: [false, "", "", ""], unsplit: "" });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
