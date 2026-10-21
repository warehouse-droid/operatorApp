/* global localStorage, window, document, EventTarget, MessageEvent, CustomEvent */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
let browser, capture = 0;
const out = 'test-artifacts/special-delivery-method-20261009/browser';
before(async () => { await mkdir(out, { recursive: true }); browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] }); });
after(async () => browser?.close());
const notice = (id = 8, method = 'yard_pickup') => ({ id, audience: 'scm', requestId: 1, requestRef: 'SPREQ-000041', beforeMethod: 'vendor_pickup', fulfillmentMethod: method,
  yardName: '3445', salesOrderRef: 'SOB122143', purchaseOrderRef: 'POB03999', purchaseOrderReference: 'SN1402193', createdAt: '2026-10-09T12:00:00Z' });
async function fixture(role = 'scm', width = 1440, salesPage = false, configure = () => {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('mbbs.staff.token', 'method-test');
    window.methodEvents = new EventTarget();
    window.MBBSAppEventStream = { connect: () => ({ addEventListener: (...args) => window.methodEvents.addEventListener(...args), close() {} }) };
  });
  const page = await context.newPage(); page.setDefaultTimeout(5000); await page.coverage.startJSCoverage({ resetOnNavigation: false });
  const record = { id: 1, requestRef: 'SPREQ-000041', stage: 'confirmed', revision: 19, closeStatus: 'active', storeLocationId: 1, storeName: '3445', operationalYardLocationId: 1,
    customerName: 'TEST', vendorName: 'TEST', vendorId: 99, inquiryDate: '2026-10-09', fulfillmentMethod: 'vendor_pickup', salesOrderId: 1042205, salesOrderRef: 'SOB122143',
    salesOrderApproved: true, purchaseOrderId: 1042761, purchaseOrderRef: 'POB03999', purchaseOrderReference: 'SN1402193', purchaseOrderApproved: true,
    dispatchPlanning: { anyPlanned: false }, lines: [{ id: 1, productName: 'Stone', quantity: 3, uom: 'SQFT', salesDecision: 'accepted', supplyStatus: 'in_stock' }],
    salesOrderLines: [], purchaseOrderLines: [], media: [], events: [], readinessAlerts: [] };
  const state = { role, publicSales: false, record, alerts: salesPage ? [] : [notice()], posts: [], errors: [], reads: [], ackFail: false, readFail: false,
    readStatus: 200, authStatus: 200, invalidPayload: false, abortAck: false, holdAck: false, heldAck: null, useClock: false };
  configure(state);
  if (state.useClock) await page.clock.install();
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (url.hostname !== 'localhost') return route.abort();
    if (path.startsWith('/api/')) {
      if (path === '/api/auth/me') return route.fulfill({ status: state.authStatus, json: { operator: { id: 'method-user', role: state.role, roles: [state.role], yardLocationIds: [1], publicSales: state.publicSales } } });
      if (path.includes('/delivery-method-alerts')) {
        const audience = path.split('/')[2];
        if (path.endsWith('/ack')) {
          const id = Number(path.split('/').at(-2)); state.posts.push({ path, body: route.request().postDataJSON() });
          if (state.abortAck) return route.abort();
          if (state.holdAck) { state.heldAck = route; return; }
          if (state.ackFail) return route.fulfill({ status: 500, json: { error: 'Save interrupted' } });
          state.alerts = state.alerts.filter(row => row.id !== id); return route.fulfill({ json: { acknowledged: true } });
        }
        state.reads.push(audience);
        if (state.readStatus !== 200) return route.fulfill({ status: state.readStatus, json: { error: 'Access changed' } });
        if (state.invalidPayload) return route.fulfill({ json: { alerts: [{ ...notice(), beforeMethod: 'INVALID' }] } });
        if (state.readFail) return route.fulfill({ status: 500, json: { error: 'Offline' } });
        return route.fulfill({ json: { alerts: state.alerts.map(row => ({ ...row, audience })) } });
      }
      if (route.request().method() === 'POST' && path.endsWith('/fulfillment')) {
        const body = route.request().postDataJSON(); state.posts.push({ path, body });
        Object.assign(record, { fulfillmentMethod: body.fulfillmentMethod, revision: record.revision + 2 });
        return route.fulfill({ json: record });
      }
      if (path.endsWith('/policy')) return route.fulfill({ json: { enabled: true } });
      if (path.endsWith('/special-stock-requests/1')) return route.fulfill({ json: record });
      if (path.endsWith('/special-stock-requests')) return route.fulfill({ json: { yards: [{ locationId: 1, yardCode: '3445' }], requests: [record] } });
      return route.fulfill({ json: { alerts: [], requests: [], yards: [], newRequests: 0, confirmedOrders: 0, total: 0 } });
    }
    if (path.endsWith('/method-test')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><script src="/app-sidebar.js" defer></script></head><body><header class="topbar"><div class="topbar-actions"></div></header><main>Team workspace</main></body></html>' });
    const file = path === '/sales/stock-requests' ? '/sales-stock-requests.html' : path;
    try { return route.fulfill({ body: await readFile('public' + file), contentType: ({ js: 'application/javascript', css: 'text/css', html: 'text/html' })[file.split('.').at(-1)] || 'application/octet-stream' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(salesPage ? 'http://localhost/sales/stock-requests?tab=special' : `http://localhost/${role === 'dispatcher' ? 'dispatch' : 'scm'}/method-test`);
  return { page, state, close: async () => { await writeFile(`${out}/coverage-${++capture}.json`, JSON.stringify(await page.coverage.stopJSCoverage())); await context.close(); } };
}
for (const width of [1440, 390]) test(`Sales can change linked SPREQ pickup at width ${width} and sees team notification guidance`, async () => {
  const { page, state, close } = await fixture('sales', width, true);
  try {
    await page.locator('.stock-request-card[data-id="1"]').click();
    const form = page.locator('[data-special-fulfillment-form]'); await expect(form).toBeVisible();
    await expect(form).toContainText('SCM and Dispatch'); await expect(form).toContainText('PO reference');
    await form.locator('[name=fulfillmentMethod]').selectOption('yard_pickup'); await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => state.posts.length).toBe(1);
    assert.equal(state.posts[0].path, '/api/sales/special-stock-requests/1/fulfillment');
    assert.equal(state.posts[0].body.expectedRevision, 19); assert.equal(state.posts[0].body.fulfillmentMethod, 'yard_pickup');
    await expect(page.getByText('Delivery method saved. SCM and Dispatch alerted.', { exact: true })).toBeVisible();
    assert.equal(state.record.purchaseOrderReference, 'SN1402193'); assert.deepEqual(state.errors, []);
    await page.screenshot({ path: `${out}/sales-${width}.png`, fullPage: true });
  } finally { await close(); }
});
for (const role of ['scm', 'scm_staff', 'dispatcher']) test(`${role} sees a durable change popup with yard and order references`, async () => {
  const { page, state, close } = await fixture(role, role === 'dispatcher' ? 390 : 1440);
  try {
    const dialog = page.locator('.special-delivery-method-dialog'); await expect(dialog).toBeVisible();
    for (const text of ['SPREQ-000041', 'Customer pickup at vendor yard', 'Pickup at inquired yard', '3445', 'SOB122143', 'POB03999', 'SN1402193']) { await expect(dialog).toContainText(text); }
    assert.deepEqual([...new Set(state.reads)], [role === 'dispatcher' ? 'dispatch' : 'scm']);
    await page.screenshot({ path: `${out}/${role}-notice.png` });
    await dialog.getByRole('button', { name: 'Acknowledge' }).click(); await expect(dialog).toHaveCount(0);
    assert.equal(state.posts.length, 1); assert.match(state.posts[0].path, /delivery-method-alerts\/8\/ack$/); assert.deepEqual(state.errors, []);
  } finally { await close(); }
});
test('failed acknowledgement is retained, later events refresh, hostile text stays text, and logout removes team notices', async () => {
  const { page, state, close } = await fixture();
  try {
    const dialog = page.locator('.special-delivery-method-dialog'); await expect(dialog).toBeVisible();
    state.ackFail = true; await dialog.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(dialog.getByRole('status')).toContainText('Save interrupted'); await expect(dialog.getByRole('button', { name: 'Acknowledge' })).toBeEnabled();
    state.readFail = true; await page.evaluate(() => window.MBBSSpecialDeliveryMethodAlerts.refresh()); await expect(dialog).toBeVisible();
    state.ackFail = false; state.readFail = false; await dialog.getByRole('button', { name: 'Acknowledge' }).click(); await expect(dialog).toHaveCount(0);
    state.alerts = [{ ...notice(9, 'vendor_pickup'), requestRef: '<img src=x onerror="window.leaked=true">' }];
    await page.evaluate(() => window.methodEvents.dispatchEvent(new MessageEvent('app-event', { data: JSON.stringify({ type: 'special-stock-request.updated' }) })));
    await expect(dialog).toBeVisible(); await expect(dialog).toContainText('<img src=x'); assert.equal(await dialog.locator('img').count(), 0);
    state.role = 'sales'; await page.evaluate(() => { localStorage.setItem('mbbs.staff.token', 'sales-session'); window.dispatchEvent(new CustomEvent('mbbs-auth-operator-changed')); });
    await expect(dialog).toHaveCount(0); await expect(page.locator('.special-delivery-method-alert')).toHaveCount(0); assert.deepEqual(state.errors, []);
  } finally { await close(); }
});
test('pending notices survive reload, and public sessions never query private team alerts', async () => {
  const { page, state, close } = await fixture();
  try {
    await expect(page.locator('.special-delivery-method-dialog')).toBeVisible();
    await page.reload(); await expect(page.locator('.special-delivery-method-dialog')).toBeVisible();
    state.publicSales = true; const reads = state.reads.length;
    await page.evaluate(() => { localStorage.setItem('mbbs.staff.token', 'public-session'); window.dispatchEvent(new CustomEvent('mbbs-auth-operator-changed')); });
    await expect(page.locator('.special-delivery-method-dialog')).toHaveCount(0);
    await page.evaluate(() => window.MBBSSpecialDeliveryMethodAlerts.refresh()); assert.equal(state.reads.length, reads);
  } finally { await close(); }
});
test('polling and closing an existing dialog reveal queued notices without interrupting another form', async () => {
  const { page, state, close } = await fixture('scm', 1440, false, value => { value.alerts = []; value.useClock = true; });
  try {
    await expect.poll(() => state.reads.length).toBeGreaterThan(0);
    await page.evaluate(() => { const modal = document.createElement('dialog'); modal.id = 'existing-form'; modal.textContent = 'Current form'; document.body.append(modal); modal.showModal(); });
    state.alerts = [notice()]; await page.clock.fastForward(30001);
    await expect(page.locator('.special-delivery-method-alert')).toContainText('1'); await expect(page.locator('.special-delivery-method-dialog')).toHaveCount(0);
    await page.evaluate(() => document.querySelector('#existing-form').close()); await expect(page.locator('.special-delivery-method-dialog')).toBeVisible();
    assert.deepEqual(state.errors, []);
  } finally { await close(); }
});
test('malformed notices retain the current alert and revoked endpoint access clears private data', async () => {
  const { page, state, close } = await fixture();
  try {
    const dialog = page.locator('.special-delivery-method-dialog'); await expect(dialog).toBeVisible();
    state.invalidPayload = true; await page.evaluate(() => window.MBBSSpecialDeliveryMethodAlerts.refresh()); await expect(dialog).toContainText('SPREQ-000041');
    state.invalidPayload = false; state.readStatus = 403; await page.evaluate(() => window.MBBSSpecialDeliveryMethodAlerts.refresh());
    await expect(dialog).toHaveCount(0); await expect(page.locator('.special-delivery-method-alert')).toHaveCount(0);
  } finally { await close(); }
});
test('network errors keep acknowledgement retryable and stale acknowledgement cannot recreate a popup after account change', async () => {
  const { page, state, close } = await fixture();
  try {
    const dialog = page.locator('.special-delivery-method-dialog'); await expect(dialog).toBeVisible();
    state.abortAck = true; await dialog.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(dialog.getByRole('status')).toContainText('Please retry'); await expect(dialog.getByRole('button', { name: 'Acknowledge' })).toBeEnabled();
    state.abortAck = false; state.holdAck = true; await dialog.getByRole('button', { name: 'Acknowledge' }).click();
    await expect.poll(() => state.heldAck !== null).toBe(true);
    state.role = 'sales'; await page.evaluate(() => { localStorage.setItem('mbbs.staff.token', 'changed-account'); window.dispatchEvent(new CustomEvent('mbbs-auth-operator-changed')); });
    await expect(dialog).toHaveCount(0); await state.heldAck.fulfill({ json: { acknowledged: true } });
    await page.evaluate(() => window.MBBSSpecialDeliveryMethodAlerts.refresh()); await expect(dialog).toHaveCount(0);
  } finally { await close(); }
});
