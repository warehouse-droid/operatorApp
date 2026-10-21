import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import test, { before, after } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { specialPlanningStatus } from '../../../public/special-stock-case-status.js';

const out = process.env.SPECIAL_HANDOFF_BROWSER_OUTPUT || '/tmp/special-handoff-notice-browser';
let browser;
before(async () => {
  await mkdir(out, { recursive: true });
  browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] });
});
after(async () => browser?.close());

test('handoffs page is notice-only, has Sp. O navigation, and removes a finished selection on refresh', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('mbbs.staff.token', 'test-notice');
    localStorage.setItem('mbbs.staff.roles', '["dispatcher"]');
  });
  const page = await context.newPage();
  const errors = [], writes = [];
  let handoffs = [{ id: 95, requestRef: 'SPREQ-000024', revision: 1, stage: 'dispatch_arrangement', stageLabel: 'Dispatch arrangement',
    salesOrderRef: 'SOB121882', purchaseOrderRef: 'POB03883', customerName: 'Test Customer', vendorName: 'Test Vendor', fulfillmentMethod: 'mbt_delivery',
    handoff: { status: 'waiting_route', route: null, pickupAddress: 'Vendor yard', destinationAddress: '3445 Kennedy Road', operationalYardLocationId: 1 },
    lines: [{ salesDecision: 'accepted', productName: 'Test material', itemResolution: { description: 'Test material', itemName: 'MBBS-Special', salesQuantity: 349, salesUom: 'SQFT' } }] }];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== 'localhost') return route.abort();
    if (url.pathname.startsWith('/api/')) {
      if (request.method() !== 'GET') writes.push(request.method() + ' ' + url.pathname);
      if (url.pathname === '/api/auth/me') return route.fulfill({ json: { operator: { id: 'test', display_name: 'Test Dispatcher', role: 'dispatcher', roles: ['dispatcher'] } } });
      if (url.pathname.endsWith('/policy')) return route.fulfill({ json: { enabled: true } });
      if (url.pathname === '/api/dispatch/special-stock-handoffs') return route.fulfill({ json: { handoffs } });
      if (url.pathname === '/api/events') return route.fulfill({ body: '', contentType: 'text/event-stream' });
      return route.fulfill({ json: { count: 0 } });
    }
    const file = url.pathname === '/dispatch/special-stock' ? '/dispatch-special-stock.html' : url.pathname;
    try {
      return route.fulfill({ body: await readFile('public' + file), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  try {
    await page.goto('http://localhost/dispatch/special-stock');
    await expect(page.locator('.stock-request-detail')).toContainText('SPREQ-000024');
    await expect(page.locator('[data-dispatch-special-action="route"]')).toHaveCount(0);
    await expect(page.locator('.stock-request-detail button')).toHaveCount(0);
    await expect(page.locator('.stock-request-detail')).toContainText('both the SO and PO are completed');
    const link = page.locator('.app-sidebar-link[href="/dispatch/special-stock"]');
    await expect(link).toContainText('Sp. O');
    await expect(link).toHaveClass(/active/);
    await page.screenshot({ path: out + '/handoff-notice.png', fullPage: true });
    handoffs = [];
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.stock-request-list')).toContainText('No Special Item handoffs');
    await expect(page.locator('.stock-request-detail')).toContainText('Select a handoff');
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('planned PO card is green and white with large status/date and saved ETA on desktop and phone', async () => {
  const detail = { id: 95, salesOrderId: 1033108, salesOrderRef: 'SOB121882', purchaseOrderId: 995310, purchaseOrderRef: 'POB03883',
    dispatchPlanning: { anyPlanned: true, salesOrder: { planned: false, plans: [] },
      purchaseOrder: { planned: true, plans: [{ planDate: '2026-10-02', estimatedArrivalMinute: 1021 }] } } };
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    try {
      const css = await readFile('public/special-stock-documents.css', 'utf8');
      await page.setContent(`<style>body{margin:12px;font-family:Arial}button{padding:8px;border:1px solid;border-radius:6px}${css}</style>${specialPlanningStatus(detail, false, { showOrderPreviews: true })}`);
      const card = page.locator('.special-planning-order').filter({ hasText: 'PO POB03883' });
      await expect(card).toHaveClass(/is-planned/);
      await expect(card).toContainText('Planned (2026-10-02)');
      await expect(card).toContainText('Est. arrival: 2026-10-02 17:01');
      const style = await card.evaluate(element => {
        const style = getComputedStyle(element), status = element.querySelector('.special-planning-order-status');
        return { background: style.backgroundColor, color: style.color, status: getComputedStyle(status).fontSize,
          reference: getComputedStyle(element.querySelector('strong')).fontSize, button: getComputedStyle(element.querySelector('button')).color,
          overflow: document.documentElement.scrollWidth > window.innerWidth };
      });
      const rgb = style.background.match(/\d+/g).map(Number);
      assert.ok(rgb[1] > rgb[0] && rgb[1] > rgb[2]);
      assert.equal(style.color, 'rgb(255, 255, 255)');
      assert.equal(style.button, style.color);
      assert.equal(style.status, style.reference);
      assert.ok(parseFloat(style.status) >= 16);
      assert.equal(style.overflow, false);
      await page.screenshot({ path: `${out}/planned-card-${width}.png` });
    } finally { await page.close(); }
  }
});
