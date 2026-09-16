import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium, expect } from "@playwright/test";

test("edit S2 in the real browser, save, refresh the feed, and retain two delivery visits", async () => {
  const mossbrook = "94 Mossbrook Crescent, Scarborough, ON M1W 2W9";
  const heatherside = "76 Heatherside Dr, Scarborough, ON M1W 1T7";
  const orders = ["SOA08751", "SOA08748-S1", "SOA08748-S2"].map(id => ({ id, type: "SO", sourceTable: "sales_orders",
    customer: "Address browser fixture", address: mossbrook, destinationAddress: mossbrook,
    defaultDestinationAddress: mossbrook, planOwned: true, pallets: 1, salesQty: 4, weight: 40,
    items: [{ id: "line1", quantity: 4 }], ...(id.includes("-S") ? { originalOrderId: "SOA08748", isSplit: true } : {}) }));
  const edits = [];
  const saves = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.endsWith(".js") || url.pathname.endsWith(".css")) {
      res.setHeader("Content-Type", url.pathname.endsWith(".js") ? "text/javascript" : "text/css");
      res.end(await readFile(new URL(`../../../public${url.pathname}`, import.meta.url)));
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end('<!doctype html><html><body><main id="dispatchApp"></main><script>function requireDispatchLogin() {}</script><script src="/dispatch.js"></script></body></html>');
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = body ? JSON.parse(body) : {};
    let result = {};
    if (url.pathname === "/api/dispatch/orders") result = orders;
    if (url.pathname.endsWith("/SOA08748-S2/details") && req.method === "PUT") {
      edits.push(payload);
      const target = orders[2];
      Object.assign(target, { address: payload.address, destinationAddress: payload.address,
        defaultDestinationAddress: payload.address, dispatchDetailsOverride: { address: payload.address } });
      result = { updated: { dispatch_address: payload.address, dispatch_details_override: target.dispatchDetailsOverride } };
    }
    if (url.pathname === "/api/dispatch/plans/split-address-test" && req.method === "PUT") {
      saves.push(payload);
      result = { ...payload, id: "split-address-test", revision: saves.length + 1, status: "draft" };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(input => {
      orders = input.map(normalizeOrder);
      orderCatalog = structuredClone(orders);
      trucks = []; fleet = [];
      currentPlanDate = todayLocalDate();
      currentPlan = { id: "split-address-test", planDate: currentPlanDate, revision: 1, status: "draft", orders, trucks: [] };
      dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", googleMapsEnabled: false };
      dispatchSetupLoaded = true;
      dispatchPlannerSnapshotState = "ready";
      planEditMode = true;
      planEditLeaseToken = "test-token";
      planEditLease = { active: true, sessionId: dispatchSessionId, planDate: currentPlanDate };
      localPlanDirty = true;
      render({ save: false });
    }, orders);
    await page.locator('.order-card[data-order="SOA08748-S2"]').dblclick();
    const form = page.locator('[data-form="edit-order-details"]');
    await expect(form).toBeVisible();
    await form.locator('[name="address"]').fill(heatherside);
    await form.locator('button[type="submit"]').click();
    await expect.poll(() => edits.length).toBe(1);
    await expect(form).toHaveCount(0);
    await expect.poll(() => saves.length).toBeGreaterThan(1);
    assert.equal(edits[0].address, heatherside);
    const visits = await page.evaluate(fresh => {
      mergeDispatchOrderSearchFeed(fresh);
      const refs = ["SOA08751", "SOA08748-S1", "SOA08748-S2"];
      return consecutiveExactDropVisits(refs.map(orderId => ({ type: "drop", orderId })))
        .map(visit => ({ address: visit.address, refs: visit.entries.map(entry => entry.order.id) }));
    }, orders);
    assert.deepEqual(visits, [{ address: mossbrook, refs: ["SOA08751", "SOA08748-S1"] }, { address: heatherside, refs: ["SOA08748-S2"] }]);
    assert.deepEqual(errors, []);
    await writeFile("test-artifacts/split-address/browser-result.json", JSON.stringify({ edits: edits.length, saves: saves.length, visits, pageErrors: errors }, null, 2));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
