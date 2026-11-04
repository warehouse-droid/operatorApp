/* global localStorage, document, window, EventTarget */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from '@playwright/test';

const record = (overrides = {}, line = {}) => ({ id: 1, requestRef: 'SPREQ-TEST-DETAILS', revision: 3, status: 'active', storeLocationId: 1, storeName: '3445',
  stage: 'dispatch_arrangement', customerName: 'TEST Customer', vendorId: 12078, vendorName: 'TEST Unilock Alliance', fulfillmentMethod: 'yard_pickup',
  operationalYardLocationId: 1, closeStatus: 'active', inquiryDate: '2099-01-01', expiresOn: '2099-02-01', palletTotal: 0,
  salesOrderId: 50, salesOrderRef: 'TEST-SO', salesOrderSource: 'manual_link', salesOrderApproved: true, salesOrderOperationStatus: 'linked',
  purchaseOrderId: 60, purchaseOrderRef: 'TEST-PO', purchaseOrderApproved: true, purchaseOrderOperationStatus: 'linked', purchaseOrderCustomLinkage: true,
  salesOrderLines: [], purchaseOrderLines: [], media: [], readinessAlerts: [], events: [],
  lines: [{ id: 1, lineNumber: 1, productName: 'TEST Slab', quantity: 1, packageQuantity: 1, uom: 'EACH', rateUom: 'EACH', originalRate: 10,
    pricingSource: 'enquiry', discountPercent: 0, salesDecision: 'accepted', supplyStatus: 'in_stock', requiredDate: '2099-02-01',
    responseVendorId: 12078, responseVendorName: 'TEST Unilock Alliance', vendorYard: 'TEST AYR', salesVisibleNote: 'Ready next week',
    salesVisibleNoteUpdatedAt: '2099-01-02T15:00:00Z', scmInternalNote: 'TEST internal', ...line }],
  ...overrides });

/** @param {{detail:Record<string,any>}} state @param {string} pathname */
function apiResponse(state, pathname) {
  const routes = [
    [path => path === '/api/auth/me', () => ({ operator: { id: 'test-details', display_name: 'TEST', role: 'scm', roles: ['scm', 'sales'] } })],
    [path => path.endsWith('/policy'), () => ({ enabled: true })],
    [path => path.endsWith('/sales-reps'), () => ({ salesReps: [] })],
    [path => path.endsWith('/vendors'), () => ({ vendors: [{ id: 331, name: 'TEST Unilock Ltd.' }] })],
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

test('SCM edits the six line details and corrects the vendor after the PO is linked on desktop and phone', async () => {
  for (const width of [1440, 390]) {
    await withPage({ html: scmHtml, width, detail: record(), onPost: (state, path, input) => {
      const [line] = input.lines;
      state.detail = record({ revision: 4, vendorId: 331, vendorName: line.vendorName }, { requiredDate: line.requiredDate, supplyStatus: line.supplyStatus,
        responseVendorId: 331, responseVendorName: line.vendorName, vendorYard: line.vendorYard, salesVisibleNote: line.salesVisibleNote,
        salesVisibleNoteUpdatedAt: '2099-01-03T16:00:00Z', scmInternalNote: line.scmInternalNote });
      return { body: state.detail };
    } }, async (page, state) => {
      await page.getByText('Reply to Sales · 2099-01-02T15:00:00Z').waitFor();
      const form = page.locator('[data-special-stock-line="1"][data-kind=readiness]');
      for (const name of ['requiredDate', 'supplyStatus', 'vendorName', 'vendorYard', 'salesVisibleNote', 'scmInternalNote']) {
        assert.equal(await form.locator(`[name=${name}]`).isEditable(), true, `${name} stays editable after the PO is linked`);
      }
      assert.match(await form.innerText(), /linked NetSuite PO keeps its vendor/);
      await form.locator('[name=vendorName]').fill('Unilock');
      await page.locator('[data-special-scm-action=choose-vendor]').first().click();
      assert.equal(await form.locator('[name=vendorName]').inputValue(), 'TEST Unilock Ltd.');
      await form.locator('[name=requiredDate]').fill('2099-03-15');
      await form.locator('[name=vendorYard]').fill('TEST Ltd yard');
      await form.locator('[name=salesVisibleNote]').fill('Ready Friday');
      await form.locator('[name=scmInternalNote]').fill('Confirmed by phone');
      await page.getByRole('button', { name: 'Save stock check', exact: true }).click();
      await page.getByText('Reply to Sales · 2099-01-03T16:00:00Z').waitFor();
      assert.deepEqual(state.writes.at(-1), { path: '/api/scm/special-stock-requests/1/stock-check', input: { expectedRevision: 3, lines: [{
        lineId: 1, kind: 'readiness', supplyStatus: 'in_stock', eta: null, requiredDate: '2099-03-15', vendorId: '331', vendorName: 'TEST Unilock Ltd.',
        vendorYard: 'TEST Ltd yard', salesVisibleNote: 'Ready Friday', scmInternalNote: 'Confirmed by phone' }] } });
      assert.match(await page.locator('.stock-request-summary').first().innerText(), /TEST Unilock Ltd\./);
    });
  }
});

test('SCM must pick a changed vendor from the suggestions before saving', async () => {
  await withPage({ html: scmHtml, width: 1440, detail: record(), onPost: () => ({ status: 500, body: {} }) }, async (page, state) => {
    const form = page.locator('[data-special-stock-line="1"]');
    await form.locator('[name=vendorName]').fill('Typed vendor');
    await page.getByRole('button', { name: 'Save stock check', exact: true }).click();
    await page.getByText('Select a vendor from the suggestions for every stock check.').waitFor();
    assert.equal(state.writes.length, 0);
  });
});

test('Sales sees the SCM reply with its date', async () => {
  await withPage({ html: salesHtml, width: 390, detail: record(), onPost: () => ({ status: 500, body: {} }) }, async page => {
    const reply = page.locator('.special-scm-reply').first();
    await reply.waitFor();
    assert.match(await reply.innerText(), /SCM reply · 2099-01-02T15:00:00Z\s+Ready next week/);
    assert.equal(await page.getByText('TEST internal').count(), 0);
  });
});
