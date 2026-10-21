/* global localStorage, structuredClone */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const out = process.env.SPECIAL_CASE_EDITS_BROWSER_OUTPUT || 'test-artifacts/special-case-edits-20261001/browser';
let browser, capture = 0;
before(async () => { await mkdir(out, { recursive: true }); browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] }); });
after(async () => browser?.close());
async function fixture({ width = 1440, patch = {} } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('mbbs.staff.token', 'test-case-edits'));
  const page = await context.newPage(); page.setDefaultTimeout(5000); await page.coverage.startJSCoverage({ resetOnNavigation: false });
  const record = { id: 1, requestRef: 'SPREQ-000019', revision: 3, status: 'active', stage: 'await_customer_confirmation',
    closeStatus: 'active', storeLocationId: 1, storeName: '3445', customerName: 'TEST Customer', customerPhone: '555-0100',
    vendorName: 'TEST Vendor', inquiryDate: '2099-01-01', expiresOn: '2099-03-01', fulfillmentMethod: 'yard_pickup',
    palletTotal: 3, palletRate: 40, lines: [{ id: 10, productName: 'Stone', color: 'Grey', size: '80mm', detailSpec: 'Smooth',
      quantity: 2, packageQuantity: 2, uom: 'PLT', rateUom: 'PLT', originalRate: 100, discountPercent: 10, subtotal: 180,
      requiredDate: '2099-02-01', supplyStatus: 'in_stock', salesDecision: 'accepted', vendorYard: 'West yard', pricingSource: 'enquiry' }],
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
const material = form => form.locator('[data-special-case-edit-line="10"]');

test('multiple material inputs retain separate values and an unchanged unpriced legacy line permits rate and PALLET edits', async () => {
  const lines = [{ id: 10, productName: 'Stone', color: 'Grey', size: '80mm', detailSpec: 'Smooth', quantity: 2, packageQuantity: 2,
    uom: 'PLT', rateUom: 'PLT', originalRate: 100, discountPercent: 10, subtotal: 180, supplyStatus: 'in_stock', salesDecision: 'accepted' },
  { id: 11, productName: 'Step', color: 'Black', quantity: 4, packageQuantity: 4, uom: 'PC', rateUom: 'PC', originalRate: null,
    discountPercent: 0, supplyStatus: 'in_stock', salesDecision: 'accepted', pricingSource: 'legacy' }];
  const { page, state, close } = await fixture({ patch: { lines } }); try {
    let form = await openEditor(page);
    const second = form.locator('[data-special-case-edit-line="11"]');
    await expect(second.locator('[name=productName]')).toHaveValue('Step'); await expect(second.locator('[name=quantity]')).toHaveValue('4');
    assert.equal(await second.locator('[name=rate]').evaluate(input => input.required), false);
    await material(form).locator('[name=rate]').fill('80'); await form.locator('[name=palletTotal]').fill('5');
    await form.getByRole('button', { name: 'Save line changes', exact: true }).click(); await expect(form).toHaveCount(0);
    assert.equal(state.posts.length, 1); assert.equal(state.posts[0].body.lines.length, 1); assert.equal(state.posts[0].body.lines[0].lineId, 10);
    assert.equal(state.record.lines[1].originalRate, null); assert.equal(state.record.stage, 'await_customer_confirmation');
    form = await openEditor(page); await material(form).locator('[name=productName]').fill('New stone');
    await form.getByRole('button', { name: 'Save line changes', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(material(form).locator('[name=productName]')).toHaveValue('New stone');
    await expect(form.locator('[data-special-case-edit-line="11"] [name=productName]')).toHaveValue('Step');
    await expect(form.locator('[data-special-case-edit-line="11"] [name=quantity]')).toHaveValue('4');
    await expect(form.locator('[data-special-case-edit-line="11"] [name=rate]')).toHaveValue('');
    assert.equal(state.posts.length, 1);
  } finally { await close(); }
});

test('Sales edits material name and quantity, confirms a centered restart, and sees New enquiry without changing other item details', async () => {
  const { page, state, close } = await fixture(); try {
    const form = await openEditor(page), line = material(form);
    await expect(line.locator('[name=productName]')).toHaveValue('Stone'); await expect(line.locator('[name=quantity]')).toHaveValue('2');
    await expect(line.locator('[name=rate]')).toHaveValue('100'); await line.locator('[name=productName]').fill('New <stone>'); await line.locator('[name=quantity]').fill('3');
    await form.getByRole('button', { name: 'Save line changes', exact: true }).click();
    const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible(); await expect(dialog).toContainText('New enquiry'); assert.equal(state.posts.length, 0);
    const box = await dialog.boundingBox(); assert.ok(Math.abs(box.x + box.width / 2 - 720) < 1, 'Warning is centered');
    await dialog.getByRole('button', { name: 'Save and restart enquiry', exact: true }).click(); await expect(form).toHaveCount(0);
    assert.equal(state.posts.length, 1); assert.equal(state.posts[0].body.expectedRevision, 3); assert.equal(state.record.stage, 'new_enquiry');
    assert.equal(state.record.lines[0].color, 'Grey'); assert.equal(state.record.lines[0].detailSpec, 'Smooth');
    await expect(page.locator('.stock-request-detail')).toContainText('New <stone> Grey 80mm Smooth'); await expect(page.locator('[data-special-decision-line]')).toHaveCount(0);
    await page.locator('.stock-request-detail').screenshot({ path: out + '/restarted-enquiry.png' });
  } finally { await close(); }
});
test('rate and PALLET edits save without a restart warning and preserve the reviewed request stage', async () => {
  const { page, state, close } = await fixture(); try {
    const form = await openEditor(page); await material(form).locator('[name=rate]').fill('80');
    await form.locator('[name=palletTotal]').fill('5'); await form.locator('[name=palletRate]').fill('45');
    await form.getByRole('button', { name: 'Save line changes', exact: true }).click(); await expect(form).toHaveCount(0); await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.equal(state.record.stage, 'await_customer_confirmation'); assert.equal(state.record.status, 'active'); assert.equal(state.record.lines[0].supplyStatus, 'in_stock');
    assert.equal(state.record.lines[0].salesDecision, 'accepted'); assert.equal(state.posts.length, 1);
    await expect(page.locator('[data-special-pallet-quantity]')).toHaveText('5 EACH'); await expect(page.locator('[data-special-pallet-subtotal]')).toHaveText('$225.00');
    await expect(page.locator('.stock-request-detail')).toContainText('Original rate: $80.00');
  } finally { await close(); }
});
test('PALLET remains editable at zero and can be added, removed or free without restarting the enquiry on a phone', async () => {
  const { page, state, close } = await fixture({ width: 390, patch: { palletTotal: 0, palletRate: null } }); try {
    await expect(page.locator('[data-special-pallet-line]')).toHaveCount(0); let form = await openEditor(page);
    await expect(form.locator('[name=palletTotal]')).toHaveValue('0'); await form.locator('[name=palletTotal]').fill('1'); await form.locator('[name=palletRate]').fill('0');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await form.screenshot({ path: out + '/phone-editor.png' }); await form.getByRole('button', { name: 'Save line changes', exact: true }).click(); await expect(form).toHaveCount(0);
    await expect(page.locator('[data-special-pallet-subtotal]')).toHaveText('$0.00'); assert.equal(state.record.stage, 'await_customer_confirmation');
    form = await openEditor(page); await form.locator('[name=palletTotal]').fill('0'); await form.getByRole('button', { name: 'Save line changes', exact: true }).click();
    await expect(form).toHaveCount(0); await expect(page.locator('[data-special-pallet-line]')).toHaveCount(0); assert.equal(state.posts.length, 2);
  } finally { await close(); }
});
test('canceling or escaping the restart warning preserves the unsaved editor, and Cancel edits writes nothing', async () => {
  const { page, state, close } = await fixture(); try {
    const before = structuredClone(state.record), form = await openEditor(page); await material(form).locator('[name=productName]').fill('Edited');
    await form.getByRole('button', { name: 'Save line changes', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(material(form).locator('[name=productName]')).toHaveValue('Edited'); assert.equal(state.posts.length, 0);
    await form.getByRole('button', { name: 'Save line changes', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape');
    await expect(form).toBeVisible(); await form.getByRole('button', { name: 'Cancel edits', exact: true }).click(); await expect(form).toHaveCount(0);
    assert.deepEqual(state.record, before); assert.equal(state.posts.length, 0);
  } finally { await close(); }
});
test('a revision conflict retains typed values but requires reopening the current request before another save', async () => {
  const { page, state, close } = await fixture(); try {
    const form = await openEditor(page); await material(form).locator('[name=rate]').fill('80'); state.rejectNext = true;
    await form.getByRole('button', { name: 'Save line changes', exact: true }).click(); await expect(page.locator('.stock-request-feedback')).toContainText('Request changed');
    await expect(material(form).locator('[name=rate]')).toHaveValue('80'); await expect(form.getByRole('button', { name: 'Save line changes', exact: true })).toBeDisabled();
    assert.equal(state.posts.length, 1); await form.getByRole('button', { name: 'Cancel edits', exact: true }).click();
    const current = await openEditor(page); await expect(material(current).locator('[name=rate]')).toHaveValue('100');
    await material(current).locator('[name=rate]').fill('90'); await current.getByRole('button', { name: 'Save line changes', exact: true }).click(); await expect(current).toHaveCount(0);
    assert.equal(state.posts[1].body.expectedRevision, 4); assert.equal(state.record.lines[0].originalRate, 90);
  } finally { await close(); }
});
test('closed or issued requests hide the pre-SO editor, and a no-op save sends no write', async () => {
  for (const patch of [{ closeStatus: 'closed', stage: 'closed' }, { salesOrderId: 42, salesOrderRef: 'TEST-SOB42' }]) {
    const { page, state, close } = await fixture({ patch }); try { await expect(page.getByRole('button', { name: 'Edit case lines', exact: true })).toHaveCount(0); assert.equal(state.posts.length, 0); }
    finally { await close(); }
  }
  const { page, state, close } = await fixture(); try { const form = await openEditor(page); await form.getByRole('button', { name: 'Save line changes', exact: true }).click();
    await expect(form).toHaveCount(0); assert.equal(state.posts.length, 0); assert.equal(state.record.revision, 3); }
  finally { await close(); }
});
