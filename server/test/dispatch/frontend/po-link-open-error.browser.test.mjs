import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium } from "@playwright/test";

/* global orders, normalizeOrder, orderCatalog, trucks, fleet, currentPlanDate, currentPlan, compactCurrentPlan,
dispatchConfig, dispatchSetupLoaded, dispatchPlannerSnapshotState, planEditMode, poAllocationError,
localPlanDirty, saveQueued, saveInFlight */

// Opening Link PO first saves pending edits, then loads the link options. Only
// a failed save is about saving; a failed options load must say so.
async function openWith(failure) {
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
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(failure => {
      orders = [normalizeOrder({ id: "SOPOERR", type: "SO", customer: "C", address: "1 Error Road", pickupLocations: ["3445"],
        items: [{ sku: "E", quantity: 1 }] })];
      orderCatalog = structuredClone(orders); trucks = []; fleet = [];
      currentPlanDate = "2099-11-12";
      currentPlan = compactCurrentPlan({ id: "err-plan", planDate: currentPlanDate, revision: 1, digest: "d", status: "draft" });
      dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = "ready"; planEditMode = true;
      localPlanDirty = failure === "save"; saveQueued = false; saveInFlight = false;
      window.ensureDispatchPlanEditor = () => true;
      window.saveCurrentPlanNow = async () => { throw new Error("plan revision changed"); };
      window.loadPoAllocationOptions = async () => { throw new Error("SOPOERR is closed in NetSuite"); };
      const button = document.createElement("button");
      button.dataset.action = "open-po-link-modal";
      button.dataset.orderRef = "SOPOERR";
      document.querySelector("#dispatchApp").append(button);
      button.click();
    }, failure);
    await page.waitForFunction(() => Boolean(poAllocationError));
    return await page.evaluate(() => poAllocationError);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}

test("a failed PO options load is not reported as an unsaved split", async () => {
  const message = await openWith("options");
  assert.doesNotMatch(message, /Save the split/u);
  assert.match(message, /SOPOERR is closed in NetSuite/u);
});

test("a failed save before Link PO still asks to save first", async () => {
  assert.match(await openWith("save"), /Save the plan before linking a PO: plan revision changed/u);
});
