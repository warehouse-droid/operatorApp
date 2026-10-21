import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import v8ToIstanbul from 'v8-to-istanbul';
import { config } from '../../../src/config.js';
import { query } from '../../../src/db.js';
import { upsertDispatchOrderCatalog } from '../../../src/dispatch-order-catalog-repository.js';
import { createDispatchV2Fixture } from '../support/dispatch-v2-fixture.js';
import { seedSalesOrder } from '../support/fulfilled-so-fixture.js';

const delivery = { id: 9530019001, ref: 'SO-REFRESH-DELIVERY' };
const pickup = { id: 9530019002, ref: 'SO-REFRESH-PICKUP' };
const artifact = `test-artifacts/refresh-targets/${process.env.DISPATCH_REFRESH_PHASE || 'current'}`;

test('background order events target eligible Dispatch cards', { timeout: 60000 }, async t => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  config.dispatch.plannerOrderPoolMode = 'on';
  const fixture = await createDispatchV2Fixture();
  let browser, page;
  const requests = [], results = [];
  async function event(payload) {
    const start = requests.length;
    await page.evaluate(payload => {
      eventSource.dispatchEvent(new MessageEvent('app-event', {
        data: JSON.stringify({ type: 'dispatch.orders.updated', payload })
      }));
    }, payload);
    await page.waitForFunction(() => !orderPoolRefreshTimer && !orderPoolRefreshInFlight && !orderPoolRefreshTrailing);
    const notice = await page.evaluate(() => routeNotice);
    const details = requests.slice(start).filter(url => url.includes('/api/dispatch/v2/order-feed/'));
    results.push({ payload, notice, details });
    return { notice, details };
  }
  try {
    await mkdir(artifact, { recursive: true });
    await seedSalesOrder(delivery.id, delivery.ref, { status: 'B', method: 'Delivery' });
    await seedSalesOrder(pickup.id, pickup.ref, { status: 'B', method: 'Pick-Up' });
    const feed = await fixture.request('/api/dispatch/orders');
    assert.equal(feed.response.status, 200);
    assert.ok(feed.payload.some(order => order.id === delivery.ref));
    assert.ok(!feed.payload.some(order => order.id === pickup.ref));
    await upsertDispatchOrderCatalog({ orders: feed.payload, source: 'isolated-refresh-targets' });
    for (const ref of [pickup.id, pickup.ref]) {
      const read = await fixture.request(`/api/dispatch/v2/order-feed/${ref}?fresh=true`);
      assert.equal(read.response.status, 404, 'Pickup orders correctly remain outside Dispatch');
      assert.equal(read.payload.code, 'DISPATCH_ORDER_NOT_FOUND');
    }
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    await context.addInitScript(token => {
      localStorage.setItem('mbbs.staff.token', token);
      localStorage.setItem('mbbs.staff.role', 'dispatcher');
      localStorage.setItem('mbbs.staff.roles', JSON.stringify(['dispatcher']));
      localStorage.setItem('mbbs.dispatch.token', token);
    }, fixture.session.token);
    page = await context.newPage();
    page.on('request', request => requests.push(new URL(request.url()).pathname + new URL(request.url()).search));
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.goto(`${fixture.baseUrl}/dispatch/planning`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(`.order-card[data-order="${delivery.ref}"]`)).toBeVisible();
    await page.waitForFunction(() => eventSource && !dispatchOrderPoolLoadPromise);

    await t.test('customer pickup event does not request its numeric or display identity as a Dispatch card', async () => {
      const result = await event({ orderId: pickup.id, tranid: pickup.ref, orderType: 'SO' });
      assert.ok(!result.notice.startsWith('Order-pool refresh failed:'), result.notice);
      assert.deepEqual(result.details, [], 'Unrelated pickup identities should not trigger detail requests');
      await expect(page.locator(`.order-card[data-order="${delivery.ref}"]`)).toBeVisible();
    });
    await t.test('numeric and display aliases refresh the visible card only once', async () => {
      await page.evaluate(() => { routeNotice = ''; });
      const result = await event({ orderId: delivery.id, tranid: delivery.ref });
      assert.deepEqual(result.details, [`/api/dispatch/v2/order-feed/${delivery.ref}?fresh=true`]);
      assert.ok(!result.notice.startsWith('Order-pool refresh failed:'), result.notice);
    });
    await t.test('a genuine visible-order failure stays visible', async () => {
      await page.route(`**/api/dispatch/v2/order-feed/${delivery.ref}?fresh=true`, route => route.fulfill({
        status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Isolated detail service unavailable' })
      }));
      const result = await event({ orderRef: delivery.ref });
      assert.match(result.notice, /Order-pool refresh failed:.*Isolated detail service unavailable/);
    });
    await t.test('a successful retry clears its previous refresh failure', async () => {
      await page.unrouteAll();
      const result = await event({ orderRef: delivery.ref });
      assert.ok(!result.notice.startsWith('Order-pool refresh failed:'), result.notice);
      assert.equal(result.details.length, 1);
    });
    await t.test('a missing visible card still reports its real 404', async () => {
      await page.route(`**/api/dispatch/v2/order-feed/${delivery.ref}?fresh=true`, route => route.fulfill({
        status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Dispatch order not found' })
      }));
      const result = await event({ orderRef: delivery.ref });
      assert.match(result.notice, /Order-pool refresh failed:.*Dispatch order not found/);
      await page.unrouteAll();
      assert.ok(!(await event({ orderRef: delivery.ref })).notice.startsWith('Order-pool refresh failed:'));
    });
    await t.test('a successful refresh preserves an unrelated unsaved-work notice', async () => {
      await page.evaluate(() => { routeNotice = 'Keep your unsaved changes'; });
      assert.equal((await event({ orderRef: delivery.ref })).notice, 'Keep your unsaved changes');
    });
    await t.test('a newly eligible order is still discovered from the refreshed pool', async () => {
      const ref = 'SO-REFRESH-NEW';
      await seedSalesOrder(9530019003, ref, { status: 'B', method: 'Delivery' });
      const order = (await fixture.request(`/api/dispatch/v2/order-feed/${ref}?fresh=true`)).payload.order;
      assert.equal(order.id, ref);
      await upsertDispatchOrderCatalog({ orders: [order], source: 'isolated-new-order' });
      await event({ orderId: 9530019003, tranid: ref });
      await expect(page.locator(`.order-card[data-order="${ref}"]`)).toBeVisible();
    });
  } finally {
    await writeFile(`${artifact}/results.json`, JSON.stringify(results, null, 2));
    await writeFile(`${artifact}/requests.json`, JSON.stringify(requests, null, 2));
    if (page) {
      await page.screenshot({ path: `${artifact}/screen.png` });
      for (const entry of (await page.coverage.stopJSCoverage()).filter(entry => new URL(entry.url).pathname === '/dispatch.js')) {
        const converter = v8ToIstanbul('/app/public/dispatch.js', 0, { source: entry.source });
        await converter.load(); converter.applyCoverage(entry.functions);
        await writeFile(`${artifact}/coverage.json`, JSON.stringify(converter.toIstanbul()));
      }
      await page.context().tracing.stop({ path: `${artifact}/trace.zip` });
    }
    await browser?.close();
    await fixture.close();
  }
});
