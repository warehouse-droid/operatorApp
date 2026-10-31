import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium } from "@playwright/test";

/* global orders, normalizeOrder, orderCatalog, trucks, fleet, currentPlanDate, currentPlan, compactCurrentPlan,
dispatchConfig, dispatchSetupLoaded, dispatchPlannerSnapshotState, lastAcknowledgedPlanState, dispatchPlanWireState,
transferLinkPlanBlock */

// The server lets a grouped TO link be changed only from the plan that holds
// the group. Link TO must follow that owner, not a stale plan id or blank date.
async function ownerCase(run) {
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
    await page.evaluate(() => {
      const child = id => ({ id, type: "SO", customer: id, address: "1 Owner Road", pickupLocations: ["3445"],
        items: [{ sku: "O", quantity: 1 }] });
      const group = (id, extra) => normalizeOrder({ ...child(id), childOrders: [`${id}-A`, `${id}-B`],
        childOrderDetails: [child(`${id}-A`), child(`${id}-B`)], ...extra });
      orders = [
        group("GSO-MIRROR", { groupPlanId: "5", groupPlanDate: "2099-11-08" }),
        group("GSO-FOREIGN", { globalGroupDefinition: true, globalGroupSourcePlanDate: "2099-11-01", groupPlanId: "", groupPlanDate: "" }),
        group("GSO-NEW", { groupPlanId: "9", groupPlanDate: "2099-11-08" }),
        normalizeOrder(child("SO-PLAIN"))
      ];
      orderCatalog = structuredClone(orders); trucks = []; fleet = [];
      const plan = { id: "9", planDate: "2099-11-08", revision: 1, digest: "d", status: "draft",
        orders: [orders[0]], trucks: [] };
      currentPlanDate = plan.planDate; currentPlan = compactCurrentPlan(plan);
      lastAcknowledgedPlanState = dispatchPlanWireState(plan);
      dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = "ready";
    });
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}

test("a group saved in this plan opens Link TO despite a mirrored plan id", () => ownerCase(async page => {
  assert.equal(await page.evaluate(() => transferLinkPlanBlock(orders.find(order => order.id === "GSO-MIRROR"))), "");
}));

test("a group owned by another date names that date", () => ownerCase(async page => {
  const block = await page.evaluate(() => transferLinkPlanBlock(orders.find(order => order.id === "GSO-FOREIGN")));
  assert.match(block, /GSO-FOREIGN belongs to the 2099-11-01 plan/u);
}));

test("a new group of this plan and a plain order open Link TO", () => ownerCase(async page => {
  assert.deepEqual(await page.evaluate(() => ["GSO-NEW", "SO-PLAIN"]
    .map(id => transferLinkPlanBlock(orders.find(order => order.id === id)))), ["", ""]);
}));

test("the Link TO action uses the plan owner check", async () => {
  const source = await readFile(new URL("../../../public/dispatch.js", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf('if (action === "open-to-link-modal")'));
  assert.match(handler.slice(0, 400), /transferLinkPlanBlock\(targetOrder\)/u);
});
