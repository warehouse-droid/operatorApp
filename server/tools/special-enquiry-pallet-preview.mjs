/* global localStorage */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const out = 'test-artifacts/special-enquiry-pallet-20261001/browser';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] });
const checks = [];

async function fixture(audience, quantity, width, patch = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('mbbs.staff.token', 'test-enquiry-pallet'));
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const id = quantity === 5 ? 88 : 85;
  const record = { id, requestRef: quantity === 5 ? 'SPREQ-000020' : 'SPREQ-000019', revision: 2,
    status: 'submitted', stage: 'new_enquiry', closeStatus: 'active', storeLocationId: 1, storeName: '3445',
    customerName: 'TEST Customer', customerPhone: '555-0100', vendorName: 'TEST Vendor',
    netsuiteSalesRepId: 123, netsuiteSalesRepName: 'TEST Rep', inquiryDate: '2099-01-01', expiresOn: '2099-03-01',
    fulfillmentMethod: 'yard_pickup', palletTotal: quantity, palletRate: 40, salesOrderId: null, purchaseOrderId: null,
    salesOrderLines: [], purchaseOrderLines: [], media: [], events: [], readinessAlerts: [],
    lines: Array.from({ length: quantity === 5 ? 4 : 1 }, (_, index) => ({ id: 28 + index, lineNumber: index + 1,
      productName: 'TEST Stone ' + (index + 1), quantity: 2, packageQuantity: 2, uom: 'PCS', rateUom: 'PCS',
      originalRate: 100, rate: 100, discountPercent: 10, pricingSource: 'enquiry', requiredDate: '2099-02-01',
      supplyStatus: null, salesDecision: 'pending' })), ...patch };
  const errors = [], posts = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.hostname !== 'localhost') return route.abort();
    if (path.startsWith('/api/')) {
      if (request.method() !== 'GET') {
        const body = request.postDataJSON();
        posts.push({ path, body });
        assert.equal(path, '/api/sales/special-stock-requests', 'The enquiry display must not send order or stock writes');
        Object.assign(record, body, { id: 90, requestRef: 'SPREQ-000021', revision: 1, stage: 'new_enquiry',
          palletTotal: Number(body.palletTotal), palletRate: Number(body.palletRate),
          lines: body.lines.map((line, index) => ({ ...line, id: 50 + index, lineNumber: index + 1,
            originalRate: Number(line.rate), packageQuantity: Number(line.quantity), rateUom: line.uom,
            salesDecision: 'pending', supplyStatus: null })) });
        return route.fulfill({ status: 201, json: record });
      }
      if (path === '/api/auth/me') return route.fulfill({ json: { operator: {
        id: 'test-enquiry-pallet', display_name: 'TEST ' + audience, role: audience, roles: [audience], yard_location_ids: [1] } } });
      if (path.endsWith('/policy')) return route.fulfill({ json: { enabled: true } });
      if (path.endsWith('/sales-reps')) return route.fulfill({ json: { salesReps: [{ id: 123, name: 'TEST Rep' }] } });
      if (path.endsWith('/special-stock-requests')) return route.fulfill({ json: {
        yards: [{ locationId: 1, yardCode: '3445' }], vendors: ['TEST Vendor'], requests: [record] } });
      if (/\/special-stock-requests\/\d+$/.test(path)) return route.fulfill({ json: record });
      return route.fulfill({ json: { requests: [], yards: [], total: 0 } });
    }
    const file = path === `/${audience}/stock-requests` ? `/${audience}-stock-requests.html` : path;
    try {
      return route.fulfill({ body: await readFile('public' + file), contentType:
        ({ js: 'application/javascript', css: 'text/css', html: 'text/html' })[file.split('.').at(-1)] || 'application/octet-stream' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(`http://localhost/${audience}/stock-requests?tab=special`);
  await expect(page.locator(`.stock-request-card[data-id="${id}"]`)).toBeVisible();
  return { page, record, posts, close: async () => { assert.deepEqual(errors, []); await context.close(); } };
}

async function assertPallet(page, quantity, rate = '$40.00', subtotal = `$${quantity * 40}.00`) {
  const card = page.locator('[data-special-pallet-line]');
  await expect(card).toHaveCount(1);
  await expect(card).toBeVisible();
  await expect(card.locator('[data-special-pallet-quantity]')).toHaveText(`${quantity} EACH`);
  await expect(card.locator('[data-special-pallet-rate]')).toHaveText(rate);
  await expect(card.locator('[data-special-pallet-subtotal]')).toHaveText(subtotal);
  assert.equal(await card.locator('input,select,textarea,button').count(), 0, 'PALLET has no material stock or customer decision controls');
  assert.equal(await card.evaluate(node => node.parentElement.lastElementChild === node), true, 'PALLET follows the material lines');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'The enquiry must fit the viewport');
}

try {
  for (const audience of ['sales', 'scm']) for (const quantity of [1, 5]) for (const width of [1440, 390]) {
    const item = await fixture(audience, quantity, width);
    try {
      await assertPallet(item.page, quantity);
      assert.equal(await item.page.locator('.stock-request-lines > .stock-request-line:not([data-special-pallet-line])').count(),
        item.record.lines.length, 'PALLET must preserve every material line');
      const lineSelector = audience === 'sales' ? '[data-special-decision-line]' : '[data-special-stock-line]';
      assert.equal(await item.page.locator(lineSelector).count(), audience === 'sales' ? 0 : item.record.lines.length,
        'Keep the existing review controls for a new enquiry');
      assert.equal(item.posts.length, 0);
      await item.page.locator('[data-special-pallet-line]').screenshot({ path: `${out}/${audience}-${quantity}-${width}.png` });
      checks.push({ audience, quantity, width, stage: 'new_enquiry', visible: true });
    } finally { await item.close(); }
  }
  for (const audience of ['sales', 'scm']) {
    const item = await fixture(audience, 0, 1440, { salesOrderLines: [{ itemId: 1784, ancillary: true, quantity: 9, rate: 40 }] });
    try { await expect(item.page.locator('[data-special-pallet-line]')).toHaveCount(0); assert.equal(item.posts.length, 0);
      checks.push({ audience, quantity: 0, staleDraftPalletOmitted: true }); }
    finally { await item.close(); }
  }
  for (const patch of [{ palletRate: 0 }, { palletRate: null },
    { palletTotal: null, palletRate: null, salesOrderLines: [{ itemId: 1784, ancillary: true, quantity: 1, rate: 40 }] }]) {
    const item = await fixture('sales', 1, 1440, patch);
    try { await assertPallet(item.page, 1, patch.palletTotal === null ? '$40.00' : patch.palletRate === 0 ? '$0.00' : '—',
      patch.palletTotal === null ? '$40.00' : patch.palletRate === 0 ? '$0.00' : '—');
      checks.push({ audience: 'sales', zeroOrMissingRateOrLegacyDraft: true }); }
    finally { await item.close(); }
  }
  const item = await fixture('sales', 0, 1440);
  try {
    await item.page.getByRole('button', { name: 'New Special case', exact: true }).click();
    const form = item.page.locator('[data-special-case-form]');
    await form.locator('[name=customerName]').fill('TEST Customer');
    await form.locator('[name=vendorName]').fill('TEST Vendor');
    await form.locator('[name=salesRepId]').selectOption('123');
    await form.locator('[name=fulfillmentMethod]').selectOption('yard_pickup');
    const line = form.locator('[data-special-composer-line]').first();
    await line.locator('[name=productName]').fill('TEST Stone');
    await line.locator('[name=quantity]').fill('2');
    await line.locator('[name=uom]').selectOption('PCS');
    await line.locator('[name=rate]').fill('100');
    await line.locator('[name=requiredDate]').fill('2099-02-01');
    await form.locator('[name=palletTotal]').fill('5');
    await form.locator('[name=palletRate]').fill('40');
    await form.getByRole('button', { name: 'Submit to SCM', exact: true }).click();
    await expect(form).toHaveCount(0);
    await assertPallet(item.page, 5);
    assert.equal(item.record.stage, 'new_enquiry');
    assert.equal(item.posts.length, 1);
    assert.equal(item.posts[0].body.palletTotal, '5');
    await item.page.locator('[data-special-pallet-line]').screenshot({ path: out + '/after-submit.png' });
    checks.push({ audience: 'sales', afterSubmitToScm: true, stage: 'new_enquiry', quantity: 5 });
  } finally { await item.close(); }
} finally { await browser.close(); }
await writeFile(out + '/checks.json', JSON.stringify(checks, null, 2));
console.log(JSON.stringify({ enquiryBrowserChecks: checks.length, passed: true, checks }));
