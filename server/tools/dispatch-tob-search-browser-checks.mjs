// Browser reproduction against the complete, unchanged live dispatch.js.
// Only login/bootstrap and network boundaries are supplied by this harness.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const source = readFileSync(process.env.MBBS_TOB_BROWSER_SOURCE || '/app/test-artifacts/dispatch.js', 'utf8');
const planned = new Set([0, 1, 2, 7, 8, 9]);
const feed = Array.from({ length: 10 }, (_, digit) => ({
  id: `TOB0126${digit}`, type: 'TO', customer: 'Yard transfer', address: '3445 to 150',
  sourceYard: '3445', destinationYard: '150', pickupLocations: ['3445'], items: [],
  dispatchPlanned: planned.has(digit), dispatchPlanDate: digit >= 8 ? '2026-10-28'
    : digit === 7 ? '2026-10-27' : digit === 0 ? '2026-10-21' : planned.has(digit) ? '2026-10-23' : '',
  dispatchPlanId: digit >= 8 ? '371' : planned.has(digit) ? '350' : ''
}));
const seed = feed.filter(order => ['TOB01268', 'TOB01269'].includes(order.id));
const browser = await chromium.launch({ headless: true });
const report = { at: new Date().toISOString(), node: process.version, browser: browser.version(),
  image: readFileSync('/app/test-artifacts/live-image.txt', 'utf8').trim(),
  sourceSha256: createHash('sha256').update(source).digest('hex'), scenarios: [] };
try {
  for (const scenario of ['quiet', 'background-update-during-search', 'local-edit-during-search', 'background-update-before-search', 'targeted-mutation-during-search', 'retirement-during-search']) {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => { pageErrors.push(error.message); console.error('Browser error:', error.message); });
    let releaseSearch;
    let searchRequested;
    const requested = new Promise(resolve => { searchRequested = resolve; });
    const released = new Promise(resolve => { releaseSearch = resolve; });
    const requests = [];
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      requests.push(url.pathname + url.search);
      if (url.pathname === '/dispatch.html') {
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="dispatchApp"></div>' });
      }
      if (url.pathname === '/api/dispatch/v2/order-pool') {
        if (url.searchParams.get('search') === 'TOB0126') {
          searchRequested();
          await released;
          return route.fulfill({ json: { orders: feed, nextCursor: '', source: 'legacy' } });
        }
        return route.fulfill({ json: { orders: [], nextCursor: '' } });
      }
      if (url.pathname.includes('/executed-order-reviews')) return route.fulfill({ json: { reviews: [] } });
      throw new Error(`Unexpected browser request: ${url.pathname}${url.search}`);
    });
    try {
      await page.goto('http://dispatch.reproduction/dispatch.html');
      for (const dependency of ['dispatch-edit-activity.js', 'dispatch-address-guard.js', 'dispatch-auth.js']) {
        await page.addScriptTag({ content: readFileSync(`/app/test-artifacts/${dependency}`, 'utf8') });
      }
      await page.addScriptTag({ content: 'window.requireDispatchLogin = () => {};\n' + source });
      assert.deepEqual(pageErrors, [], 'the live screen must initialize in the harness');
      await page.evaluate(seedOrders => {
        currentPlanDate = '2026-10-28';
        currentPlan = { id: '371', planDate: currentPlanDate, revision: 38 };
        dispatchConfig.plannerOrderPoolMode = 'on';
        trucks = [];
        orders = [];
        orderCatalog = [];
        selectedOrderId = '';
        selectedOrderIds.clear();
        mergeDispatchOrderSearchFeed(seedOrders);
        app.innerHTML = renderOrderPool();
      }, seed);
      if (scenario === 'background-update-before-search') {
        await page.evaluate(() => queueDispatchOrderPoolRefresh('Order data updated.', { orderId: 'SO-UNRELATED' }));
        await page.waitForFunction(() => !orderPoolRefreshTimer && !orderPoolRefreshInFlight);
      }
      await page.locator('#orderSearch').fill('TOB0126');
      let requestTimer;
      try {
        await Promise.race([requested, new Promise((_, reject) => {
          requestTimer = setTimeout(() => reject(new Error(`Search request did not start: ${JSON.stringify({ requests, pageErrors })}`)), 5000);
        })]);
      } finally { clearTimeout(requestTimer); }
      const waiting = await page.evaluate(() => ({ refs: openOrders().map(order => order.id), loading: orderSearchLoading }));
      if (scenario === 'background-update-during-search') {
        await page.evaluate(() => queueDispatchOrderPoolRefresh('Order data updated.', { orderId: 'SO-UNRELATED' }));
        releaseSearch();
        await page.waitForFunction(() => !orderPoolRefreshTimer && !orderPoolRefreshInFlight);
      }
      if (scenario === 'local-edit-during-search') await page.evaluate(() => {
        orderById('TOB01268').assigned = true;
        markLocalPlanDirty();
      });
      if (scenario === 'targeted-mutation-during-search') await page.evaluate(() => {
        mergeTargetedDispatchMutationOrders({ order: { ...orderById('TOB01268'), address: 'NEWER SAVED ADDRESS' } });
      });
      if (scenario === 'retirement-during-search') await page.evaluate(() => setAuthoritativeOrderRetirement('TOB01263', true));
      releaseSearch();
      await page.waitForFunction(() => !orderSearchLoading);
      const result = await page.evaluate(() => ({ refs: openOrders().map(order => order.id).sort(),
        loading: orderSearchLoading, error: orderSearchError, subtitle: orderPoolSubtitle(),
        renderedRefs: [...document.querySelectorAll('.order-list [data-order]')].map(node => node.getAttribute('data-order')),
        allPlanned: openOrders().every(order => order.dispatchPlanned), epoch: dispatchOrderRefreshEpoch,
        generation: localPlanGeneration, cacheSize: dispatchOrderSearchCache.size, routeNotice }));
      assert.deepEqual(pageErrors, [], 'the production screen script must run without browser errors');
      const expected = feed.filter(order => scenario !== 'retirement-during-search' || order.id !== 'TOB01263').map(order => order.id);
      const fails = false;
      assert.deepEqual(result.refs, expected, scenario + ' must show the full search');
      if (scenario === 'local-edit-during-search') assert.equal(await page.evaluate(() => orderById('TOB01268').assigned), true);
      if (scenario === 'targeted-mutation-during-search') assert.equal(await page.evaluate(() => orderById('TOB01268').address), 'NEWER SAVED ADDRESS');
      if (scenario === 'background-update-during-search') {
        assert.equal(requests.filter(url => url.includes('/order-pool')).length, 2, 'reuse the one existing update request');
        assert.ok(requests.filter(url => url.includes('/order-pool')).every(url => url.includes('search=TOB0126')), 'queued update must preserve search');
      }
      assert.deepEqual([...result.renderedRefs].sort(), result.refs, 'the actual rendered cards must match the measured result');
      assert.equal(result.loading, false);
      assert.equal(result.error, '');
      assert.equal(result.allPlanned, false);
      const entry = { scenario, waiting, result, requests };
      if (fails) {
        // With no intervening update, exactly the same query succeeds on the second try.
        await page.locator('#orderSearch').fill('');
        await page.locator('#orderSearch').fill('TOB0126');
        await page.waitForFunction(() => !orderSearchLoading && openOrders().length === 10);
        entry.retryRefs = await page.evaluate(() => openOrders().map(order => order.id).sort());
        assert.deepEqual(entry.retryRefs, feed.map(order => order.id));
      }
      report.scenarios.push(entry);
      console.log(JSON.stringify(entry));
    } finally { await page.close(); }
  }
  writeFileSync('/app/test-artifacts/browser-checks.json', JSON.stringify(report, null, 2) + '\n');
} finally { await browser.close(); }
