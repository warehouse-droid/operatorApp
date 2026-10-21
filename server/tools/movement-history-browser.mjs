import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const out = 'test-artifacts/movement-document-history';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] });
const records = [
  { id: 'load-1', type: 'sales_order_delivery_load', orderId: 1, tranid: 'SOB-WAITING', reference: 'EA', status: 'Loaded', waitingForDriverCompletion: true, documents: [] },
  { id: 'load-2', type: 'customer_pickup_load', orderId: 2, tranid: 'SOB-PICKUP', reference: 'EA', status: 'loaded', waitingForDriverCompletion: false, documents: [{ type: 'IF', ref: 'IF155552' }] },
  { id: 'receipt-3', type: 'item_receipt', orderId: 3, tranid: 'POB-RECEIPT', reference: 'IR14831', status: 'received', waitingForDriverCompletion: false, documents: [{ type: 'IR', ref: 'IR14831' }] }
].map(record => ({ ...record, createdAt: '2026-09-27T10:00:00Z', details: { lines: [] }, photos: [] }));
const results = [], errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const login = await context.request.post('http://127.0.0.1:3000/api/auth/login', {
    data: { username: 'review-operator', password: 'SpecialReview-2026!' } // secret-scan: allow -- disposable review account
  });
  assert.equal(login.status(), 200);
  const { token } = await login.json();
  await context.addInitScript(token => {
    localStorage.setItem('mbbs.staff.token', token);
    localStorage.setItem('mbbs.operator.token', token);
  }, token);
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/operator/history?**', route => route.fulfill({ json: records }));
  await page.goto('http://127.0.0.1:3000/operator');
  await page.locator('[data-action=save-location], [data-module=personal-history]').first().waitFor().catch(async error => {
    console.log(JSON.stringify({ screen: await page.locator('body').innerText(), errors }));
    throw error;
  });
  if (await page.locator('[data-action=save-location]').count()) await page.locator('[data-action=save-location]').click();
  await page.locator('[data-module=personal-history]').click();
  await page.locator('.history-record').first().waitFor();
  for (const record of records) {
    const card = page.locator(`[data-action=select-history][data-record="${record.id}"]`);
    await card.click();
    const expected = record.documents[0]?.ref || 'waiting for driver completion';
    assert.match(await card.innerText(), new RegExp(expected));
    assert.match(await page.locator('.history-detail-card').innerText(), new RegExp(expected));
    if (!record.waitingForDriverCompletion) assert.doesNotMatch(await page.locator('.history-detail-card').innerText(), /waiting for driver completion/);
  }
  await page.screenshot({ path: `${out}/operator-history-desktop.png` });
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.locator('[data-action=select-history][data-record="load-1"]').click();
  await page.screenshot({ path: `${out}/operator-history-tablet.png` });
  results.push({ view: 'operator-history', records: 3, cardsAndDetails: true });
  await context.close();

  const sales = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const yard = await sales.newPage(); yard.setDefaultTimeout(8000);
  yard.on('pageerror', error => errors.push(error.message));
  const movements = records.map((record, index) => ({
    order_id: record.orderId, tranid: record.tranid, direction: index === 2 ? 'inbound' : 'outbound',
    order_type: index === 2 ? 'purchase_order' : 'sales_order', yard_location: '3445', yard_location_id: 1,
    movement_status: record.status, documents: record.documents, waitingForDriverCompletion: record.waitingForDriverCompletion,
    process_count: 1, yard_activity_count: 1, last_activity_at: record.createdAt
  }));
  await yard.route('**/api/sales/in-outbound-records**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/drivers')) return route.fulfill({ json: [] });
    if (url.pathname.endsWith('/detail')) return route.fulfill({ json: { order: movements.find(row => String(row.order_id) === url.searchParams.get('orderId')), lines: [], photos: [] } });
    return route.fulfill({ json: movements.filter(row => row.direction === url.searchParams.get('direction')) });
  });
  await yard.goto('http://127.0.0.1:3000/sales/in-outbound-record');
  await yard.locator('[name=username]').fill('review-sales');
  await yard.locator('[name=password]').fill('SpecialReview-2026!'); // secret-scan: allow -- disposable review account
  await yard.locator('[data-form=dispatch-login] button[type=submit]').click();
  await yard.locator('.dispatch-loaded-order').first().waitFor();
  for (const record of movements) {
    await yard.locator(`[data-action=yard-direction][data-direction=${record.direction}]`).click();
    const card = yard.locator('.dispatch-loaded-order').filter({ hasText: record.tranid });
    await card.click();
    const expected = record.documents[0]?.ref || 'waiting for driver completion';
    assert.match(await card.innerText(), new RegExp(expected));
    await yard.waitForFunction(expected => document.querySelector('.dispatch-loaded-detail-head')?.innerText.includes(expected), expected);
  }
  await yard.screenshot({ path: `${out}/in-outbound-desktop.png` });
  results.push({ view: 'in-outbound', records: 3, cardsAndDetails: true });
  const controlContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await controlContext.addInitScript(() => localStorage.setItem('mbbs.staff.token', 'isolated-browser-fixture'));
  const control = await controlContext.newPage(); control.setDefaultTimeout(8000);
  control.on('pageerror', error => errors.push(error.message));
  await control.route('**/api/**', route => {
    assert.equal(route.request().method(), 'GET');
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/bootstrap-needed') return route.fulfill({ json: { needed: false } });
    if (url.pathname === '/api/auth/me') return route.fulfill({ json: { operator: { id: 'test', display_name: 'TEST Control', role: 'yard_manager', roles: ['yard_manager'], yardLocationIds: [1] } } });
    if (url.pathname === '/api/control/loaded-orders/detail') return route.fulfill({ json: { order: movements.find(row => String(row.order_id) === url.searchParams.get('orderId')), lines: [], photos: [] } });
    if (url.pathname === '/api/control/loaded-orders') return route.fulfill({ json: movements.filter(row => row.direction === url.searchParams.get('direction')) });
    return route.fulfill({ json: [] });
  });
  await control.goto('http://127.0.0.1:3000/control/yard-in-outbound');
  await control.locator('.loaded-order-card').first().waitFor();
  for (const record of movements) {
    await control.locator(`[data-action=yard-direction][data-direction=${record.direction}]`).click();
    const card = control.locator('.loaded-order-card').filter({ hasText: record.tranid });
    await card.click();
    const expected = record.documents[0]?.ref || 'waiting for driver completion';
    assert.match(await card.innerText(), new RegExp(expected));
    await control.waitForFunction(expected => document.querySelector('.loaded-detail-head')?.innerText.includes(expected), expected);
  }
  await control.screenshot({ path: `${out}/control-in-outbound-desktop.png` });
  results.push({ view: 'control-in-outbound', records: 3, cardsAndDetails: true });
  await controlContext.close();
  assert.deepEqual(errors, []);
  const sourceHashes = {};
  for (const file of ['public/operator.js', 'public/dispatch-loaded-export.js', 'public/control.js']) {
    sourceHashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  await writeFile(`${out}/browser.json`, JSON.stringify({ results, errors, sourceHashes }, null, 2));
  console.log(JSON.stringify(results));
  await sales.close();
} finally { await browser.close(); }
