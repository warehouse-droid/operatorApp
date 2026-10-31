import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium } from "@playwright/test";

/* global orders, normalizeOrder, orderCatalog, trucks, fleet, currentPlanDate, currentPlan, compactCurrentPlan,
dispatchConfig, dispatchSetupLoaded, dispatchPlannerSnapshotState, planEditMode, ungroupBlockReason */

// The server refuses to ungroup a group whose single TO link covers several of
// its orders. The planner must say so before it changes the board.
async function blockCase(sources, run, extra = {}) {
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
    await page.evaluate(({ sources, extra }) => {
      const child = id => ({ id, type: "SO", customer: id, address: "1 Group Road", pickupLocations: ["3445"],
        items: [{ sku: "G", quantity: 1 }] });
      orders = [normalizeOrder({ ...child("GSO-LINK-1-2"), childOrders: ["SOL1", "SOL2"],
        childOrderDetails: [child("SOL1"), child("SOL2")],
        ...extra, orderDependencies: [{ id: 41, transferOrderRef: "TO-SHARED", mode: "yard_replenishment", status: "active",
          dispatchTargetRef: "GSO-LINK-1-2", dispatchTargetKind: "group",
          lines: sources.map((sourceOrderRef, index) => ({ lineRole: "sales_allocation", salesLineId: index + 1, sourceOrderRef })) }] })];
      orderCatalog = structuredClone(orders); trucks = []; fleet = [];
      currentPlanDate = "2099-11-09";
      currentPlan = compactCurrentPlan({ id: "link-plan", planDate: currentPlanDate, revision: 1, digest: "d", status: "draft" });
      dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = "ready"; planEditMode = true;
    }, { sources, extra });
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}

test("ungroup is refused before changes while one TO link covers several orders", () => blockCase(["SOL1", "SOL2"], async page => {
  assert.match(await page.evaluate(() => ungroupBlockReason("GSO-LINK-1-2")), /TO-SHARED covers SOL1 and SOL2/u);
}));

test("ungroup proceeds when the group's TO link covers one order", () => blockCase(["SOL1", "SOL1"], async page => {
  assert.equal(await page.evaluate(() => ungroupBlockReason("GSO-LINK-1-2")), "");
}));

test("ungroup is refused while another date has the group on a truck", () => blockCase(["SOL1"], async page => {
  assert.match(await page.evaluate(() => ungroupBlockReason("GSO-LINK-1-2")),
    /Cannot ungroup GSO-LINK-1-2: it is on TRK-9 Load 2 in the 2099-11-08 plan/u);
}, { dispatchPlanned: true, dispatchPlanDate: "2099-11-08", dispatchTruckPlate: "TRK-9", dispatchLoadName: "Load 2" }));
