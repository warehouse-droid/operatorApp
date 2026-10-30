/* global operator, currentModule, resetReturnWorkflow, render, returnPalletPhotos, deliveryNotificationStateReady,
 returnPalletQuantity, returnVehiclePlate, returnHeaderNote, returnStage, returnDirty,
 returnCustomerSearchActive, returnSelectedCustomer,
 returnCameraActive, returnScannerKeyActive, returnQuaggaActive, handleReturnBarcodeDetected */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test, { before, after } from 'node:test';
import { chromium } from '@playwright/test';
import { displayFixture, displayApiResponse } from '../../support/operator-display-refresh-fixture.mjs';

let browser;
before(async () => { browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }); });
after(async () => { await browser?.close(); });
const customer = { id: 99091702, code: 'C-TEST', name: 'Test Masonry', phone: '(416) 555-0123', address: '1 Test Street' };
const balance = { available: 20 };
async function serveAsset(route, url) {
  const vendors = { '/vendor/quagga2/': 'node_modules/@ericblade/quagga2/dist', '/vendor/qr-scanner/': 'node_modules/qr-scanner' };
  const prefix = Object.keys(vendors).find(value => url.pathname.startsWith(value));
  const file = prefix ? path.join(vendors[prefix], url.pathname.slice(prefix.length))
    : path.join('public', url.pathname === '/operator' ? 'operator.html' : url.pathname.slice(1));
  try { await route.fulfill({ status: 200, contentType: ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream', body: await readFile(file) }); }
  catch { await route.fulfill({ status: 404, body: '' }); }
}
async function session(t, width = 1366) {
  const fixture = displayFixture();
  const actor = { id: 'pallet-ui-test', display_name: 'Test operator', role: 'operator', roles: ['operator'], operatorYardLocationIds: [1] };
  const token = 'test-pallet-session';
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', permissions: ['camera'] });
  t.after(() => context.close());
  await context.addInitScript(({ actor: user, token: auth, sessionKey }) => {
    localStorage.setItem('mbbs.operator.token', auth);
    localStorage.setItem('mbbs.staff.token', auth);
    localStorage.setItem('mbbs.ui.language', 'en');
    localStorage.setItem('mbbs.operator.state', JSON.stringify({ accountId: user.id, sessionKey, locationId: 1, currentModule: 'menu' }));
    window.EventSource = class { addEventListener() {} close() {} };
  }, { actor, token, sessionKey: crypto.createHash('sha256').update(token).digest('hex') });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [], searches = [], submissions = [], lookups = [];
  const control = { hold: false, pending: [], failLookup: false, customers: [customer] };
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) { return serveAsset(route, url); }
    if (url.pathname === '/api/returns/customers') {
      searches.push(url.searchParams.get('search'));
      if (control.hold) { control.pending.push(route); return; }
      return route.fulfill({ json: { customers: control.customers } });
    }
    if (/\/api\/returns\/customers\/\d+\/pallet-balance/.test(url.pathname)) { return route.fulfill({ json: { customer, balance } }); }
    if (url.pathname === '/api/returns/orders/lookup') {
      lookups.push(route.request().postDataJSON());
      if (control.failLookup) { return route.fulfill({ status: 400, json: { error: 'Order not found' } }); }
      return route.fulfill({ json: { customer, palletBalance: balance, order: { id: 99091700, tranid: 'SOB99091700', customer }, lines: [] } });
    }
    if (url.pathname === '/api/operator/netsuite-posting-policy') { return route.fulfill({ json: { effective: true, transactionType: 'CM', functionKey: 'pallet_return', locationId: Number(url.searchParams.get('locationId')), revision: 1, gateKey: 'operator_netsuite_pallet_return_cm_bolton' } }); }
    if (url.pathname === '/api/operator/preferences') { return route.fulfill({ json: { styles: { general: { labels: { fontSizePx: 8 }, quantities: { fontSizePx: 9 }, descriptions: { fontSizePx: 10 } } } } }); }
    if (url.pathname === '/api/operator/phone-layout-policy') { return route.fulfill({ json: { flagKey: 'operator_phone_layout', enabled: true } }); }
    if (url.pathname === '/api/returns/submit') {
      submissions.push(route.request().postDataJSON());
      return route.fulfill({ json: { batchReference: 'TEST-RB1', palletReturn: { id: 1, reference: 'TEST-PR1', workflowVersion: 3, netSuiteStage: 'credit_memo', netSuiteSyncStatus: 'succeeded', netSuiteTransactionRef: 'CMB-TEST1' } } });
    }
    await route.fulfill({ json: displayApiResponse(url, fixture, actor) });
  });
  await page.goto('http://localhost/operator');
  await page.waitForFunction(() => Boolean(operator) && deliveryNotificationStateReady);
  if (width === 390) { await page.waitForFunction(() => document.documentElement.dataset.operatorPhone === 'true'); }
  await page.evaluate(() => {
    resetReturnWorkflow('pallet'); currentModule = 'pallet-return'; render();
    window.palletInputEvents = [];
    document.getElementById('app').addEventListener('input', event => window.palletInputEvents.push({ field: event.target.dataset.returnInput, value: event.target.value }), true);
  });
  assert.equal(await page.evaluate(() => currentModule), 'pallet-return');
  const select = async () => {
    await page.locator('#returnCustomerSearch').fill('Test');
    await page.locator('[data-action="return-select-customer"]').click();
    await page.waitForFunction(() => returnSelectedCustomer?.id === 99091702);
  };
  return { page, searches, submissions, lookups, select, control };
}

async function assertReadable(page) {
  const small = await page.locator('#app').evaluate(node => [...node.querySelectorAll('span,strong,b,small,em,label,input,textarea,button,p,output')]
    .filter(el => el.getClientRects().length && (el.matches('input,textarea') || [...el.childNodes].some(child => child.nodeType === 3 && child.textContent.trim())))
    .filter(el => parseFloat(getComputedStyle(el).fontSize) < 15).map(el => ({ text: el.textContent, size: getComputedStyle(el).fontSize })));
  assert.deepEqual(small, []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
}

for (const width of [390, 1024, 1366]) {
  test(`customer matches stay compact and a long list stays usable at ${width}px`, async t => {
    const { page, control } = await session(t, width);
    for (const count of [1, 3, 25]) {
      control.customers = Array.from({ length: count }, (_, index) => ({ ...customer, id: customer.id + index }));
      await page.locator('#returnCustomerSearch').fill(`Test ${count}`);
      const cards = page.locator('[data-action="return-select-customer"]');
      await page.waitForFunction(expected => document.querySelectorAll('[data-action="return-select-customer"]').length === expected, count);
      const heights = await cards.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
      assert.ok(heights.every(height => height >= 44 && height <= 140), JSON.stringify({ width, count, heights }));
      if (count < 4) {
        const offset = await cards.first().evaluate(node => node.getBoundingClientRect().top - node.parentElement.getBoundingClientRect().top);
        assert.ok(offset < 2, `matches start at the top: ${offset}`);
      }
      await cards.last().scrollIntoViewIfNeeded();
      assert.equal(await cards.last().isVisible(), true);
      await assertReadable(page);
    }
    await page.locator('[data-action="return-select-customer"]').last().click();
    await page.locator('.pallet-return-input').waitFor();
  });
}

for (const width of [390, 1024, 1366]) {
  test(`three-step pallet flow keeps equal lookup columns and readable fields at ${width}px`, async t => {
    const { page, select } = await session(t, width);
    const columns = page.locator('.pallet-return-search > [data-pallet-search-panel]');
    assert.equal(await columns.count(), 3);
    assert.deepEqual(await columns.evaluateAll(nodes => nodes.map(node => node.dataset.palletSearchPanel)), ['barcode', 'order', 'customer']);
    assert.equal(await page.locator('[data-action="return-start-camera"], [data-return-input]').count(), 0);
    if (width > 600) {
      const boxes = await columns.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width }; }));
      assert.ok(Math.max(...boxes.map(r => r.width)) - Math.min(...boxes.map(r => r.width)) < 2);
      assert.ok(boxes[0].x < boxes[1].x && boxes[1].x < boxes[2].x);
      assert.equal(boxes[0].y, boxes[2].y);
    }
    await assertReadable(page);
    await select();
    await page.locator('.pallet-return-input').waitFor();
    assert.equal(await columns.count(), 0, 'selection opens the separate input page');
    assert.equal(await page.locator('#returnCustomerSearch, #returnOrderLookup, [data-action="return-start-camera"]').count(), 0);
    for (const selector of ['[data-return-input="vehiclePlate"]', '[data-return-input="headerNote"]', 'input[data-return-input="palletQuantity"]']) { assert.equal(await page.locator(selector).count(), 1); }
    const quantity = page.locator('input[data-return-input="palletQuantity"]');
    await quantity.fill('3');
    await page.locator('[data-action="return-step-quantity"][data-delta="1"]').click();
    assert.equal(await quantity.inputValue(), '4');
    await page.locator('[data-action="return-step-quantity"][data-delta="-1"]').click();
    assert.equal(await quantity.inputValue(), '3');
    await assertReadable(page);
    await page.locator('[data-action="return-open-review"]').click();
    await page.locator('[data-action="return-confirm-submit"]:enabled').waitFor();
    assert.equal(await page.locator('#app [data-return-input]').count(), 0);
    assert.equal(await page.locator('[data-action="return-start-camera"]').count(), 1);
    assert.equal(await page.evaluate(() => returnCameraActive), false);
    await assertReadable(page);
    await page.locator('[data-action="return-back-to-form"]').click();
    assert.equal(await quantity.inputValue(), '3');
  });
}

for (const method of ['typed order', 'Zebra scanner', 'camera barcode']) {
  test(`${method} opens the pallet input page without storing barcode images as proof`, async t => {
    const { page, lookups } = await session(t);
    if (method === 'typed order') {
      await page.locator('#returnOrderLookup').fill('SOB99091700');
      await page.locator('[data-action="return-lookup-order"]').click();
    } else if (method === 'Zebra scanner') {
      await page.locator('#returnOrderLookup').fill('SOB99091700');
      await page.locator('#returnOrderLookup').press('Enter');
    } else {
      await page.locator('[data-pallet-search-panel="barcode"] [data-action="return-start-scanner"]').click();
      await page.waitForFunction(() => returnQuaggaActive);
      await page.evaluate(() => handleReturnBarcodeDetected({ codeResult: { code: 'SOB99091700' } }));
    }
    await page.locator('.pallet-return-input').waitFor();
    assert.equal(lookups.length, 1);
    assert.equal(lookups[0].code, 'SOB99091700');
    assert.equal(lookups[0].mode, 'pallet');
    assert.match(await page.locator('.return-customer-summary').innerText(), /SOB99091700/);
    assert.equal(await page.evaluate(() => returnScannerKeyActive()), false);
    assert.deepEqual(await page.evaluate(() => returnPalletPhotos), []);
    assert.equal(await page.locator('#returnScannerCamera, [data-action="return-start-camera"]').count(), 0);
  });
}

test('search preserves the input node, caret, typed query and focus across slow responses', async t => {
  const { page, control, searches } = await session(t);
  control.hold = true;
  const input = page.locator('#returnCustomerSearch');
  await input.fill('Test');
  await page.evaluate(() => { window.originalInput = document.getElementById('returnCustomerSearch'); });
  await page.waitForFunction(() => returnCustomerSearchActive);
  await input.press('Home'); await input.press('ArrowRight'); await input.pressSequentially('X');
  assert.equal(await page.evaluate(() => document.activeElement === window.originalInput), true);
  assert.equal(await input.inputValue(), 'TXest');
  assert.equal(await input.evaluate(el => el.selectionStart), 2);
  await control.pending.shift().fulfill({ json: { customers: [{ ...customer, name: 'STALE' }] } });
  await page.waitForTimeout(350);
  assert.ok(searches.includes('TXest'));
  assert.equal(await page.getByText('STALE', { exact: true }).count(), 0);
  await control.pending.shift().fulfill({ json: { customers: [customer] } });
  await page.waitForFunction(() => !returnCustomerSearchActive);
  assert.equal(await page.evaluate(() => document.activeElement === window.originalInput), true);
  assert.equal(await input.evaluate(el => el.selectionStart), 2);
  await input.fill('Another'); await page.waitForFunction(() => returnCustomerSearchActive);
  await page.locator('#returnOrderLookup').focus();
  await control.pending.shift().fulfill({ json: { customers: [customer] } });
  await page.waitForFunction(() => !returnCustomerSearchActive);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'returnOrderLookup');
});

test('clearing a pending search hides stale results and late errors do not follow navigation', async t => {
  const { page, control } = await session(t);
  control.hold = true;
  await page.locator('#returnCustomerSearch').fill('Test'); await page.waitForFunction(() => returnCustomerSearchActive);
  await page.locator('#returnCustomerSearch').fill('');
  await control.pending.shift().fulfill({ json: { customers: [customer] } });
  await page.waitForFunction(() => !returnCustomerSearchActive);
  assert.equal(await page.locator('[data-action="return-select-customer"]').count(), 0);
  await page.locator('#returnCustomerSearch').fill('Test'); await page.waitForFunction(() => returnCustomerSearchActive);
  await page.evaluate(() => { currentModule = 'menu'; render(); });
  await control.pending.shift().fulfill({ status: 500, json: { error: 'Late search failed' } });
  await page.waitForFunction(() => !returnCustomerSearchActive);
  assert.equal(await page.getByText('Late search failed').count(), 0);
});

test('final review confirms without photos or plate and retains the input note', async t => {
  const { page, select, submissions } = await session(t);
  await select();
  await page.locator('[data-action="return-step-quantity"][data-delta="1"]').click();
  assert.equal(await page.evaluate(() => returnPalletQuantity), 1, 'quantity increases');
  await page.locator('[data-return-input="headerNote"]').fill('Optional evidence omitted');
  assert.equal(await page.evaluate(() => returnHeaderNote), 'Optional evidence omitted', JSON.stringify(await page.evaluate(() => window.palletInputEvents)));
  await page.locator('[data-action="return-open-review"]').click();
  await page.locator('[data-action="return-confirm-submit"]:enabled').waitFor().catch(async error => {
    throw new Error(error.message + JSON.stringify(await page.evaluate(() => ({ stage: returnStage, quantity: returnPalletQuantity, text: document.getElementById('app').innerText }))));
  });
  assert.equal(await page.locator('#app input, #app textarea, #app select').count(), 0);
  assert.equal(await page.locator('[data-action="return-start-camera"]').count(), 1);
  assert.match(await page.locator('#app').innerText(), /Optional evidence omitted/);
  assert.equal(await page.evaluate(() => returnCameraActive), false);
  await page.locator('[data-action="return-back-to-form"]').click();
  assert.equal(await page.locator('[data-return-input="headerNote"]').inputValue(), 'Optional evidence omitted');
  await page.locator('[data-action="return-open-review"]').click();
  await page.locator('[data-action="return-confirm-submit"]:enabled').click();
  await page.locator('[data-action="return-new"]').waitFor();
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].vehiclePlate, '');
  assert.deepEqual(submissions[0].palletPhotos, []);
  assert.equal(submissions[0].palletQuantity, 1);
});

test('optional proof is captured on confirmation and survives back navigation', async t => {
  const { page, select } = await session(t);
  await select();
  await page.locator('input[data-return-input="palletQuantity"]').fill('2');
  await page.locator('[data-return-input="vehiclePlate"]').fill('test123');
  await page.locator('[data-return-input="headerNote"]').fill('Keep entry');
  await page.locator('[data-action="return-open-review"]').click();
  await page.locator('[data-action="return-confirm-submit"]:enabled').waitFor();
  assert.match(await page.locator('.return-review-meta').innerText(), /TEST123/);
  assert.match(await page.locator('.return-review-meta').innerText(), /Keep entry/);
  await page.locator('[data-action="return-start-camera"]').click();
  await page.locator('#returnCamera').waitFor();
  await page.waitForFunction(() => document.getElementById('returnCamera')?.videoWidth > 0);
  await page.locator('[data-action="return-capture-photo"]').click();
  await page.waitForFunction(() => returnPalletPhotos.filter(Boolean).length === 1);
  const photo = await page.evaluate(() => returnPalletPhotos[0]);
  assert.equal(await page.locator('.return-review-photos img').count(), 1);
  await page.locator('[data-action="return-back-to-form"]').click();
  assert.equal(await page.locator('input[data-return-input="palletQuantity"]').inputValue(), '2');
  assert.equal(await page.locator('[data-return-input="vehiclePlate"]').inputValue(), 'TEST123');
  assert.equal(await page.locator('[data-return-input="headerNote"]').inputValue(), 'Keep entry');
  assert.equal(await page.evaluate(() => returnCameraActive), false);
  await page.locator('[data-action="return-back-to-lookup"]').click();
  assert.equal(await page.locator('[data-action="return-start-camera"], [data-return-input]').count(), 0);
  await select();
  assert.equal(await page.locator('input[data-return-input="palletQuantity"]').inputValue(), '2');
  assert.ok(await page.evaluate(savedPhoto => returnPalletPhotos[0] === savedPhoto, photo));
  assert.deepEqual(await page.evaluate(() => ({ plate: returnVehiclePlate, note: returnHeaderNote, dirty: returnDirty })), { plate: 'TEST123', note: 'Keep entry', dirty: true });
  await page.locator('[data-action="return-open-review"]').click();
  await page.locator('[data-action="return-confirm-submit"]:enabled').waitFor();
  assert.equal(await page.locator('.return-review-photos img').count(), 1);
  await page.evaluate(() => resetReturnWorkflow('pallet'));
  assert.deepEqual(await page.evaluate(() => returnPalletPhotos), []);
});

test('lookup and quota warnings float like pickup notices, dismiss without losing entry', async t => {
  const { page, select, control } = await session(t);
  await page.locator('#returnOrderLookup').fill('invalid');
  await page.locator('[data-action="return-lookup-order"]').click();
  const warning = page.locator('#returnWorkflowMessage');
  await warning.waitFor();
  assert.equal(await warning.evaluate(el => getComputedStyle(el).position), 'fixed');
  await warning.getByRole('button', { name: 'Dismiss' }).click();
  assert.equal(await warning.count(), 0);
  await select();
  await page.locator('[data-action="return-open-review"]').click();
  await warning.waitFor(); assert.match(await warning.innerText(), /at least one PALLET/);
  await warning.getByRole('button', { name: 'Dismiss' }).click();
  await page.evaluate(() => { returnPalletQuantity = 21; render(); });
  await page.locator('[data-action="return-open-review"]').click();
  await warning.waitFor(); assert.match(await warning.innerText(), /20/);
  await warning.getByRole('button', { name: 'Dismiss' }).click();
  await page.locator('[data-action="return-back-to-lookup"]').click();
  control.failLookup = true;
  await page.locator('#returnOrderLookup').fill('SOB123456');
  await page.locator('[data-action="return-lookup-order"]').click();
  await warning.waitFor(); assert.match(await warning.innerText(), /Order not found/);
  assert.equal(await page.evaluate(() => returnPalletQuantity), 21);
});
