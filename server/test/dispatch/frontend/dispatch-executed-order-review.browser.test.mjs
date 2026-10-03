import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium, expect } from "@playwright/test";

test("Dispatch warns without blocking save, confirms explicitly, and rejects a blank address", async () => {
  const address = "15 Snowy Meadow Ave, Richmond Hill, ON L4E 3V3";
  const member = { id: "SOA08930", type: "SO", address, items: [], pallets: 0 };
  const order = { id: "GOA-8930-8931", type: "SO", address, customer: "Group", childOrders: [member.id], childOrderDetails: [member], items: [], pallets: 0, isGrouped: true };
  const reviews = [{ token: "a".repeat(64), orderRef: "TOB01111", acknowledged: false, sourceAvailable: true,
    message: "Source information differs from the recorded plan.", contexts: [{ driverName: "Li", driverLogin: "li", truckPlate: "CC46868", loadName: "Load 2", stopId: "drop" }],
    changes: [{ message: "PER-MM80S-2237-SCG — item removed: 326.48 SQFT → blank" }, { message: "PALLET — quantity: 29 → 25 EACH" }, { message: "<img src=x onerror=window.reviewInjected=true>" }] }];
  const saves = []; const acknowledgements = []; const details = [];
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
    let body = ""; for await (const chunk of req) {body += chunk;}
    const payload = body ? JSON.parse(body) : {};
    let result = {};
    if (url.pathname === "/api/dispatch/orders") {result = [order];}
    if (url.pathname.endsWith("executed-order-reviews")) {
      if (req.method === "POST") { acknowledgements.push(payload); reviews[0].acknowledged = true; }
      result = { reviews };
    }
    if (url.pathname.endsWith("/details")) { details.push(payload); result = { updated: { dispatch_address: payload.address } }; }
    if (url.pathname === "/api/dispatch/plans/review-test" && req.method === "PUT") {
      saves.push(payload); result = { ...payload, id: "review-test", revision: saves.length + 1, status: "draft" };
    }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result));
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(input => {
      orders = [normalizeOrder(input)]; orderCatalog = structuredClone(orders); trucks = []; fleet = [];
      currentPlanDate = todayLocalDate(); currentPlan = { id: "review-test", planDate: currentPlanDate, revision: 1, status: "draft", orders, trucks: [] };
      dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = "ready"; planEditMode = true;
      planEditLeaseToken = "test-token"; planEditLease = { active: true, sessionId: dispatchSessionId, planDate: currentPlanDate };
      localPlanDirty = true; render({ save: false });
    }, order);
    await page.evaluate(async () => { await loadExecutedOrderReviews(); renderDispatchNoticePatch(); });
    await page.locator('[data-executed-source-review] summary').click();
    await expect(page.locator('[data-executed-source-review]')).toContainText("TOB01111");
    await expect(page.locator('[data-executed-source-review]')).toContainText("326.48 SQFT");
    await expect(page.locator('[data-executed-source-review]')).toContainText("CC46868");
    assert.equal(await page.evaluate(() => Boolean(window.reviewInjected)), false);
    await page.evaluate(() => saveCurrentPlanNow());
    assert.equal(saves.length, 1, "save succeeds while warning awaits confirmation");
    assert.equal(acknowledgements.length, 0, "save cannot acknowledge the warning");
    await expect(page.locator('[data-action="confirm-executed-source-update"]')).toBeVisible();
    await page.screenshot({ path: "test-artifacts/executed-order-review/warning.png" });
    await page.locator('[data-action="confirm-executed-source-update"]').click();
    await expect(page.locator('[data-action="confirm-executed-source-update"]')).toHaveCount(0);
    assert.equal(acknowledgements[0].confirm, true);
    assert.equal(saves.length, 1, "confirmation does not resubmit or replace the draft");
    await page.evaluate(input => { orders = [normalizeOrder(input)]; orderCatalog = structuredClone(orders); render({ save: false }); }, order);
    await page.locator('.order-card[data-order="GOA-8930-8931"]').dblclick();
    const form = page.locator('[data-form="edit-order-details"]');
    await form.locator('[name="address"]').fill(" ");
    await form.locator('button[type="submit"]').click();
    await expect(form).toContainText("GOA-8930-8931: delivery address cannot be blank");
    assert.equal(details.length, 0);
    const kept = await page.evaluate(input => {
      const next = structuredClone(input); next.address = ""; next.childOrderDetails[0].address = "";
      return mergeFreshDispatchOperationalOrder(input, next, { all: new Set(), pickups: new Set(), drops: new Set() });
    }, order);
    assert.equal(kept.address, address); assert.equal(kept.childOrderDetails[0].address, address);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
