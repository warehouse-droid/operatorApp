import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium } from "@playwright/test";

/* global orders, normalizeOrder, orderCatalog, trucks, fleet, currentPlanDate, currentPlan, compactCurrentPlan,
dispatchConfig, dispatchSetupLoaded, dispatchPlannerSnapshotState, planEditMode, selectedOrderId, selectedOrderIds,
renderSelectedOrderActions */

// Selecting a group and another order offers Group (regroup the selection)
// whichever was clicked first; Ungroup is offered for a group selected alone.
async function actionsFor(selection) {
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
    const actions = await page.evaluate(selection => {
      const order = id => ({ id, type: "SO", customer: id, address: "1 Button Road", pickupLocations: ["3445"],
        items: [{ sku: "B", quantity: 1 }] });
      orders = [normalizeOrder({ ...order("GSO-BTN-1-2"), childOrders: ["SOB1", "SOB2"],
        childOrderDetails: [order("SOB1"), order("SOB2")] }), normalizeOrder(order("SOB3"))];
      orderCatalog = structuredClone(orders); trucks = []; fleet = [];
      currentPlanDate = "2099-11-11";
      currentPlan = compactCurrentPlan({ id: "btn-plan", planDate: currentPlanDate, revision: 1, digest: "d", status: "draft" });
      dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = "ready"; planEditMode = true;
      selectedOrderId = selection[0]; selectedOrderIds = new Set(selection);
      const holder = document.createElement("div");
      holder.innerHTML = renderSelectedOrderActions();
      return [...holder.querySelectorAll("[data-action='open-group-modal'], [data-action='ungroup-order']")]
        .map(button => button.textContent.trim());
    }, selection);
    assert.deepEqual(errors, []);
    return actions;
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}

test("a group clicked first, then another order, offers Group", async () => {
  assert.deepEqual(await actionsFor(["GSO-BTN-1-2", "SOB3"]), ["Group"]);
});

test("an order clicked first, then a group, offers Group", async () => {
  assert.deepEqual(await actionsFor(["SOB3", "GSO-BTN-1-2"]), ["Group"]);
});

test("a group selected alone offers Ungroup", async () => {
  assert.deepEqual(await actionsFor(["GSO-BTN-1-2"]), ["Ungroup"]);
});
