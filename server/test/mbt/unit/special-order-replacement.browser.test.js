/* global localStorage, document, window, EventTarget */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from '@playwright/test';

const replacedEvent = (kind, previous, replacement, reason) => ({ id: 9, eventType: `special_${kind}_replaced`, actorName: 'TEST User',
  createdAt: '2099-01-02T15:00:00Z', details: { previous: { ref: previous }, replacement: { ref: replacement }, reason } });

const record = (overrides = {}) => ({ id: 1, requestRef: 'SPREQ-TEST-REPLACE', revision: 3, status: 'active', storeLocationId: 1, storeName: '3445',
  stage: 'confirmed', customerName: 'TEST Customer', vendorId: 9, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
  operationalYardLocationId: 1, closeStatus: 'active', inquiryDate: '2099-01-01', expiresOn: '2099-02-01', palletTotal: 0,
  salesOrderId: 50, salesOrderRef: 'TEST-SO-OLD', salesOrderSource: 'standalone', salesOrderApproved: true, salesOrderOperationStatus: 'linked',
  purchaseOrderId: 60, purchaseOrderRef: 'TEST-PO-OLD', purchaseOrderApproved: true, purchaseOrderOperationStatus: 'linked',
  salesOrderLines: [], purchaseOrderLines: [], media: [], readinessAlerts: [], events: [],
  lines: [{ id: 1, lineNumber: 1, productName: 'TEST Material', quantity: 1, packageQuantity: 1, uom: 'EACH', rateUom: 'EACH',
    originalRate: 10, pricingSource: 'enquiry', discountPercent: 0, salesDecision: 'accepted', supplyStatus: 'in_stock', responseVendorId: 9 }],
  ...overrides });

/** @param {{detail:Record<string,any>}} state @param {string} pathname */
function apiResponse(state, pathname) {
  const routes = [
    [path => path === '/api/auth/me', () => ({ operator: { id: 'test-replace', display_name: 'TEST', role: 'scm', roles: ['scm', 'sales'] } })],
    [path => path.endsWith('/policy'), () => ({ enabled: true })],
    [path => path.endsWith('/sales-reps'), () => ({ salesReps: [] })],
    [path => path.endsWith('/order-links'), () => ({ orders: [{ id: 99, ref: 'TEST-SO-NEW', entityName: 'TEST Customer', status: 'Pending Fulfillment' }] })],
    [path => /\/special-stock-requests\/?$/.test(path), () => ({ requests: [state.detail], yards: [{ locationId: 1, yardCode: '3445' }], vendors: [] })],
    [path => /\/special-stock-requests\/1$/.test(path), () => state.detail]
  ];
  const match = routes.find(([accepts]) => accepts(pathname));
  return match ? match[1]() : { requests: [], yards: [], total: 0, splits: [] };
}

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const assetTypes = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };

async function handle({ state, html, onPost }, req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/') && ['POST', 'PUT'].includes(req.method)) {
    let body = '';
    for await (const chunk of req) { body += chunk; }
    const input = JSON.parse(body);
    state.writes.push({ path: url.pathname, input });
    const answer = onPost(state, url.pathname, input);
    return send(res, answer.status || 200, answer.body);
  }
  if (url.pathname.startsWith('/api/')) { return send(res, 200, apiResponse(state, url.pathname)); }
  if (url.pathname === '/') { return send(res, 200, html, 'text/html; charset=utf-8'); }
  const root = resolve('public'), path = resolve(root, '.' + url.pathname);
  if (!path.startsWith(root + '/')) { throw new Error('Invalid fixture resource'); }
  return send(res, 200, await readFile(path), assetTypes[extname(path)] || 'application/octet-stream');
}

/** Serves the real public assets with a scripted API; POSTs are recorded and answered by `onPost`. */
async function withPage({ html, detail, onPost, width }, run) {
  const state = { detail, writes: [], errors: [] };
  const server = createServer((req, res) => {
    handle({ state, html, onPost }, req, res).catch(error => send(res, 404, String(error.message), 'text/plain'));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
    await context.addInitScript(() => { localStorage.setItem('mbbs.staff.token', 'test-replace'); window.EventSource = class extends EventTarget { close() {} }; });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => state.errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const card = page.locator('[data-special-sales-action=select], [data-special-scm-action=select]').first();
    await card.waitFor();
    await card.click();
    await run(page, state);
    assert.deepEqual(state.errors, []);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no horizontal overflow at ${width}px`);
  } finally { await browser.close(); await new Promise(done => server.close(done)); }
}

const scmHtml = '<link rel="stylesheet" href="/stock-requests.css"><div id="scmStockRequestApp"></div><script src="/scm-special-stock-requests.js"></script><script>window.MBBSSCMSpecialStock.open({operator:{id:"TEST",display_name:"TEST",role:"scm",roles:["scm"]}});</script>';
const salesHtml = '<link rel="stylesheet" href="/stock-requests.css"><div id="salesStockRequestApp"></div><script src="/sales-special-stock-requests.js"></script><script>window.MBBSSalesSpecialStock.open({operator:{id:"TEST",display_name:"TEST"},yards:[{locationId:1,yardCode:"3445"}]});</script>';

test('Sales replaces the linked SO with a searched synced SO and a reason on desktop and phone', async () => {
  for (const width of [1440, 390]) {
    await withPage({ html: salesHtml, detail: record(), width, onPost: (state, path, input) => {
      if (input.salesOrderRef === 'TEST-SO-MISSING') { return { status: 404, body: { error: 'TEST-SO-MISSING was not found in the local NetSuite mirror.', code: 'SPECIAL_ORDER_REPLACE_NOT_FOUND' } }; }
      state.detail = record({ revision: 4, salesOrderId: 99, salesOrderRef: input.salesOrderRef, salesOrderSource: 'manual_link', purchaseOrderCustomLinkage: true,
        events: [replacedEvent('sales_order', 'TEST-SO-OLD', input.salesOrderRef, input.reason)] });
      return { body: state.detail };
    } }, async (page, state) => {
      const panel = page.locator('details.special-order-replace');
      await panel.locator('summary').click();
      const form = page.locator('[data-special-replace-so-form]');
      await form.locator('button[type=submit]').click();
      assert.equal(state.writes.length, 0, 'The SO number and reason are required before submitting.');
      await form.locator('[name=salesOrderRef]').fill('TEST-SO-MISSING');
      await form.locator('[name=reason]').fill('SO closed and re-created');
      await form.locator('button[type=submit]').click();
      await page.getByText('TEST-SO-MISSING was not found in the local NetSuite mirror.').waitFor();
      assert.equal(await page.locator('details.special-order-replace').evaluate(element => element.open), true, 'The form stays open for a retry.');
      assert.equal(await page.locator('[data-special-replace-so-form] [name=reason]').inputValue(), 'SO closed and re-created');
      await page.locator('[data-special-replace-so-form] [name=salesOrderRef]').fill('TEST-SO');
      await page.locator('[data-special-sales-action=choose-so-replace]').first().click();
      assert.equal(await page.locator('[data-special-replace-so-form] [name=salesOrderRef]').inputValue(), 'TEST-SO-NEW');
      await page.locator('[data-special-replace-so-form] [name=reason]').fill('SO closed and re-created');
      await page.locator('[data-special-replace-so-form] button[type=submit]').click();
      await page.getByText('Sales Order replaced with TEST-SO-NEW.').waitFor();
      assert.equal(await page.locator('details.special-order-replace').evaluate(element => element.open), false, 'A successful replacement closes the form.');
      assert.deepEqual(state.writes.at(-1), { path: '/api/sales/special-stock-requests/1/sales-order/replace',
        input: { expectedRevision: 3, salesOrderRef: 'TEST-SO-NEW', reason: 'SO closed and re-created' } });
      assert.match(await page.locator('.special-order-replacements').innerText(), /SO TEST-SO-OLD → TEST-SO-NEW · SO closed and re-created/);
    });
  }
});

test('Sales sees replacement history but no replace form once the request is completed', async () => {
  await withPage({ html: salesHtml, width: 1440, onPost: () => ({ status: 500, body: {} }),
    detail: record({ stage: 'completed', operationallyComplete: true, events: [replacedEvent('purchase_order', 'TEST-PO-OLD', 'TEST-PO-NEW', 'PO re-issued')] }) },
  async page => {
    await page.locator('.special-order-replacements').waitFor();
    assert.match(await page.locator('.special-order-replacements').innerText(), /PO TEST-PO-OLD → TEST-PO-NEW · PO re-issued/);
    assert.equal(await page.locator('[data-special-replace-so-form]').count(), 0);
  });
});

test('SCM replaces the linked PO and sees vendor pickup Dispatch Arrangement on desktop and phone', async () => {
  for (const width of [1440, 390]) {
    await withPage({ html: scmHtml, width, detail: record({ stage: 'dispatch_arrangement', fulfillmentMethod: 'vendor_pickup', purchaseOrderReference: 'TEST-REF', purchaseOrderDispatchStatus: 'Queued' }),
      onPost: (state, path, input) => {
        state.detail = record({ revision: 4, purchaseOrderId: 61, purchaseOrderRef: input.purchaseOrderRef, purchaseOrderCustomLinkage: true, fulfillmentMethod: 'vendor_pickup',
          events: [replacedEvent('purchase_order', 'TEST-PO-OLD', input.purchaseOrderRef, input.reason)] });
        return { body: state.detail };
      } }, async (page, state) => {
      await page.getByText('Dispatch Arrangement · Customer pickup at vendor yard').waitFor();
      await page.locator('details.special-order-replace summary').click();
      const form = page.locator('[data-special-po-replace-form]');
      await form.locator('[name=purchaseOrderRef]').fill('TEST-PO-NEW');
      await form.locator('button[type=submit]').click();
      assert.equal(state.writes.length, 0, 'The reason is required before submitting.');
      await form.locator('[name=reason]').fill('Vendor re-issued the PO');
      await form.locator('button[type=submit]').click();
      await page.getByText('Purchase Order replaced with TEST-PO-NEW.').waitFor();
      assert.deepEqual(state.writes.at(-1), { path: '/api/scm/special-stock-requests/1/purchase-order/replace',
        input: { expectedRevision: 3, purchaseOrderRef: 'TEST-PO-NEW', reason: 'Vendor re-issued the PO' } });
      assert.match(await page.locator('.special-order-replacements').innerText(), /PO TEST-PO-OLD → TEST-PO-NEW · Vendor re-issued the PO/);
    });
  }
});
