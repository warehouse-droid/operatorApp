import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import v8ToIstanbul from "v8-to-istanbul";

test("real Dispatch buttons protect, accept and acknowledge without blocking a same-day adjustment", async () => {
  const member = { id: "SOA09704", type: "SO", address: "Toronto", salesQty: 160,
    items: [{ lineId: 5074432, itemId: 123, sku: "BWS-PW-REG-GM", quantity: 110, unit: "PC" },
      { lineId: 5074433, itemId: 123, sku: "BWS-PW-REG-GM", quantity: 50, unit: "PC" }] };
  const sibling = { id: "SOA09731", type: "SO", address: "Toronto", salesQty: 16, items: [] };
  const group = { id: "GOA-9704-9731", type: "SO", address: "Toronto", customer: "Group", salesQty: 176,
    childOrders: [member.id, sibling.id], childOrderDetails: [member, sibling], items: member.items, isGrouped: true };
  const fresh = { ...group, salesQty: 126, items: member.items.slice(0, 1),
    childOrderDetails: [{ ...member, salesQty: 110, items: member.items.slice(0, 1) }, sibling] };
  const notice = { token: "a".repeat(64), orderRef: member.id, groupRef: group.id,
    acknowledged: true, decisionRequired: true, sourceAvailable: true,
    sourceModifiedAt: "2026-10-06T13:38:00Z", sourceReceivedAt: "2026-10-06T13:38:21Z",
    contexts: [{ driverName: "Aurther", driverLogin: "aurther", truckPlate: "BL27129", loadName: "Load 2", stopId: "drop" }],
    changes: [{ message: "BWS-PW-REG-GM obsolete 50 PC line removed" }] };
  let reviews = [notice];
  let revision = 12;
  const decisions = [], saves = [], requestedRevisions = [];
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
    let body = "";
    for await (const chunk of req) {body += chunk;}
    const payload = body ? JSON.parse(body) : {};
    let result = {};
    if (url.pathname === "/api/dispatch/orders") {result = [group];}
    if (url.pathname.endsWith("executed-order-reviews")) {
      if (req.method === "POST") {
        decisions.push(payload);
        reviews = reviews.map(review => ({ ...review, acknowledged: true, decisionRequired: false,
          decision: payload.decision || review.decision, acknowledgedBy: "Dispatcher" }));
        if (payload.decision === "accept_netsuite_change") {revision += 1;}
      } else {requestedRevisions.push(url.searchParams.get("baseRevision"));}
      const selected = reviews[0]?.decision === "accept_netsuite_change" ? fresh : group;
      result = { reviews, orderRefs: [member.id], orders: [selected],
        plan: { id: "review-test", revision, digest: `digest-${revision}`, safeToAdvanceRevision: true } };
    }
    if (url.pathname === "/api/dispatch/plans/review-test" && req.method === "PUT") {
      saves.push(payload); revision += 1;
      result = { ...payload, id: "review-test", revision, status: "draft" };
    }
    if (url.pathname === "/api/dispatch/v2/plans/review-test/commands" && req.method === "POST") {
      saves.push(payload); revision += 1;
      result = { plan: { ...payload.payload, id: "review-test", revision, status: "draft", orders: [fresh], trucks: [],
        digest: `digest-${revision}` } };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });
  let browser, page;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(input => {
      orders = [normalizeOrder(input)]; orderCatalog = structuredClone(orders); trucks = []; fleet = [];
      orders[0].childOrderDetails[1].notes = "unsaved sibling note";
      currentPlanDate = todayLocalDate(); currentPlan = { id: "review-test", planDate: currentPlanDate, revision: 12, status: "draft", orders: structuredClone(orders), trucks: [] };
      dispatchConfig = { plannerOrderPoolMode: "off", plannerCommandMode: "off", googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = "ready"; planEditMode = true;
      planEditLeaseToken = "test-token"; planEditLease = { active: true, sessionId: dispatchSessionId, planDate: currentPlanDate };
      localPlanDirty = true; render({ save: false });
    }, group);
    await page.evaluate(async () => { await loadExecutedOrderReviews({ force: true }); renderDispatchNoticePatch(); });
    await page.locator('[data-executed-source-review] summary').click();
    await expect(page.locator('[data-executed-source-review]')).toContainText("BL27129");
    await expect(page.locator('[data-executed-source-review]')).toContainText("9:38");
    await page.locator('[data-action="protect-executed-source-update"]').click();
    await expect(page.locator('[data-action="protect-executed-source-update"]')).toHaveCount(0);
    assert.equal(decisions[0].decision, "protect_driver_work");
    assert.equal(decisions[0].baseRevision, 12);
    assert.equal(await page.evaluate(() => orders[0].childOrderDetails[0].items.length), 2);
    reviews = [{ ...notice, token: "b".repeat(64), acknowledged: false }];
    await page.evaluate(async () => { await loadExecutedOrderReviews({ force: true }); renderDispatchNoticePatch(); });
    await page.locator('[data-executed-source-review] summary').click();
    await page.locator('[data-review-decision="accept_netsuite_change"]').click();
    await expect(page.locator('[data-review-decision="accept_netsuite_change"]')).toHaveCount(0);
    assert.equal(decisions[1].decision, "accept_netsuite_change");
    assert.equal(decisions[1].baseRevision, 12);
    assert.equal(await page.evaluate(() => orders[0].childOrderDetails[0].items.length), 1);
    assert.equal(await page.evaluate(() => orders[0].salesQty), 126);
    assert.equal(await page.evaluate(() => orders[0].childOrderDetails[1].notes), "unsaved sibling note");
    assert.deepEqual(await page.evaluate(() => trucks), []);
    reviews = [{ ...notice, token: "c".repeat(64), acknowledged: false, decisionRequired: false, decision: "accept_netsuite_change" }];
    await page.evaluate(async () => { await loadExecutedOrderReviews({ force: true }); renderDispatchNoticePatch(); });
    await page.locator('[data-executed-source-review] summary').click();
    await expect(page.locator('[data-action="confirm-executed-source-update"]')).toHaveText("Acknowledge change");
    await expect(page.locator('[data-action="protect-executed-source-update"]')).toHaveCount(0);
    await page.evaluate(async () => { localPlanDirty = true; await saveCurrentPlanNow(); });
    assert.equal(saves.length, 1, "same-day adjustment saves before acknowledgement");
    assert.equal(decisions.length, 2, "saving cannot acknowledge an automatic acceptance");
    await page.locator('[data-action="confirm-executed-source-update"]').click();
    await expect(page.locator('[data-action="confirm-executed-source-update"]')).toHaveCount(0);
    assert.equal(decisions[2].confirm, true);
    assert.equal(Object.hasOwn(decisions[2], "decision"), false);
    assert.equal(saves.length, 1);
    assert.ok(requestedRevisions.includes("12") && requestedRevisions.includes("13"));
    await page.screenshot({ path: "test-artifacts/executed-order-review/source-decisions.png" });
  } finally {
    if (page) {
      const entries = await page.coverage.stopJSCoverage();
      for (const entry of entries.filter(row => row.url.endsWith("/dispatch.js"))) {
        const converter = v8ToIstanbul("/app/public/dispatch.js", 0, { source: entry.source });
        await converter.load(); converter.applyCoverage(entry.functions);
        const path = "test-artifacts/source-decision/final/browser-native-coverage";
        await mkdir(path, { recursive: true });
        await writeFile(`${path}/coverage-final.json`, JSON.stringify(converter.toIstanbul()));
      }
    }
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
