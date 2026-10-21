import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { chromium, expect } from '@playwright/test';

test('source notices follow the current plan and routine refreshes are quiet while failures remain visible', async () => {
  const reviews = [
    { token: 'a'.repeat(64), orderRef: 'SO-REAL', notifyDispatcher: true, acknowledged: false, contexts: [],
      noticeChanges: [{ message: 'Quantity: 10 → 11' }], changes: [{ message: 'Pickup changed by dispatcher' }, { message: 'Quantity: 10 → 11' }] },
    { token: 'b'.repeat(64), orderRef: 'CO-LOCAL', notifyDispatcher: false, acknowledged: false, contexts: [], changes: [{ message: 'CO pickup changed' }] },
    { token: 'c'.repeat(64), orderRef: 'SO-UNPLANNED', notifyDispatcher: false, acknowledged: true, contexts: [], changes: [{ message: 'Old unplanned update' }] }
  ];
  let feedFailed = false; const writes = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (/\.(js|css)$/u.test(url.pathname)) {
      res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      return res.end(await readFile(new URL(`../../../public${url.pathname}`, import.meta.url)));
    }
    if (!url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'text/html');
      return res.end('<main id="dispatchApp"></main><script>function requireDispatchLogin(){}</script><script src="/dispatch-address-guard.js"></script><script src="/dispatch.js"></script>');
    }
    if (req.method !== 'GET') { writes.push(url.pathname); }
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/dispatch/orders') {
      if (feedFailed) { res.statusCode = 503; return res.end('{"error":"Feed unavailable"}'); }
      return res.end('[]');
    }
    return res.end(JSON.stringify(url.pathname.endsWith('executed-order-reviews') ? { reviews } : {}));
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    if (process.env.SOURCE_NOTICE_COVERAGE_DIR) { await page.coverage.startJSCoverage({ resetOnNavigation: false }); }
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(reviews => {
      orders = []; orderCatalog = []; fleet = []; currentPlanDate = todayLocalDate();
      trucks = [{ id: 'TEST', plate: 'TEST', loads: [{ id: 'TEST-LOAD', stops: [{ id: 'TEST-PICK', type: 'pick', orderId: 'SO-REAL' }] }] }];
      currentPlan = { id: 'source-notice-test', revision: 1, status: 'draft', planDate: currentPlanDate };
      dispatchConfig = { plannerOrderPoolMode: 'off', plannerCommandMode: 'off', googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = 'ready';
      executedOrderReviewPlanId = currentPlan.id; executedOrderReviews = reviews; routeNotice = '';
      render({ save: false });
    }, reviews);
    await expect(page.locator('[data-executed-source-review]')).toHaveCount(1);
    await expect(page.locator('[data-executed-source-review]')).toContainText('SO-REAL');
    await page.locator('[data-executed-source-review] summary').click();
    await expect(page.locator('[data-executed-source-review]')).toContainText('Quantity: 10 → 11');
    await expect(page.locator('.route-notice')).not.toContainText('Pickup changed by dispatcher');
    await expect(page.locator('.route-notice')).not.toContainText('CO pickup changed');
    await expect(page.locator('.route-notice')).not.toContainText('Old unplanned update');
    await page.evaluate(() => { trucks = []; renderDispatchNoticePatch(); });
    await expect(page.locator('[data-executed-source-review]')).toHaveCount(0);
    await page.evaluate(() => { orderPoolRefreshReason = 'Order data updated.'; return runQueuedDispatchOrderPoolRefresh(); });
    await expect(page.locator('.route-notice')).toHaveCount(0);
    assert.equal(await page.evaluate(() => routeNotice), '');
    feedFailed = true;
    await page.evaluate(() => runQueuedDispatchOrderPoolRefresh());
    await expect(page.locator('.route-notice')).toContainText('Order-pool refresh failed');
    assert.deepEqual(writes, [], 'notice filtering must not acknowledge changes or save plans');
    if (process.env.SOURCE_NOTICE_COVERAGE_DIR) {
      for (const [index, entry] of (await page.coverage.stopJSCoverage()).entries()) {
        if (new URL(entry.url).pathname !== '/dispatch.js') { continue; }
        await writeFile(`${process.env.SOURCE_NOTICE_COVERAGE_DIR}/notice-browser-${index}.json`, JSON.stringify({ result: [{
          scriptId: 'notice-' + index, url: 'file:///app/public/dispatch.js', functions: entry.functions
        }] }));
      }
    }
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
