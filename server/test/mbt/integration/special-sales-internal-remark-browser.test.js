/* global localStorage */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const out = 'test-artifacts/special-workflow-review/sales-internal-remark-20261003/browser';
let browser, capture = 0;
before(async () => { await mkdir(out, { recursive: true }); browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] }); });
after(async () => browser?.close());
const secret = '\nSales private <img src=x onerror=alert(1)>\n内部备注 & follow-up';
async function fixture({ audience = 'sales', width = 1440, patch = {} } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('mbbs.staff.token', 'test-internal-remark'));
  const page = await context.newPage(); page.setDefaultTimeout(5000); await page.coverage.startJSCoverage({ resetOnNavigation: false });
  const record = { id: 1, requestRef: 'SPREQ-TEST', revision: 3, status: 'active', stage: 'new_enquiry', closeStatus: 'active',
    storeLocationId: 1, storeName: '3445', customerName: 'TEST Customer', vendorName: 'TEST Vendor', remarks: 'Customer Note', salesInternalRemark: 'Original internal remark',
    inquiryDate: '2099-01-01', expiresOn: '2099-03-01', fulfillmentMethod: 'yard_pickup', netsuiteSalesRepId: 123,
    lines: [{ id: 10, productName: 'Stone', quantity: 2, packageQuantity: 2, uom: 'PCS', originalRate: 10, requiredDate: '2099-02-01', salesDecision: 'pending' }],
    salesOrderLines: [], purchaseOrderLines: [], media: [], events: [], readinessAlerts: [], ...patch };
  const state = { record, posts: [], errors: [], failure: 0 };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), { pathname: path, hostname } = new URL(request.url());
    if (hostname !== 'localhost') return route.abort();
    if (path.startsWith('/api/')) {
      if (['POST', 'PUT'].includes(request.method())) {
        const body = request.postDataJSON(); state.posts.push({ path, body });
        if (state.failure) {
          const status = state.failure; state.failure = 0;
          if (status === 409) { record.revision++; record.salesInternalRemark = 'Another Sales update'; }
          return route.fulfill({ status, json: { error: status === 409 ? 'Request changed. Reload before saving.' : 'Save failed. Please retry.' } });
        }
        assert.equal(Number(body.expectedRevision), record.revision);
        for (const field of ['remarks', 'salesInternalRemark']) if (Object.hasOwn(body, field)) record[field] = body[field];
        record.revision++; return route.fulfill({ json: record });
      }
      if (path === '/api/auth/me') return route.fulfill({ json: { operator: { id: 'test-internal-remark', display_name: 'TEST Staff', role: audience, roles: [audience], yard_location_ids: [1] } } });
      if (path.endsWith('/policy')) return route.fulfill({ json: { enabled: true } });
      if (path.endsWith('/special-stock-requests')) return route.fulfill({ json: { yards: [{ locationId: 1, yardCode: '3445' }], requests: [record] } });
      if (path.endsWith('/special-stock-requests/1')) return route.fulfill({ json: record });
      return route.fulfill({ json: { requests: [], yards: [], total: 0, salesReps: [{ id: 123, name: 'TEST Sales' }] } });
    }
    const file = ({ '/sales/stock-requests': '/sales-stock-requests.html', '/scm/stock-requests': '/scm-stock-requests.html' })[path] || path;
    try { return route.fulfill({ body: await readFile('public' + file), contentType: ({ js: 'application/javascript', css: 'text/css', html: 'text/html' })[file.split('.').at(-1)] || 'application/octet-stream' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(`http://localhost/${audience}/stock-requests?tab=special`);
  await page.locator('.stock-request-card[data-id="1"]').click();
  return { page, state, close: async () => {
    assert.deepEqual(state.errors, []); await writeFile(`${out}/coverage-${++capture}.json`, JSON.stringify(await page.coverage.stopJSCoverage())); await context.close();
  } };
}
test('Sales saves both notes in one header row and copied requests retain the private remark', async () => {
  const { page, state, close } = await fixture();
  try {
    const note = page.locator('[name=remarks]'), internal = page.locator('[name=salesInternalRemark]');
    await expect(internal).toHaveValue('Original internal remark');
    const a = await note.boundingBox(), b = await internal.boundingBox(); assert.ok(Math.abs(a.y - b.y) < 2); assert.ok(b.x > a.x + a.width);
    await internal.fill(secret); await note.fill('Updated customer Note');
    await page.getByRole('button', { name: 'Save header', exact: true }).click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Header saved');
    assert.equal(state.posts[0].body.salesInternalRemark, secret); assert.equal(state.record.remarks, 'Updated customer Note');
    await expect(page.locator('[name=salesInternalRemark]')).toHaveValue(secret); await expect(page.locator('.special-request-notes img')).toHaveCount(0);
    await page.screenshot({ path: out + '/sales-header-desktop.png' });
    await page.getByRole('button', { name: 'Copy the request', exact: true }).click();
    await expect(page.locator('[data-special-case-form] [name=salesInternalRemark]')).toHaveValue(secret);
    await expect(page.locator('[data-special-case-form] [name=remarks]')).toHaveValue('Updated customer Note');
  } finally { await close(); }
});
test('After SO/PO planning the independent remark saves, preserves drafts on errors and rejects stale saves until reload', async () => {
  const { page, state, close } = await fixture({ patch: { salesOrderId: 11, purchaseOrderId: 12, dispatchPlanning: { anyPlanned: true }, stage: 'dispatch_arrangement' } });
  try {
    const field = page.locator('[name=salesInternalRemark]'), save = page.getByRole('button', { name: 'Save internal remark', exact: true });
    await field.fill(secret); state.failure = 500; await save.click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Save failed'); await expect(field).toHaveValue(secret);
    state.failure = 409; await save.click();
    await expect(page.locator('[data-special-internal-remark-conflict]')).toBeVisible(); await expect(field).toHaveValue(secret); await expect(save).toBeDisabled();
    await page.getByRole('button', { name: 'Reload remark', exact: true }).click();
    await expect(field).toHaveValue('Another Sales update'); await expect(save).toBeEnabled();
    await field.fill(secret); await save.click(); await expect(page.locator('.stock-request-feedback')).toContainText('internal remark saved');
    assert.equal(state.posts.at(-1).path, '/api/sales/special-stock-requests/1/internal-remark'); assert.equal(state.posts.at(-1).body.expectedRevision, '4');
    assert.equal(state.record.remarks, 'Customer Note'); assert.equal(state.record.stage, 'dispatch_arrangement');
    await field.fill(''); await save.click(); await expect(field).toHaveValue(''); assert.equal(state.record.salesInternalRemark, '');
  } finally { await close(); }
});
test('Mobile stacks the two notes without overflow and closed cases show escaped read-only Sales text', async () => {
  const mobile = await fixture({ width: 390 });
  try {
    const note = await mobile.page.locator('[name=remarks]').boundingBox(), internal = await mobile.page.locator('[name=salesInternalRemark]').boundingBox();
    assert.ok(internal.y > note.y + note.height); assert.ok(Math.abs(internal.x - note.x) < 2);
    assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await mobile.page.screenshot({ path: out + '/sales-header-mobile.png' });
  } finally { await mobile.close(); }
  const closed = await fixture({ patch: { closeStatus: 'closed', stage: 'closed', salesInternalRemark: secret } });
  try { await expect(closed.page.locator('.special-sales-internal-remark')).toContainText('内部备注'); await expect(closed.page.locator('[name=salesInternalRemark]')).toHaveCount(0); await expect(closed.page.locator('.special-request-notes img')).toHaveCount(0); }
  finally { await closed.close(); }
});
test('SCM keeps the customer Note and has no Sales internal remark control or display', async () => {
  const { page, close } = await fixture({ audience: 'scm', patch: { salesInternalRemark: secret } });
  try {
    await expect(page.locator('.stock-request-detail')).toContainText('Customer Note');
    await expect(page.locator('.stock-request-detail')).not.toContainText('内部备注');
    await expect(page.locator('[name=salesInternalRemark]')).toHaveCount(0);
  } finally { await close(); }
});
