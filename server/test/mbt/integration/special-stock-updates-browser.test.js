/* global document, localStorage */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

let browser;
let capture = 0;
const out = 'test-artifacts/special-workflow-review/stock-updates-20261002/browser';
before(async () => { await mkdir(out, { recursive: true }); browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] }); });
after(async () => browser?.close());
async function fixture(audience, width = 1440, configure = () => {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('mbbs.staff.token', 'test-batch'));
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  const close = context.close.bind(context);
  context.close = async () => {
    await writeFile(`${out}/browser-coverage-${++capture}.json`, JSON.stringify(await page.coverage.stopJSCoverage()));
    return close();
  };
  const record = { id: 1, requestRef: 'SPREQ-BATCH', stage: 'new_enquiry', revision: 1, storeName: '3445', storeLocationId: 1,
    customerName: 'TEST Customer', vendorName: 'TEST Vendor', vendorId: 8899200, inquiryDate: '2099-01-01', closeStatus: 'active', fulfillmentMethod: 'yard_pickup',
    lines: [1].map(id => ({ id, productName: `TEST product ${id}`, quantity: 2, uom: 'PLT', salesDecision: 'pending', supplyStatus: null, vendorYard: `Yard ${id}` })),
    salesOrderLines: [], purchaseOrderLines: [], events: [], media: [], readinessAlerts: [] };
  configure(record);
  const state = { record, posts: [], errors: [], fail: false };
  page.on('pageerror', e => state.errors.push(e.message));
  await page.route('**/*', async route => {
    const { pathname: path, hostname } = new URL(route.request().url());
    if (hostname !== 'localhost') return route.abort();
    if (path.startsWith('/api/')) {
      if (['POST','PUT'].includes(route.request().method())) {
        const body = route.request().postDataJSON(); state.posts.push({ path, body });
        if (state.fail) return route.fulfill({ status: 409, json: { error: 'Review changed. Try again.' } });
        if (path.endsWith('/sales-order-draft')) record.netsuiteSalesRepId = Number(body.salesRepId);
        if (path.endsWith('/sales-order/create')) { record.salesOrderId = 10; record.salesOrderRef = 'TEST-SO'; }
        if (path.endsWith('/purchase-order/create')) { record.purchaseOrderId = 20; record.purchaseOrderRef = 'TEST-PO'; }
        for (const input of body.lines || []) {
          const line = record.lines.find(l => l.id === input.lineId);
          if (line) Object.assign(line, input, input.decision ? { salesDecision: input.decision } : {});
        }
        if (path.endsWith('/request-information')) { record.informationRequest = { status: 'pending', question: body.question }; record.stage = 'pending_update'; }
        if (path.endsWith('/information-update')) { record.informationRequest = { ...record.informationRequest, status: 'answered', reply: body.reply }; record.stage = 'new_enquiry'; }
        record.revision++;
        return route.fulfill({ json: record });
      }
      if (path === '/api/sales/special-stock-requests/alerts') { const pendingUpdate = record.informationRequest?.status === 'pending' ? 1 : 0; return route.fulfill({ json: { pendingUpdate, awaitCustomerConfirmation: 0, dispatchArrangement: 0, waitForProduction: 0, total: pendingUpdate } }); }
      if (path.endsWith('/sales-reps')) return route.fulfill({ json: { salesReps: [{ id: 123, name: 'TEST NetSuite Rep A' }, { id: 456, name: 'TEST NetSuite Rep B' }] } });
      if (path.endsWith('/vendors')) return route.fulfill({ json: { vendors: [{id:8899200,name:'TEST Vendor'}] } });
      if (path === '/api/auth/me') return route.fulfill({ json: { operator: { id: 'test-batch', display_name: 'TEST Rep', role: audience, roles: [audience] } } });
      if (path.endsWith('/policy')) return route.fulfill({ json: { enabled: true } });
      if (path.endsWith('/special-stock-requests/1')) return route.fulfill({ json: record });
      if (path.endsWith('/special-stock-requests')) return route.fulfill({ json: { yards: [{ locationId: 1, yardCode: '3445' }], requests: [record] } });
      return route.fulfill({ json: { requests: [], yards: [], total: 0 } });
    }
    const file = ({ '/scm/stock-requests': '/scm-stock-requests.html', '/sales/stock-requests': '/sales-stock-requests.html' })[path] || path;
    try { return route.fulfill({ body: await readFile('public' + file), contentType: ({ js: 'application/javascript', css: 'text/css', html: 'text/html' })[file.split('.').at(-1)] || 'application/octet-stream' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(`http://localhost/${audience}/stock-requests?tab=special`);
  await page.locator('.stock-request-card[data-id="1"]').click();
  return { page, context, state };
}

test('SCM can save Low inventory without ETA and can request information before checking', async () => {
  const { page, context, state } = await fixture('scm');
  try {
    await page.locator('[name=supplyStatus]').selectOption('low_inventory');
    await expect(page.locator('[name=availableDate]')).toBeDisabled();
    await page.getByRole('button', { name: 'Save stock check', exact: true }).click();
    await expect.poll(() => state.posts.length).toBe(1);
    assert.equal(state.posts[0].body.lines[0].supplyStatus, 'low_inventory');
    assert.equal(state.posts[0].body.lines[0].availableDate, null);
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
  const second = await fixture('scm');
  try {
    await second.page.locator('[name=question]').fill('Please confirm size <large>.');
    second.state.fail = true;
    await second.page.getByRole('button', { name: 'Ask Sales for more information' }).click();
    await expect(second.page.locator('.stock-request-feedback')).toContainText('Review changed');
    await expect(second.page.locator('[name=question]')).toHaveValue('Please confirm size <large>.');
    second.state.fail = false;
    await second.page.getByRole('button', { name: 'Ask Sales for more information' }).click();
    await expect(second.page.locator('.special-information-request')).toContainText('Pending Update');
    await expect(second.page.getByRole('button', { name: 'Save stock check', exact: true })).toHaveCount(0);
    assert.equal(second.state.posts.at(-1).body.question, 'Please confirm size <large>.');
    assert.deepEqual(second.state.errors, []);
  } finally { await second.context.close(); }
});

test('Sales sees an alert, answers SCM, and can confirm low inventory normally', async () => {
  const { page, context, state } = await fixture('sales', 390, record => {
    record.stage = 'pending_update'; record.informationRequest = { status: 'pending', question: 'Confirm size <large>.' };
  });
  try {
    await expect(page.locator('.special-information-request')).toContainText('Confirm size <large>.');
    await expect(page.locator('.stock-request-card')).toContainText('Update required');
    await expect(page.locator('.sales-special-alert')).toHaveAccessibleName(/1 Pending Update/);
    await expect(page.locator('.sales-special-alert')).toHaveAttribute('href', /stages=pending_update,/);
    await page.locator('[name=reply]').fill('Large, blue.');
    await page.getByRole('button', { name: 'Submit update to SCM' }).click();
    await expect(page.locator('.special-information-request')).toContainText('Large, blue.');
    assert.equal(state.posts.at(-1).body.reply, 'Large, blue.');
    await page.evaluate(() => window.MBBSSalesSpecialAlert.refresh());
    await expect(page.locator('.sales-special-alert')).toBeHidden();
    assert.deepEqual(state.errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: `${out}/sales-information-mobile.png` });
  } finally { await context.close(); }
  const available = await fixture('sales', 1440, record => { record.lines[0].supplyStatus = 'low_inventory'; });
  try {
    await expect(available.page.locator('.stock-request-detail')).toContainText('Low inventory');
    await available.page.locator('[name=decision]').selectOption('accepted');
    await expect(available.page.locator('[name=decision] option:checked')).toHaveText('Customer confirms');
  } finally { await available.context.close(); }
});

test('Planned PO and delivery SO, or fulfilled pickup SO, have green containers and white text', async () => {
  for (const method of ['mbt_delivery', 'yard_pickup']) {
    const { page, context, state } = await fixture('sales', 1440, record => {
      Object.assign(record, { fulfillmentMethod: method, salesOrderId: 101, salesOrderRef: 'SO-TEST', purchaseOrderId: 102, purchaseOrderRef: 'PO-TEST',
        purchaseOrderApproved: true, salesOrderFulfillmentStatus: 'Fulfilled', dispatchPlanning: { anyPlanned: true, salesOrder: { planned: true, plans: [] }, purchaseOrder: { planned: true, plans: [] } } });
    });
    try {
      const statuses = page.locator('.special-sales-planning .special-planning-order');
      await expect(statuses).toHaveCount(4);
      for (const element of await statuses.all()) {
        await expect(element).toHaveCSS('background-color', 'rgb(0, 133, 42)');
        await expect(element.locator('strong')).toHaveCSS('color', 'rgb(255, 255, 255)');
        await expect(element.locator('.special-planning-order-status')).toHaveCSS('color', 'rgb(255, 255, 255)');
      }
      if (method === 'yard_pickup') await expect(page.locator('.stock-request-detail .special-sales-planning')).toContainText('SO fulfillment');
      else await expect(page.locator('.stock-request-detail .special-sales-planning')).toContainText('SO planning');
      await page.screenshot({ path: `${out}/sales-status-${method}.png` });
      assert.deepEqual(state.errors, []);
    } finally { await context.close(); }
  }
});

test('SCM treats accepted Low inventory as ready and shows the combined PO reference in its queue and order section', async () => {
  const { page, context, state } = await fixture('scm', 1440, record => {
    Object.assign(record, { salesOrderId: 101, salesOrderRef: 'SO-TEST', purchaseOrderId: 102, purchaseOrderRef: 'PO-TEST', purchaseOrderReference: 'SN1401999', purchaseOrderApproved: true });
    Object.assign(record.lines[0], { salesDecision: 'accepted', supplyStatus: 'low_inventory' });
  });
  try {
    await expect(page.locator('[name=ready]')).toHaveValue('true');
    await expect(page.locator('[name=eta]')).toBeDisabled();
    await expect(page.locator('.stock-request-card')).toContainText('PO-TEST / SN1401999');
    await expect(page.locator('.special-planning-documents')).toContainText('PO-TEST / SN1401999');
    await expect(page.getByRole('button', { name: 'Preview PO', exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: 'Save stock check', exact: true }).click();
    await expect.poll(() => state.posts.length).toBe(1);
    assert.equal(state.posts[0].body.lines[0].ready, true); assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});
