/* global localStorage */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const out = process.env.SCM_EDITING_TEST_ARTIFACTS || 'test-artifacts/special-stock-check-editing-20261009/browser';
let browser, capture = 0;
before(async () => { await mkdir(out, { recursive: true }); browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
after(async () => browser?.close());
async function fixture(configure = () => {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('mbbs.staff.token', 'test-stock-check'));
  const page = await context.newPage(); page.setDefaultTimeout(3000);
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  const record = { id: 1, requestRef: 'SPREQ-TEST-063', stage: 'await_customer_confirmation', revision: 14,
    storeName: '3445', storeLocationId: 1, customerName: 'TEST Customer', vendorId: 331, vendorName: 'TEST Vendor',
    closeStatus: 'active', fulfillmentMethod: 'yard_pickup', inquiryDate: '2099-01-01',
    lines: [{ id: 1, productName: 'BLU 600MM HD2', quantity: 2, uom: 'PCS', requiredDate: '2099-02-01',
      salesDecision: 'pending', supplyStatus: 'in_stock', vendorYard: 'TEST Yard' },
    { id: 2, productName: 'Split PALLET FEE for BLU 600MM HD2', quantity: 1, uom: 'PCS', requiredDate: '2099-02-01',
      salesDecision: 'declined', supplyStatus: null, vendorYard: '' }],
    salesOrderLines: [], purchaseOrderLines: [], events: [], readinessAlerts: [] };
  configure(record);
  const second = { ...record, id: 2, requestRef: 'SPREQ-TEST-064', lines: record.lines.map(line => ({ ...line, id: line.id + 10 })) };
  const state = { record, posts: [], errors: [], fail: false };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/*', async route => {
    const { pathname: path, hostname } = new URL(route.request().url());
    if (hostname !== 'localhost') { return route.abort(); }
    if (path.startsWith('/api/')) {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON(); state.posts.push(body);
        if (state.fail) { return route.fulfill({ status: 409, json: { error: 'Case changed. Try again.' } }); }
        for (const input of body.lines) {
          const line = record.lines.find(item => item.id === input.lineId);
          Object.assign(line, input);
          if (line.salesDecision === 'declined') { line.salesDecision = 'pending'; }
        }
        record.revision++;
        return route.fulfill({ json: record });
      }
      if (path === '/api/auth/me') { return route.fulfill({ json: { operator: { id: 'test-scm', role: 'scm', roles: ['scm'] } } }); }
      if (path.endsWith('/policy')) { return route.fulfill({ json: { enabled: true } }); }
      if (path.endsWith('/special-stock-requests/1')) { return route.fulfill({ json: record }); }
      if (path.endsWith('/special-stock-requests/2')) { return route.fulfill({ json: second }); }
      if (path.endsWith('/special-stock-requests')) { return route.fulfill({ json: { requests: [record, second], yards: [], vendors: [] } }); }
      return route.fulfill({ json: {} });
    }
    const file = path === '/scm/stock-requests' ? '/scm-stock-requests.html' : path;
    try { return route.fulfill({ body: await readFile('public' + file), contentType: ({ js: 'application/javascript', css: 'text/css', html: 'text/html' })[file.split('.').at(-1)] || 'application/octet-stream' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost/scm/stock-requests?tab=special');
  try { await expect(page.locator('.stock-request-heading h2')).toContainText('SPREQ-TEST-063'); }
  catch (error) {
    const screen = await page.locator('#scmStockRequestApp').innerText();
    await context.close(); error.message += '\nPage errors: ' + JSON.stringify(state.errors) + '\nScreen: ' + screen.slice(0, 1500); throw error;
  }
  const close = async () => {
    await writeFile(`${out}/coverage-${++capture}.json`, JSON.stringify(await page.coverage.stopJSCoverage()));
    await context.close();
  };
  return { page, state, close };
}

test('SCM can explicitly revise a declined line, retains edits on failure and saves its new status for customer confirmation', async () => {
  const { page, state, close } = await fixture();
  try {
    await page.getByRole('button', { name: 'Show All', exact: true }).click();
    const revise = page.getByRole('button', { name: 'Revise stock check', exact: true });
    await expect(revise).toHaveCount(1);
    await expect(page.locator('[data-special-stock-line="2"]')).toHaveCount(0);
    await page.locator('[data-special-stock-line="1"] [name=salesVisibleNote]').fill('Keep my other reply');
    await revise.click();
    const line = page.locator('[data-special-stock-line="2"]');
    await expect(line.locator('[name=supplyStatus]')).toBeVisible();
    await expect(page.locator('[data-special-stock-line="1"] [name=salesVisibleNote]')).toHaveValue('Keep my other reply');
    await expect(line).toContainText('customer confirmation');
    await line.locator('[name=supplyStatus]').selectOption('vendor_transfer');
    await expect(line.locator('[name=availableDate]')).toBeHidden();
    await expect(line.locator('[data-special-transfer-eta]')).toContainText('SO placement +5 working days');
    await line.locator('[name=vendorYard]').fill('New vendor yard');
    await line.locator('[name=salesVisibleNote]').fill('Updated fee availability');
    const save = page.getByRole('button', { name: 'Save stock check', exact: true });
    state.fail = true; await save.click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Case changed');
    await expect(line.locator('[name=supplyStatus]')).toHaveValue('vendor_transfer');
    await expect(line.locator('[data-special-transfer-eta]')).toContainText('SO placement +5 working days');
    state.fail = false; await save.click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Saved.');
    assert.equal(state.posts.length, 2);
    const sent = state.posts[1].lines.find(item => item.lineId === 2);
    assert.equal(sent.supplyStatus, 'vendor_transfer');
    assert.equal(sent.availableDate, null);
    assert.equal(sent.availabilityMode, 'so_placement');
    assert.equal(sent.salesVisibleNote, 'Updated fee availability');
    assert.equal(state.record.lines[1].salesDecision, 'pending');
    await expect(revise).toHaveCount(0);
    assert.deepEqual(state.errors, []);
    await page.screenshot({ path: out + '/revised-declined-stock-check.png', fullPage: true });
  } finally { await close(); }
});

test('saving another stock check leaves an untouched decline excluded from the batch', async () => {
  const { page, state, close } = await fixture();
  try {
    await page.getByRole('button', { name: 'Save stock check', exact: true }).click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Saved.');
    assert.deepEqual(state.posts[0].lines.map(item => item.lineId), [1]);
    assert.equal(state.record.lines[1].salesDecision, 'declined');
    await page.getByRole('button', { name: 'Show All', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Revise stock check', exact: true })).toHaveCount(1);
  } finally { await close(); }
});

test('leaving an unsaved decline revision submits nothing and returning requires a fresh explicit revision', async () => {
  const { page, state, close } = await fixture();
  try {
    await page.getByRole('button', { name: 'Show All', exact: true }).click();
    await page.getByRole('button', { name: 'Revise stock check', exact: true }).click();
    await page.locator('[data-special-stock-line="2"] [name=salesVisibleNote]').fill('Unsaved reply');
    await page.locator('.stock-request-card[data-id="2"]').click();
    await expect(page.locator('.stock-request-heading h2')).toContainText('SPREQ-TEST-064');
    await page.locator('.stock-request-card[data-id="1"]').click();
    await expect(page.getByRole('button', { name: 'Revise stock check', exact: true })).toHaveCount(1);
    await expect(page.locator('[data-special-stock-line="2"]')).toHaveCount(0);
    assert.equal(state.posts.length, 0);
    assert.equal(state.record.lines[1].salesDecision, 'declined');
  } finally { await close(); }
});

test('decline revision remains unavailable for closed lines, closed cases, pending information and created/skipped SOs', async () => {
  for (const patch of [{ closeStatus: 'closed', stage: 'closed' }, { stage: 'completed' },
    { informationRequest: { status: 'pending' } }, { salesOrderId: 42 }, { salesOrderSkipped: true },
    { purchaseOrderId: 43 }, { purchaseOrderSkipped: true }, { salesOrderOperationStatus: 'creating' },
    { purchaseOrderOperationStatus: 'attention' }, { quantityReviewPending: true, quantityReview: { id: 'TEST-review', status: 'pending', mode: 'pre_order', lines: [] } }, { attention: true },
    { closedLine: true }]) {
    const { page, close } = await fixture(record => {
      Object.assign(record, patch);
      if (patch.closedLine) { record.lines[1].salesDecision = 'closed'; }
    });
    try {
      await expect(page.getByRole('button', { name: 'Revise stock check', exact: true, includeHidden: true })).toHaveCount(0);
      await expect(page.locator('[data-special-stock-line="2"]')).toHaveCount(0);
    } finally { await close(); }
  }
});
