import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { buildSalesResplits } from "../../../src/dispatch-sales-resplit-repository.js";
import { sourceSplit } from "../support/unfinished-sales-resplit-fixture.js";
import test from "node:test";
import { chromium, expect } from "@playwright/test";


for (const rejected of [false, true]) {
 test(rejected ? "failed resplit preserves the selected S2, S1 and route" : "reuse the existing split action for S2, create S3-S5, and preserve the completed S1 route", async () => {
  const source = sourceSplit();
  const first = { ...structuredClone(source), id: "SOA09143-S1", dispatchPlanningRestricted: true,
    dispatchCompletionStatus: "completed", items: source.items.map((item, index) => ({ ...item, quantity: index ? 1 : 30 })) };
  const fixture = [source, first];
  const historyTrucks = [{ id: "history", loads: [{ id: "completed", stops: [{ id: "s1-drop", type: "drop",
    orderId: first.id, location: first.address, driverStatus: "complete" }] }] }];
  let postedParts;
  const unsplits = [];

  const saves = [];
  const audits = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.endsWith(".js") || url.pathname.endsWith(".css")) {
      res.setHeader("Content-Type", url.pathname.endsWith(".js") ? "text/javascript" : "text/css");
      res.end(await readFile(new URL(`../../../public${url.pathname}`, import.meta.url)));
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/dispatch.css"></head><body><main id="dispatchApp"></main><script>function requireDispatchLogin() {}</script><script src="/dispatch-edit-activity.js"></script><script src="/dispatch.js"></script></body></html>');
      return;
    }
    let body = "";
    for await (const chunk of req) { body += chunk; }
    const payload = body ? JSON.parse(body) : {};
    let result = {};
    if (url.pathname.endsWith('/split-preview')) {
      const ref = decodeURIComponent(url.pathname.split('/').at(-2));
      const order = fixture.find(candidate => candidate.id === ref);
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(order)); return;
    }
    if (url.pathname === "/api/dispatch/split-orders/resplit") {
      postedParts = payload.parts;
      if (rejected) {
        res.statusCode = 409; res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'SOA09143-S2 is packed. Reopen or unpack it first.' })); return;
      }
      result = { orders: buildSalesResplits(source, payload.parts, 3), retiredGlobalOrderRefs: [source.id] };
    } else if (url.pathname === "/api/dispatch/split-orders/unsplit") {
      unsplits.push(payload);
      result = { restoredOrder: source, deactivated: ["SOA09143-S3", "SOA09143-S4", "SOA09143-S5"], planRevision: 3 };
    } else if (url.pathname === "/api/dispatch/v2/order-feed/SOA09143-S2") { result = { order: source }; }
    else if (url.pathname.endsWith("/split-seed")) { result = { nextSuffix: 3 }; }
    else if (url.pathname === "/api/dispatch/orders") { result = fixture; }
    else if (url.pathname === "/api/dispatch/driver-job-statuses") { result = [{ job_id: "s1-completed", load_id: "completed",
      stop_id: "s1-drop", stop_type: "dropoff", order_refs: ["SOA09143-S1"], status: "complete" }]; }
    else if (url.pathname === "/api/dispatch/plans/split-target-test" && req.method === "PUT") {
      saves.push(payload);
      result = { ...payload, id: "split-target-test", revision: 2, status: "draft" };
    } else if (url.pathname.includes("audit")) {
      audits.push(payload);
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript(() => {
      window.EventSource = class {
        constructor() { window.unsplitEventSource = this; }
        addEventListener(name, listener) { if (name === 'app-event') { this.handler = listener; } }
        close() {}
      };
    });
    if (process.env.RESPLIT_COVERAGE_DIR) { await page.coverage.startJSCoverage({ resetOnNavigation: false }); }
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(input => {
      orders = input.orders.map(normalizeOrder);
      orderCatalog = structuredClone(orders);
      trucks = input.trucks; fleet = [];
      driverJobStatuses = [{ job_id: "s1-completed", load_id: "completed", stop_id: "s1-drop", stop_type: "dropoff",
        order_refs: ["SOA09143-S1"], status: "complete", started_at: "2026-10-02T12:00:00Z", completed_at: "2026-10-02T16:00:00Z" }];
      currentPlanDate = todayLocalDate();
      currentPlan = { id: "split-target-test", planDate: currentPlanDate, revision: 1, status: "draft", orders, trucks };
      dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = "ready"; planEditMode = true;
      planEditLeaseToken = "test-token";
      planEditLease = { active: true, sessionId: dispatchSessionId, planDate: currentPlanDate };
      selectedOrderId = "SOA09143-S2"; selectedOrderIds = new Set([selectedOrderId]);
      render({ save: false });
    }, { orders: fixture, trucks: historyTrucks });
    const beforeTrucks = await page.evaluate(() => JSON.parse(JSON.stringify(planPayload().trucks)));
    const actions = page.locator('.selected-order-actions');
    await expect(actions.locator('[data-action="open-split-modal"], [data-action="unsplit-order"]')).toHaveCount(2);
    await expect(actions.locator('[data-action="unsplit-order"]')).toHaveAttribute("data-order-ref", "SOA09143-S2");
    await expect(actions.locator('[data-action="open-split-modal"]')).toHaveAttribute("data-order-ref", "SOA09143-S2");
    await actions.locator('[data-action="open-split-modal"]').click();
    await expect(page.locator('[data-action="confirm-split"]')).toHaveAttribute("data-order", "SOA09143-S2");
    await page.locator('#splitParts').fill('3');
    await page.locator('#splitParts').dispatchEvent('input');
    await expect(page.locator('.split-item-editor')).toContainText('106 EA');
    await page.locator('[data-action="confirm-split"]').click();
    if (rejected) {
      await expect(page.locator('[data-dispatch-route-notice]')).toContainText('is packed');
      assert.equal(saves.length, 0);
      const remaining = await page.evaluate(() => orders.find(order => order.id === 'SOA09143-S2'));
      assert.equal(remaining.items[0].quantity, 106);
      assert.deepEqual(await page.evaluate(() => JSON.parse(JSON.stringify(planPayload().trucks))), beforeTrucks);
      if (process.env.RESPLIT_COVERAGE_DIR) {
        const coverage = await page.coverage.stopJSCoverage();
        const result = coverage.filter(entry => entry.url.endsWith('/dispatch.js')).map(entry => ({ ...entry, url: 'file:///app/public/dispatch.js' }));
        await writeFile(process.env.RESPLIT_COVERAGE_DIR + '/browser-resplit-failure-' + Date.now() + '.json', JSON.stringify({ result }));
      }
      return;
    }
    await expect.poll(() => saves.length).toBeGreaterThan(0);
    const saved = saves.at(-1);
    assert.deepEqual(saved.orders.map(order => order.id).sort(), ['SOA09143-S1', 'SOA09143-S3', 'SOA09143-S4', 'SOA09143-S5']);
    assert.deepEqual(saved.trucks, beforeTrucks);
    assert.equal(postedParts.length, 3);
    assert.equal(postedParts.flatMap(part => part.items).filter(item => item.lineId === 1).reduce((sum, item) => sum + item.quantity, 0), 106);
    const state = await page.evaluate(() => orders.find(order => order.id === 'SOA09143-S1'));
    assert.equal(state.dispatchCompletionStatus, 'completed');
    assert.equal(state.items[0].quantity, 30);
    await page.locator('[data-action="unsplit-order"]').click();
    await expect.poll(() => unsplits.length).toBe(1);
    assert.equal(unsplits[0].orderRef, "SOA09143-S3");
    await expect(page.locator('.order-card[data-order="SOA09143-S2"]')).toBeVisible();
    await expect.poll(() => saves.at(-1).retiredGlobalOrderRefs?.sort()).toEqual(["SOA09143-S3", "SOA09143-S4", "SOA09143-S5"]);
    assert.ok(saves.at(-1).orders.every(order => !["SOA09143-S3", "SOA09143-S4", "SOA09143-S5"].includes(order.id)));
    assert.deepEqual(saves.at(-1).trucks, beforeTrucks);
    assert.equal(await page.evaluate(() => orders.find(order => order.id === "SOA09143-S2").items[0].quantity), 106);
    await page.evaluate(() => {
      setAuthoritativeOrderRetirement("SOA09143-S2", true);
      connectEvents();
      window.unsplitEventSource.handler({ data: JSON.stringify({ type: "dispatch.orders.updated", payload: {
        change: "order_unsplit", sourceSessionId: "another-computer", reactivatedGlobalOrderRefs: ["SOA09143-S2"],
        retiredGlobalOrderRefs: ["SOA09143-S3", "SOA09143-S4", "SOA09143-S5"]
      } }) });
    });
    await expect.poll(() => page.evaluate(() => isAuthoritativelyRetiredOrderRef("SOA09143-S2"))).toBe(false);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: 'test-artifacts/unfinished-split-20261012/browser.png', fullPage: true });
    if (process.env.RESPLIT_COVERAGE_DIR) {
      const coverage = await page.coverage.stopJSCoverage();
      const result = coverage.filter(entry => entry.url.endsWith('/dispatch.js')).map(entry => ({ ...entry, url: 'file:///app/public/dispatch.js' }));
      await writeFile(process.env.RESPLIT_COVERAGE_DIR + '/browser-resplit-' + Date.now() + '.json', JSON.stringify({ result }));
    }
    await writeFile('test-artifacts/unfinished-split-20261012/browser-result.json', JSON.stringify({
      savedOrderRefs: saved.orders.map(order => order.id), completedS1Retained: true, unsplitAvailable: true, pageErrors: errors
    }, null, 2));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});

}
