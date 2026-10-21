import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";

import { sourceSplit } from "../support/unfinished-sales-resplit-fixture.js";
import test from "node:test";
import { chromium, expect } from "@playwright/test";


for (const scenario of ["open", "packed", "closed", "failed", "reopened", "date_changed", "refresh"]) {
 test(`split dialog appears before its status response and handles ${scenario}`, async () => {
  const source = sourceSplit();
  const first = { ...structuredClone(source), id: "SOA09143-S1", dispatchPlanningRestricted: true,
    dispatchCompletionStatus: "completed", items: source.items.map((item, index) => ({ ...item, quantity: index ? 1 : 30 })) };
  const fixture = [source, first];
  const historyTrucks = [{ id: "history", loads: [{ id: "completed", stops: [{ id: "s1-drop", type: "drop",
    orderId: first.id, location: first.address, driverStatus: "complete" }] }] }];
  let previewCount = 0;
  let releasePreview;
  const heldPreview = new Promise(resolve => { releasePreview = resolve; });

  const saves = [];
  const attemptedMutations = [];

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
    if (url.pathname.includes('/resplit') || url.pathname.endsWith('/split-seed')) attemptedMutations.push(url.pathname);
    if (url.pathname.endsWith('/split-preview') || (url.pathname === '/api/dispatch/orders' && url.searchParams.has('search'))) {
      const previewSequence = ++previewCount;
      await heldPreview;
      if (scenario === 'failed') { res.statusCode = 503; result = { error: 'Preview unavailable' }; }
      else { result = { id: source.id, type: 'SO', operatorStatus: scenario === 'packed' || (scenario === 'reopened' && previewSequence === 1) || (scenario === 'refresh' && previewSequence > 1) ? 'packed' : 'open',
        localYardOrderStatus: 'Open', items: source.items }; }
    }
    else if (url.pathname === "/api/dispatch/orders") { result = fixture; }
    else if (url.pathname === "/api/dispatch/driver-job-statuses") { result = [{ job_id: "s1-completed", load_id: "completed",
      stop_id: "s1-drop", stop_type: "dropoff", order_refs: ["SOA09143-S1"], status: "complete" }]; }
    else if (url.pathname === "/api/dispatch/plans/split-target-test" && req.method === "PUT") {
      saves.push(payload);
      result = { ...payload, id: "split-target-test", revision: 2, status: "draft" };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    if (process.env.SPLIT_FAST_COVERAGE_DIR) { await page.coverage.startJSCoverage({ resetOnNavigation: false }); }
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
    await expect(page.locator('.dispatch-modal')).toBeVisible({ timeout: 1000 });
    await expect(page.locator('[data-action="confirm-split"]')).toBeDisabled();
    await expect(page.locator('[data-split-status-loading]')).toContainText('Checking');
    await page.evaluate(() => {
      const pending = document.querySelector('[data-action="confirm-split"]');
      pending.disabled = false;
      pending.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      pending.disabled = true;
    });
    assert.equal(attemptedMutations.length, 0, 'Pending status must block confirmation even if the DOM disabled state is stale.');
    if (scenario === 'refresh') {
      releasePreview();
      await expect(page.locator('[data-action="confirm-split"]')).toBeEnabled();
      await page.evaluate(() => runQueuedDispatchOrderPoolRefresh());
      await expect(page.locator('.dispatch-modal')).toContainText('already packed');
      await expect(page.locator('[data-action="confirm-split"]')).toHaveCount(0);
    } else if (scenario === 'date_changed') {
      await page.evaluate(() => { currentPlanDate = '2097-10-21'; });
      releasePreview();
      await expect(page.locator('.dispatch-modal')).toHaveCount(0);
    } else if (scenario === 'reopened') {
      await page.locator('.dispatch-modal [data-action="close-modal"]').first().click();
      await page.locator('[data-action="open-split-modal"]').click();
      releasePreview();
      await expect(page.locator('[data-action="confirm-split"]')).toBeEnabled();
      await expect(page.locator('.dispatch-modal')).not.toContainText('already packed');
    } else if (scenario === 'closed') {
      await page.locator('.dispatch-modal [data-action="close-modal"]').first().click();
      releasePreview();
      await expect(page.locator('.dispatch-modal')).toHaveCount(0);
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => modalType), '');
    } else {
      releasePreview();
      if (scenario === 'packed') {
        await expect(page.locator('.dispatch-modal')).toContainText('already packed');
        await expect(page.locator('[data-action="confirm-split"]')).toHaveCount(0);
      } else if (scenario === 'failed') {
        await expect(page.locator('.dispatch-modal')).toContainText('Preview unavailable');
        await expect(page.locator('[data-action="confirm-split"]')).toBeDisabled();
      } else {
        await expect(page.locator('[data-action="confirm-split"]')).toBeEnabled();
        await expect(page.locator('.split-item-editor')).toContainText('106 EA');
      }
    }
    assert.deepEqual(await page.evaluate(() => JSON.parse(JSON.stringify(planPayload().trucks))), beforeTrucks);
    assert.equal(saves.length, 0);
    assert.deepEqual(errors, []);
    if (process.env.SPLIT_FAST_COVERAGE_DIR) {
      const coverage = await page.coverage.stopJSCoverage();
      const result = coverage.filter(entry => entry.url.endsWith('/dispatch.js')).map(entry => ({ ...entry, url: 'file:///app/public/dispatch.js' }));
      await writeFile(process.env.SPLIT_FAST_COVERAGE_DIR + '/browser-fast-' + scenario + '-' + Date.now() + '.json', JSON.stringify({ result }));
    }
  } finally {
    releasePreview();
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});

}
