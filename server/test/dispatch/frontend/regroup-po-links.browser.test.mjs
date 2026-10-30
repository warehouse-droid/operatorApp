import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium } from "@playwright/test";

/* global orders, normalizeOrder, orderCatalog, trucks, fleet, currentPlanDate, currentPlan, compactCurrentPlan,
dispatchConfig, dispatchSetupLoaded, dispatchPlannerSnapshotState, planEditMode, confirmGroupPoLinkRemoval, routeNotice */

// Regrouping retires the old group, and retirement cancels the PO links made
// on that group. The dispatcher must see and accept that, as for Ungroup.
async function regroupCase(allocationResponse, run) {
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
    if (url.pathname.endsWith("/po-allocations")) {
      res.statusCode = allocationResponse.status || 200;
      res.end(JSON.stringify(allocationResponse.body)); return;
    }
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
      const child = id => ({ id, type: "SO", customer: id, address: "1 Group Street", pickupLocations: ["3445"],
        items: [{ sku: "G", quantity: 1 }] });
      orders = [normalizeOrder({ ...child("GSO-1-2"), childOrders: ["SO1", "SO2"],
        childOrderDetails: [child("SO1"), child("SO2")] }), normalizeOrder(child("SO3"))];
      orderCatalog = structuredClone(orders); trucks = []; fleet = [];
      currentPlanDate = "2099-11-03";
      currentPlan = compactCurrentPlan({ id: "regroup-plan", planDate: currentPlanDate, revision: 1, digest: "d", status: "draft" });
      dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = "ready"; planEditMode = true;
    });
    await run(page, requests);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}

const ask = (page, answer) => page.evaluate(async answer => {
  const prompts = [];
  window.confirm = message => { prompts.push(message); return answer; };
  return { proceed: (await confirmGroupPoLinkRemoval(["GSO-1-2"], "Regroup")).proceed, prompts };
}, answer);

test("regrouping a group with PO links asks before those links are removed", () =>
  regroupCase({ body: { allocations: [{ id: 7, poOrderRef: "PO-77" }] } }, async (page, requests) => {
    const declined = await ask(page, false);
    assert.equal(declined.proceed, false);
    assert.equal(declined.prompts.length, 1);
    assert.match(declined.prompts[0], /GSO-1-2[\s\S]*1 PO allocation[\s\S]*PO-77[\s\S]*remove/u);
    assert.ok(requests.some(path => path === "/api/dispatch/orders/GSO-1-2/po-allocations"));
    assert.equal((await ask(page, true)).proceed, true);
  }));

test("regrouping a group without PO links needs no confirmation", () =>
  regroupCase({ body: { allocations: [] } }, async page => {
    const result = await ask(page, false);
    assert.equal(result.proceed, true);
    assert.deepEqual(result.prompts, []);
  }));

test("a failed PO check leaves the groups unchanged", () =>
  regroupCase({ status: 409, body: { error: "SO1 is closed in NetSuite" } }, async page => {
    const result = await ask(page, true);
    assert.equal(result.proceed, false);
    assert.deepEqual(result.prompts, []);
    assert.match(await page.evaluate(() => routeNotice), /Unable to check PO allocations for GSO-1-2/u);
  }));

test("the regroup action checks PO links before building the new group", async () => {
  const source = await readFile(new URL("../../../public/dispatch.js", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf('if (action === "confirm-group")'));
  assert.ok(handler.indexOf("confirmGroupPoLinkRemoval(") > 0);
  assert.ok(handler.indexOf("confirmGroupPoLinkRemoval(") < handler.indexOf("groupOrder(button.dataset.order)"));
});
