import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import test, { before, after } from 'node:test';
import { chromium, expect } from '@playwright/test';

const out = process.env.SCM_PLANNED_CARD_OUTPUT || '/tmp/scm-planned-card';
let browser;
before(async () => {
  await mkdir(out, { recursive: true });
  browser = await chromium.launch({ channel: 'chromium', args: ['--no-sandbox'] });
});
after(async () => browser?.close());

for (const width of [1440, 390]) test(`SCM Special Request detail loads the updated PO card at ${width}px`, async () => {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('mbbs.staff.token', 'test-scm-card'));
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [], writes = [], assets = new Map();
  const record = { id: 95, requestRef: 'SPREQ-000024', revision: 7, stage: 'dispatch_arrangement', closeStatus: 'active',
    storeName: '3445', storeLocationId: 1, customerName: 'TEST Customer', vendorName: 'TEST Vendor', vendorId: 331,
    salesOrderId: 1033108, salesOrderRef: 'SOB121882', salesOrderApproved: true,
    purchaseOrderId: 995310, purchaseOrderRef: 'POB03883', purchaseOrderReference: 'SN1400411', purchaseOrderApproved: true,
    palletTotal: 7, palletRate: 40, fulfillmentMethod: 'mbt_delivery', deliveryAddress: '3445 Kennedy Road', events: [], media: [], readinessAlerts: [],
    lines: [{ id: 1, productName: 'TEST material', quantity: 349, uom: 'SQFT', supplyStatus: 'in_stock', salesDecision: 'accepted', vendorYard: 'Vendor yard' }],
    purchaseOrderLines: [{ caseLineId: 1, itemId: 2055, description: 'TEST material', quantity: 349, uom: 'SQFT', unitPurchaseCost: 1 }],
    dispatchPlanning: { anyPlanned: true, salesOrder: { planned: false, plans: [] },
      purchaseOrder: { planned: true, plans: [{ planDate: '2026-10-02', estimatedArrivalMinute: 1021 }] } } };
  const order = { id: 'SN1400411', originalPoRef: 'POB03883', type: 'PO', destinationYard: '3445', vendorYard: 'Vendor yard', notes: '', netSuiteNote: '',
    vendorYardOptions: [{ yard: 'Vendor yard' }], items: [], scm: { method: 'MBT', status: 'Planned', pickupPoint: 'Vendor yard', isSpecialOrder: true,
      packingSlipRef: 'SN1400411', dropoffPoint: '', notes: '', netSuiteMemo: '', remarkOverride: '', updatedAt: '2026-10-02T12:00:00Z' } };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.hostname !== 'localhost') return route.abort();
    if (path.startsWith('/api/')) {
      if (request.method() !== 'GET') writes.push(request.method() + ' ' + path);
      if (path === '/api/auth/me') return route.fulfill({ json: { operator: { id: 'test', role: 'scm', roles: ['scm'] } } });
      if (path.endsWith('/policy')) return route.fulfill({ json: { enabled: true } });
      if (path.endsWith('/purchase-order/note')) return route.fulfill({ json: { note: '' } });
      if (path.startsWith('/api/dispatch/scm/v2/purchase-orders/')) return route.fulfill({ json: { order } });
      if (path === '/api/dispatch/scm/v2/purchase-orders') return route.fulfill({ json: { orders: [order], total: 1 } });
      if (path.endsWith('/special-stock-requests/95')) return route.fulfill({ json: record });
      if (path.endsWith('/special-stock-requests')) return route.fulfill({ json: { requests: [record], yards: [{ locationId: 1, yardCode: '3445' }] } });
      return route.fulfill({ json: { requests: [], yards: [], total: 0 } });
    }
    if (['/scm-special-stock-requests.js', '/special-stock-case-status.js', '/special-stock-documents.css'].includes(path)) assets.set(path, url);
    if (path === '/special-stock-case-status.js' && !url.searchParams.has('scmPlanning')) {
      // Simulate a browser retaining the old renderer at the previous module URL.
      return route.fulfill({ contentType: 'application/javascript', body: `
        export const specialClosureStatus=()=>'', specialClosureCardAlert=()=>'', specialClosureQueueAlert=()=>'', compareSpecialScmQueue=()=>0;
        export const specialPlanningStatus=()=>'<div class="special-planning-order"><span><strong>PO POB03883</strong><small>Planned (2026-10-02)</small></span><button>Preview PO</button></div>';` });
    }
    const file = path === '/scm/stock-requests' ? '/scm-stock-requests.html' : path;
    try { return route.fulfill({ body: await readFile('public' + file), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  try {
    await page.goto('http://localhost/scm/stock-requests?tab=special');
    await page.locator('.stock-request-card[data-id="95"]').click();
    const card = page.locator('.stock-request-detail .special-planning-order').filter({ hasText: 'PO POB03883' });
    await expect(card).toHaveClass(/is-planned/);
    await expect(card).toContainText('Planned (2026-10-02)');
    await expect(card).toContainText('Est. arrival: 2026-10-02 17:01');
    await expect(card.locator('[data-special-document="purchase_order"][data-case-id="95"]')).toHaveText('Preview PO');
    const style = await card.evaluate(element => ({ background: getComputedStyle(element).backgroundColor,
      color: getComputedStyle(element.querySelector('strong')).color,
      statusSize: getComputedStyle(element.querySelector('.special-planning-order-status')).fontSize,
      referenceSize: getComputedStyle(element.querySelector('strong')).fontSize }));
    assert.equal(style.background, 'rgb(0, 133, 42)');
    assert.equal(style.color, 'rgb(255, 255, 255)');
    assert.equal(style.statusSize, style.referenceSize);
    assert.ok(parseFloat(style.statusSize) >= 16);
    for (const path of ['/scm-special-stock-requests.js', '/special-stock-case-status.js', '/special-stock-documents.css']) {
      assert.equal(assets.get(path)?.searchParams.get('scmPlanning'), '20261002-v2', path);
    }
    await card.screenshot({ path: `${out}/scm-po-card-${width}.png` });
    await page.screenshot({ path: `${out}/scm-request-${width}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
  } finally { await context.close(); }
});
