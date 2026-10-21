import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { splitTargetOrders } from "../../support/dispatch-split-target-fixture.mjs";

test("select SOA08748, hover SOA08716, refresh controls, and split only SOA08748", async () => {
  const fixture = splitTargetOrders();
  const saves = [];
  const audits = [];
  const unsplits = [];
  const requests = [];
  let unsplitBlocked = true;
  let invalidUnsplitResponse = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push(url.pathname);
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
    if (url.pathname.endsWith("/split-seed")) { result = { nextSuffix: 1 }; }
    else if (url.pathname === "/api/dispatch/orders") { result = fixture; }
    else if (url.pathname === "/api/dispatch/split-orders/unsplit") {
      unsplits.push(payload);
      if (unsplitBlocked) {
        res.statusCode = 409;
        result = { error: "Unsplit blocked. Unplan these split orders first: SOA08748-S2" };
      } else if (invalidUnsplitResponse) {
        result = { restoredOrder: fixture[0], deactivated: [] };
      } else {
        result = { deactivated: ["SOA08748-S1", "SOA08748-S2"], restoredOrder: fixture[0], planRevision: 3, planDigest: "unsplit-ack-digest" };
      }
    }
    else if (url.pathname === "/api/dispatch/v2/plans/split-target-test/commands") {
      const saved = { ...payload.payload, baseRevision: payload.baseRevision, baseDigest: payload.baseDigest };
      saves.push(saved);
      result = { plan: { ...saved, id: "split-target-test", revision: payload.baseRevision + 1, digest: "post-unsplit-digest", status: "draft" } };
    }
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
    if (process.env.UNSPLIT_COVERAGE_DIR) { await page.coverage.startJSCoverage({ resetOnNavigation: false }); }
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(input => {
      orders = input.map(normalizeOrder);
      orders.find(order => order.id === "SOA08716").planOwned = true;
      orderCatalog = structuredClone(orders);
      trucks = []; fleet = [];
      currentPlanDate = todayLocalDate();
      currentPlan = { id: "split-target-test", planDate: currentPlanDate, revision: 1, status: "draft", orders, trucks: [] };
      dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", googleMapsEnabled: false };
      dispatchSetupLoaded = true;
      dispatchPlannerSnapshotState = "ready";
      planEditMode = true;
      planEditLeaseToken = "test-token";
      planEditLease = { active: true, sessionId: dispatchSessionId, planDate: currentPlanDate };
      selectedOrderId = "";
      selectedOrderIds = new Set();
      render({ save: false });
    }, fixture);
    const selectedCard = page.locator('.order-card[data-order="SOA08748"]');
    const unrelatedCard = page.locator('.order-card[data-order="SOA08716"]');
    await selectedCard.click();
    await expect(page.locator('[data-action="open-split-modal"]')).toHaveAttribute("data-order-ref", "SOA08748");
    await unrelatedCard.hover();
    await expect(page.locator("#orderTooltip")).toContainText("SOA08716");
    assert.equal(await page.evaluate(() => selectedOrderId), "SOA08748");
    await page.evaluate(() => renderDispatchOrderPoolPatch());
    await expect(page.locator('[data-action="open-split-modal"]')).toHaveAttribute("data-order-ref", "SOA08748");
    await page.locator('[data-action="open-split-modal"]').click();
    await expect(page.locator('[data-action="confirm-split"]')).toHaveAttribute("data-order", "SOA08748");
    await page.locator('[data-action="confirm-split"]').click();
    await expect.poll(() => saves.length).toBeGreaterThan(0);
    const saved = saves.at(-1);
    assert.deepEqual(saved.orders.map(order => order.id).sort(), ["SOA08716", "SOA08748-S1", "SOA08748-S2"]);
    assert.deepEqual(saved.orders.find(order => order.id === "SOA08716").orderDependencies, fixture[1].orderDependencies);
    assert.equal(saved.orders.filter(order => order.originalOrderId === "SOA08748")
      .reduce((sum, order) => sum + order.items[0].quantity, 0), 4);
    await expect(page.locator("[data-dispatch-route-notice]")).not.toContainText("Unlink");
    await expect(page.locator("[data-dispatch-route-notice]")).not.toContainText("backed up separately");
    await page.screenshot({ path: "test-artifacts/split-target/browser.png", fullPage: true });
    await page.locator('.order-card[data-order="SOA08717"]').click();
    await expect(page.locator('[data-action="open-split-modal"]')).toHaveAttribute("data-order-ref", "SOA08717");
    await expect(page.locator('[data-action="unsplit-order"]')).toHaveCount(0);
    await expect(page.locator('[data-action="manual-complete-order"]')).toHaveCount(0);
    await page.locator('.order-card[data-order="SOA08748-S1"]').click();
    await expect(page.locator('[data-action="unsplit-order"]')).toHaveAttribute("data-order-ref", "SOA08748-S1");
    await expect.poll(() => page.evaluate(() => !localPlanDirty && !saveInFlight && !saveQueued)).toBe(true);
    const originalDate = await page.evaluate(() => currentPlanDate);
    await page.evaluate(() => {
      document.addEventListener('click', () => { currentPlanDate = '2097-12-31'; }, { once: true });
      document.querySelector('[data-action="unsplit-order"]').click();
    });
    await expect(page.locator('[data-dispatch-route-notice]')).toContainText("The current plan changed");
    assert.equal(unsplits.length, 0);
    await page.evaluate(date => { currentPlanDate = date; render({ save: false }); }, originalDate);
    await page.locator('[data-action="unsplit-order"]').click();
    await expect(page.locator('[data-dispatch-route-notice]')).toContainText("Unplan these split orders first: SOA08748-S2");
    assert.equal(unsplits.length, 1);
    await expect(page.locator('.order-card[data-order="SOA08748-S1"]')).toBeVisible();
    await expect(page.locator('.order-card[data-order="SOA08748-S2"]')).toBeVisible();
    unsplitBlocked = false;
    invalidUnsplitResponse = true;
    await page.locator('[data-action="unsplit-order"]').click();
    await expect(page.locator('[data-dispatch-route-notice]')).toContainText("Unsplit result could not be verified");
    await expect(page.locator('.order-card[data-order="SOA08748-S1"]')).toBeVisible();
    await expect(page.locator('.order-card[data-order="SOA08748-S2"]')).toBeVisible();
    invalidUnsplitResponse = false;
    const savesBeforeUnsplit = saves.length;
    await page.locator('[data-action="unsplit-order"]').click();
    await expect.poll(() => unsplits.length).toBe(3);
    assert.equal(unsplits[2].orderRef, "SOA08748-S1");
    assert.equal(unsplits[2].orderType, "SO");
    assert.equal(unsplits[2].splitOrderIds, undefined, "the server must derive every sibling");
    await expect(page.locator('.order-card[data-order="SOA08748"]')).toBeVisible();
    await expect(page.locator('.order-card[data-order="SOA08748-S1"], .order-card[data-order="SOA08748-S2"]')).toHaveCount(0);
    await expect.poll(async () => {
      await writeFile("test-artifacts/dispatch-order-actions-20261015/browser-debug.json", JSON.stringify({ requests,
        state: await page.evaluate(() => ({ routeNotice, currentPlan, saveQueued, saveInFlight, localPlanDirty, dispatchConfig, pendingPlanMutationAction })) }, null, 2));
      return saves.length;
    }).toBeGreaterThan(savesBeforeUnsplit);
    assert.ok(saves.at(-1).orders.every(order => !order.originalOrderId));
    assert.deepEqual(saves.at(-1).retiredGlobalOrderRefs.sort(), ["SOA08748-S1", "SOA08748-S2"]);
    assert.equal(saves.at(-1).baseDigest, "unsplit-ack-digest");
    assert.equal(await page.evaluate(() => orders.find(order => order.id === "SOA08748").items[0].quantity), 4);
    assert.deepEqual(errors, []);
    if (process.env.UNSPLIT_COVERAGE_DIR) {
      const coverage = await page.coverage.stopJSCoverage();
      const result = coverage.filter(entry => entry.url.endsWith('/dispatch.js')).map(entry => ({ ...entry, url: 'file:///app/public/dispatch.js' }));
      await writeFile(process.env.UNSPLIT_COVERAGE_DIR + '/browser-unsplit-' + Date.now() + '.json', JSON.stringify({ result }));
    }
    await writeFile("test-artifacts/split-target/browser-result.json", JSON.stringify({
      selected: "SOA08748", hovered: "SOA08716", savedOrderRefs: saved.orders.map(order => order.id),
      splitAuditOrderRefs: audits.filter(entry => entry.action === "order_split").map(entry => entry.orderId),
      unsplitOrderRef: unsplits[2].orderRef,
      pageErrors: errors
    }, null, 2));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
