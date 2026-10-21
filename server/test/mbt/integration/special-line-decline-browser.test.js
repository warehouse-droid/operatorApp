/* global localStorage */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const out = process.env.SPECIAL_DECLINE_BROWSER_OUTPUT || 'test-artifacts/special-workflow-review/line-decline-20261003/browser';
let browser, capture = 0;
before(async () => { await mkdir(out, { recursive: true }); browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] }); });
after(async () => browser?.close());
async function fixture({ width = 1440, patch = {} } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('mbbs.staff.token', 'test-case-edits'));
  const page = await context.newPage(); page.setDefaultTimeout(5000); await page.coverage.startJSCoverage({ resetOnNavigation: false });
  const record = { id: 1, requestRef: 'SPREQ-000019', revision: 3, status: 'active', stage: 'await_customer_confirmation',
    closeStatus: 'active', storeLocationId: 1, storeName: '3445', customerName: 'TEST Customer', customerPhone: '555-0100',
    vendorName: 'TEST Vendor', inquiryDate: '2099-01-01', expiresOn: '2099-03-01', fulfillmentMethod: 'mbt_delivery', deliveryFeeRate: 235, deliveryAddress: 'TEST Address',
    palletTotal: 3, palletRate: 40, lines: [{ id: 10, productName: 'Stone', color: 'Grey', size: '80mm', detailSpec: 'Smooth',
      quantity: 2, packageQuantity: 2, uom: 'PLT', rateUom: 'PLT', originalRate: 100, discountPercent: 10, subtotal: 180,
      requiredDate: '2099-02-01', supplyStatus: 'in_stock', salesDecision: 'accepted', vendorYard: 'West yard', pricingSource: 'enquiry', customerNote: 'Sales original <note>\nSecond line', salesCustomerNote: 'Customer confirmed note', salesDecisionReason: 'need full skid' }],
    salesOrderLines: [], purchaseOrderLines: [], media: [], events: [], readinessAlerts: [], ...patch };
  const state = { posts: [], errors: [], record, rejectNext: false };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.hostname !== 'localhost') return route.abort();
    if (path.startsWith('/api/')) {
      if (request.method() !== 'GET') {
        const body = request.postDataJSON(); state.posts.push({ path, body, method: request.method() });
        assert.equal(path, '/api/sales/special-stock-requests/1/case-lines'); assert.equal(request.method(), 'PUT');
        if (state.rejectNext) { state.rejectNext = false; record.revision++;
          return route.fulfill({ status: 409, json: { error: 'Request changed. Review the latest request.', code: 'SPECIAL_REVISION_CONFLICT' } }); }
        let restart = false;
        for (const line of body.lines || []) {
          const saved = record.lines.find(item => item.id === line.lineId);
          const structural = saved.productName !== line.productName || (saved.packageQuantity ?? saved.quantity) !== Number(line.quantity);
          restart ||= structural;
          Object.assign(saved, { productName: line.productName, originalRate: Number(line.rate), subtotal: Number(line.quantity) * Number(line.rate) * .9 });
          if (structural) Object.assign(saved, { quantity: Number(line.quantity), packageQuantity: Number(line.quantity), supplyStatus: null, salesDecision: 'pending' });
        }
        for (const change of body.decisions || []) {
          const saved = record.lines.find(line => line.id === change.lineId);
          if (change.declined) { saved.declineRestore = { decision: saved.salesDecision, responseRevision: saved.responseRevision || 0 }; saved.salesDecision = 'declined'; }
          else { saved.salesDecision = saved.declineRestore?.decision || 'pending'; saved.declineRestore = {}; }
          record.lineDecisionsNeedReview = true;
        }
        if (body.pallet) Object.assign(record, { palletTotal: Number(body.pallet.quantity), palletRate: body.pallet.rate === '' ? null : Number(body.pallet.rate) });
        if (Object.hasOwn(body, 'deliveryFeeRate')) record.deliveryFeeRate = body.deliveryFeeRate;
        if (restart) Object.assign(record, { status: 'submitted', stage: 'new_enquiry', salesOrderLines: [], purchaseOrderLines: [] });
        record.revision++; return route.fulfill({ json: record });
      }
      if (path === '/api/auth/me') return route.fulfill({ json: { operator: { id: 'test-case-edits', display_name: 'TEST Sales', role: 'sales', roles: ['sales'], yard_location_ids: [1] } } });
      if (path.endsWith('/policy')) return route.fulfill({ json: { enabled: true } });
      if (path.endsWith('/special-stock-requests')) return route.fulfill({ json: { yards: [{ locationId: 1, yardCode: '3445' }], vendors: ['TEST Vendor'], requests: [record] } });
      if (path.endsWith('/special-stock-requests/1')) return route.fulfill({ json: record });
      return route.fulfill({ json: { requests: [], yards: [], total: 0, salesReps: [] } });
    }
    const file = path === '/sales/stock-requests' ? '/sales-stock-requests.html' : path;
    try { return route.fulfill({ body: await readFile('public' + file), contentType:
      ({ js: 'application/javascript', css: 'text/css', html: 'text/html' })[file.split('.').at(-1)] || 'application/octet-stream' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost/sales/stock-requests?tab=special');
  await expect(page.locator('.stock-request-card[data-id="1"]')).toBeVisible();
  return { page, state, close: async () => { assert.deepEqual(state.errors, []);
    await writeFile(`${out}/coverage-${++capture}.json`, JSON.stringify(await page.coverage.stopJSCoverage())); await context.close(); } };
}
async function openEditor(page) { await page.getByRole('button', { name: 'Edit case lines', exact: true }).click();
  const form = page.locator('[data-special-case-edit-form]'); await expect(form).toBeVisible(); return form; }




test('bottom-right Decline/Revoke decline keeps the only line visible and saves through the existing case editor', async () => {
  const { page, state, close } = await fixture({ patch: { salesOrderLines: [{ caseLineId: 10, itemId: 2055, quantity: 2, rate: 100, uom: 'PC', description: 'Stone' }] } }); try {
    let form = await openEditor(page), line = form.locator('[data-special-case-edit-line="10"]');
    const button = line.getByRole('button', { name: 'Decline', exact: true }); await expect(button).toBeVisible();
    const cardBox = await line.boundingBox(), buttonBox = await button.boundingBox();
    assert.ok(cardBox.x + cardBox.width - buttonBox.x - buttonBox.width < 25);
    assert.ok(cardBox.y + cardBox.height - buttonBox.y - buttonBox.height < 25);
    await expect(form.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
    await button.click(); await expect(line).toHaveCount(1); await expect(line.getByRole('button', { name: 'Revoke decline', exact: true })).toBeVisible();
    await expect(line).toContainText('Declined'); await expect(line).toContainText('Sales original <note>'); assert.equal(state.posts.length, 0);
    await form.screenshot({ path: out + '/staged-decline.png' });
    await form.getByRole('button', { name: 'Save line changes', exact: true }).click(); await expect(form).toHaveCount(0);
    assert.deepEqual(state.posts[0].body, { expectedRevision: 3, lines: [], decisions: [{ lineId: 10, declined: true }] });
    assert.equal(state.record.lines.length, 1); assert.equal(state.record.lines[0].salesDecision, 'declined'); assert.equal(state.record.stage, 'await_customer_confirmation');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    form = await openEditor(page); line = form.locator('[data-special-case-edit-line="10"]');
    await line.getByRole('button', { name: 'Revoke decline', exact: true }).click();
    await form.getByRole('button', { name: 'Save line changes', exact: true }).click(); await expect(form).toHaveCount(0);
    assert.deepEqual(state.posts[1].body, { expectedRevision: 4, lines: [], decisions: [{ lineId: 10, declined: false }] });
    assert.equal(state.record.lines[0].salesDecision, 'accepted'); assert.equal(state.record.lines.length, 1);
    await expect(page.getByRole('button', { name: 'Create in NetSuite', exact: true })).toBeDisabled();
  } finally { await close(); }
});

test('mobile toggles keep typed charge edits and cancellation restores the original line without a write', async () => {
  const { page, state, close } = await fixture({ width: 390 }); try {
    const form = await openEditor(page); await form.locator('[name=palletTotal]').fill('5'); await form.locator('[name=deliveryFeeRate]').fill('0');
    const line = form.locator('[data-special-case-edit-line="10"]'); await line.getByRole('button', { name: 'Decline', exact: true }).click();
    await expect(form.locator('[name=palletTotal]')).toHaveValue('5'); await expect(form.locator('[name=deliveryFeeRate]')).toHaveValue('0');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await form.screenshot({ path: out + '/phone-decline.png' });
    await form.getByRole('button', { name: 'Cancel edits', exact: true }).click(); await expect(form).toHaveCount(0);
    assert.equal(state.posts.length, 0); assert.equal(state.record.lines[0].salesDecision, 'accepted'); assert.equal(state.record.palletTotal, 3);
  } finally { await close(); }
});

test('revision conflicts retain the decline draft, and closed lines and issued requests keep their existing locks', async () => {
  const { page, state, close } = await fixture(); try {
    const form = await openEditor(page); await form.getByRole('button', { name: 'Decline', exact: true }).click(); state.rejectNext = true;
    await form.getByRole('button', { name: 'Save line changes', exact: true }).click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Request changed');
    await expect(form.getByRole('button', { name: 'Revoke decline', exact: true })).toBeDisabled();
    await expect(form.getByRole('button', { name: 'Save line changes', exact: true })).toBeDisabled();
    assert.equal(state.record.lines[0].salesDecision, 'accepted'); assert.equal(state.posts.length, 1);
  } finally { await close(); }
  const closed = await fixture({ patch: { lines: [{ id: 10, productName: 'Closed line', quantity: 1, originalRate: 10, salesDecision: 'closed' }] } });
  try { const form = await openEditor(closed.page); await expect(form.getByRole('button', { name: 'Decline', exact: true })).toBeDisabled(); }
  finally { await closed.close(); }
  const issued = await fixture({ patch: { salesOrderId: 42, salesOrderRef: 'TEST-SOB42' } });
  try { await expect(issued.page.getByRole('button', { name: 'Edit case lines', exact: true })).toHaveCount(0); }
  finally { await issued.close(); }
});
