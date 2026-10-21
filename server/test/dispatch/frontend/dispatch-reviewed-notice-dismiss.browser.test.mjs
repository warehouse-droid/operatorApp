import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';

test('reviewed source notice dismisses durably while pending reviews, other plans and new changes remain visible', async () => {
  const reviewed = Array.from({ length: 4 }, (_, index) => ({ token: String(index).repeat(64), orderRef: `SO-${index}`,
    acknowledged: true, acknowledgedBy: 'Dispatcher', changes: [{ message: 'Quantity updated' }] }));
  const pending = { token: 'p'.repeat(64), orderRef: 'SO-PENDING', acknowledged: false, changes: [] };
  const writes = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (/\.(js|css)$/u.test(url.pathname)) {
      res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      return res.end(await readFile(new URL(`../../../public${url.pathname}`, import.meta.url)));
    }
    if (!url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<link rel="stylesheet" href="/dispatch.css"><main id="dispatchApp"></main><script>function requireDispatchLogin() {}</script><script src="/dispatch-address-guard.js"></script><script src="/dispatch.js"></script>');
    }
    if (req.method !== 'GET') writes.push(url.pathname);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(url.pathname.endsWith('executed-order-reviews') ? { reviews: [...reviewed, pending] } : {}));
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    if (process.env.DISPATCH_REVIEW_COVERAGE) await page.coverage.startJSCoverage({ resetOnNavigation: false });
    const setup = async (planId = 'dismiss-test') => page.evaluate(({ planId, reviews }) => {
      currentPlanDate = todayLocalDate(); currentPlan = { id: planId, planDate: currentPlanDate, revision: 1, status: 'draft' };
      orders = []; orderCatalog = []; trucks = []; fleet = [];
      dispatchConfig = { plannerOrderPoolMode: 'off', plannerCommandMode: 'off', googleMapsEnabled: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = 'ready'; planEditMode = false;
      executedOrderReviewPlanId = planId; executedOrderReviews = reviews;
      render({ save: false });
    }, { planId, reviews: reviewed });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await setup();
    await expect(page.getByText('4 source updates reviewed', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dismiss notice', exact: true })).toBeVisible();
    await page.evaluate(review => { executedOrderReviews.push(review); routeNotice = 'Updated'; renderDispatchNoticePatch(); }, pending);
    const writesBefore = writes.length;
    await page.getByRole('button', { name: 'Dismiss notice', exact: true }).click();
    await expect(page.getByText('4 source updates reviewed', { exact: true })).toHaveCount(0);
    await expect(page.locator('[data-executed-source-review]')).toContainText('SO-PENDING');
    assert.equal(await page.evaluate(() => routeNotice), '');
    await page.evaluate(async () => { await loadExecutedOrderReviews({ force: true }); render({ save: false }); });
    await expect(page.getByText('4 source updates reviewed', { exact: true })).toHaveCount(0);
    assert.equal(writes.length, writesBefore, 'dismissal cannot save a plan or acknowledge pending updates');
    await page.reload(); await setup();
    await expect(page.getByText('4 source updates reviewed', { exact: true })).toHaveCount(0);
    await page.evaluate(review => { executedOrderReviews.push(review); renderDispatchNoticePatch(); }, { ...reviewed[0], token: 'n'.repeat(64) });
    await expect(page.getByText('1 source update reviewed', { exact: true })).toBeVisible();
    await setup('another-plan');
    await expect(page.getByText('4 source updates reviewed', { exact: true })).toBeVisible();
    await page.evaluate(() => {
      Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
      executedOrderReviewError = 'Source update warnings could not be refreshed';
    });
    await page.getByRole('button', { name: 'Dismiss notice', exact: true }).click();
    await expect(page.getByText('4 source updates reviewed', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('alert')).toContainText('could not be refreshed');
    if (process.env.DISPATCH_REVIEW_COVERAGE) writeFileSync(process.env.DISPATCH_REVIEW_COVERAGE,
      JSON.stringify((await page.coverage.stopJSCoverage()).filter(entry => new URL(entry.url).pathname === '/dispatch.js')));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
