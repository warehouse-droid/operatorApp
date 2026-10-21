/* global localStorage */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const out = process.env.SPECIAL_CORRECTIONS_BROWSER_OUTPUT || 'test-artifacts/special-workflow-review/sales-request-corrections-20261003/browser';
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



test('one existing line edit button edits PALLET and delivery fee in a single save, with no restart', async () => {
  const { page, state, close } = await fixture(); try {
    await expect(page.getByRole('button', { name: 'Edit case lines', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /edit.*(pallet|delivery fee)/i })).toHaveCount(0);
    const form = await openEditor(page);
    await expect(form.locator('[name=deliveryFeeRate]')).toHaveValue('235');
    await expect(form.locator('[data-special-line-notes]')).toContainText('Sales original <note>');
    await form.locator('[name=palletTotal]').fill('5'); await form.locator('[name=palletRate]').fill('45');
    await form.locator('[name=deliveryFeeRate]').fill('125.50');
    await form.screenshot({ path: out + '/combined-line-editor.png' });
    await form.getByRole('button', { name: 'Save line changes', exact: true }).click(); await expect(form).toHaveCount(0);
    assert.equal(state.posts.length, 1); assert.deepEqual(state.posts[0].body, { expectedRevision: 3, lines: [], pallet: { quantity: 5, rate: 45 }, deliveryFeeRate: 125.5 });
    assert.equal(state.record.stage, 'await_customer_confirmation'); assert.equal(state.record.lines[0].salesDecision, 'accepted');
    await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.locator('[data-special-delivery-fee-line]')).toContainText('$125.50');
    await expect(page.locator('[data-special-pallet-subtotal]')).toHaveText('$225.00');
  } finally { await close(); }
});

test('fee-only free delivery saves from the same editor on mobile and failed saves retain all typed charges', async () => {
  const { page, state, close } = await fixture({ width: 390 }); try {
    let form = await openEditor(page); await form.locator('[name=deliveryFeeRate]').fill('0');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await form.screenshot({ path: out + '/phone-line-editor.png' });
    await form.getByRole('button', { name: 'Save line changes', exact: true }).click(); await expect(form).toHaveCount(0);
    assert.deepEqual(state.posts[0].body, { expectedRevision: 3, lines: [], deliveryFeeRate: 0 });
    form = await openEditor(page); await form.locator('[name=deliveryFeeRate]').fill('50'); await form.locator('[name=palletTotal]').fill('8'); state.rejectNext = true;
    await form.getByRole('button', { name: 'Save line changes', exact: true }).click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Request changed');
    await expect(form.locator('[name=deliveryFeeRate]')).toHaveValue('50'); await expect(form.locator('[name=palletTotal]')).toHaveValue('8');
    await expect(form.getByRole('button', { name: 'Save line changes', exact: true })).toBeDisabled();
    assert.equal(state.record.deliveryFeeRate, 0);
  } finally { await close(); }
});

test('saved Sales line and decision notes remain readable before and after an SO, and on closed cases', async () => {
  for (const patch of [{}, { salesOrderId: 42, salesOrderRef: 'TEST-SOB42' }, { salesOrderId: 42, salesOrderSource: 'manual_link' }, { salesOrderId: 42, closeStatus: 'closed', stage: 'closed' }]) {
    const { page, close } = await fixture({ patch }); try {
      const notes = page.locator('[data-special-line-notes]'); await expect(notes).toHaveCount(1);
      for (const text of ['Line note', 'Sales original <note>', 'Second line', 'Customer note', 'Customer confirmed note', 'Decision reason', 'need full skid']) await expect(notes).toContainText(text);
      assert.equal(await notes.locator('note').count(), 0);
      assert.equal(await notes.locator('.special-line-note-content').first().evaluate(el => window.getComputedStyle(el).whiteSpace), 'pre-wrap');
      if (patch.salesOrderId) { await expect(page.locator('[data-special-case-lines]')).toBeVisible(); await expect(page.getByRole('button', { name: 'Edit case lines', exact: true })).toHaveCount(0); }
      await page.locator('.stock-request-detail').screenshot({ path: out + '/notes-' + (patch.stage || patch.salesOrderId || 'open') + '.png' });
    } finally { await close(); }
  }
});

test('created and manually linked SOs retain every case-line stock response, ETA and status color', async () => {
  for (const salesOrderSource of ['standalone', 'manual_link']) {
    const { page, state, close } = await fixture({ width: salesOrderSource === 'manual_link' ? 390 : 1440,
      patch: { stage: 'confirmed', salesOrderId: 42, salesOrderRef: 'TEST-SOB42', salesOrderSource, palletTotal: 0,
        lines: [{ id: 10, productName: 'Ready stone', quantity: 2, uom: 'PLT', salesDecision: 'accepted',
          supplyStatus: 'in_stock', availableDate: null, availabilityMode: 'no_projection', vendorYard: 'West yard', vendorReference: 'READY-REF', salesVisibleNote: 'Ready for pickup' },
        { id: 11, productName: 'Transfer stone', quantity: 3, uom: 'PLT', salesDecision: 'accepted',
          supplyStatus: 'vendor_transfer', availableDate: '2099-02-01', vendorYard: 'East yard', vendorReference: 'TRANSFER-REF', salesVisibleNote: 'Transfer from supplier' }] } });
    try {
      const cases = page.locator('[data-special-case-lines]');
      await expect(cases).toBeVisible();
      for (const text of ['Ready stone', 'Transfer stone', 'West yard', 'East yard', 'READY-REF', 'TRANSFER-REF', 'Ready for pickup', 'Transfer from supplier']) await expect(cases).toContainText(text);
      const ready = cases.locator('[data-special-supply-status="in_stock"]');
      const transfer = cases.locator('[data-special-supply-status="vendor_transfer"]');
      await expect(ready).toContainText('In stock'); await expect(ready).toContainText('SCM ETA');
      await expect(ready).not.toContainText('no_projection');
      await expect(ready.locator('span').first()).toHaveCSS('background-color', 'rgb(21, 128, 61)');
      await expect(transfer).toContainText('Wait for Transfer'); await expect(transfer).toContainText('2099-02-01');
      await expect(transfer.locator('span').first()).toHaveCSS('background-color', 'rgb(245, 158, 11)');
      await expect(cases.locator('input, select, textarea, button')).toHaveCount(0);
      assert.ok(await cases.evaluate(el => el.scrollWidth <= el.clientWidth));
      await cases.screenshot({ path: out + '/scm-response-' + salesOrderSource + '.png' });
      state.record.lines[1].availableDate = '2099-02-08';
      await page.reload();
      await expect(transfer).toContainText('2099-02-08'); await expect(transfer).not.toContainText('2099-02-01');
      assert.deepEqual(state.posts, []);
    } finally { await close(); }
  }
});

test('pickup uses the same PALLET editor without a delivery fee, and legacy blank fees do not block unrelated edits', async () => {
  for (const patch of [{ fulfillmentMethod: 'yard_pickup', deliveryFeeRate: null }, { deliveryFeeRate: null }]) {
    const { page, state, close } = await fixture({ patch }); try {
      const form = await openEditor(page);
      await expect(form.locator('[name=deliveryFeeRate]')).toHaveCount(patch.fulfillmentMethod ? 0 : 1);
      await form.locator('[name=palletRate]').fill('0'); await form.getByRole('button', { name: 'Save line changes', exact: true }).click();
      await expect(form).toHaveCount(0); assert.equal(state.posts.length, 1); assert.equal(Object.hasOwn(state.posts[0].body, 'deliveryFeeRate'), false);
      assert.equal(state.record.palletRate, 0);
    } finally { await close(); }
  }
});
