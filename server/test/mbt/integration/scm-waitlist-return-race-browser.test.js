/* global localStorage, window, EventTarget */
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

let browser;
before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
after(async () => { await browser?.close(); });

test('returned-pool acknowledgement preserves drafts, reports failure and cannot clear a newer return', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage();
  const errors = [], reads = [];
  const pool = { id: 1, revision: 1, purchaseOrderRef: 'TEST-RETURN-PO', itemCode: 'TEST', itemName: 'Synthetic material',
    capacityQty: 100, heldQty: 0, convertedQty: 0, availableQty: 100, salesUom: 'EA', allocations: [],
    lastReturnEventId: 0, returnedUnread: false, requests: [{ id: 2, revision: 1, requestRef: 'TEST-WAITING', customerName: 'Synthetic customer',
      sellingYard: '3445', waitingQty: 20, createdAt: '2099-01-01T12:00:00Z' }] };
  let failure = true, release, held = false;
  const gate = new Promise(resolve => { release = resolve; });
  async function acknowledgeRead(route) {
    const { eventId } = route.request().postDataJSON(); reads.push(eventId);
    if (failure) { return route.fulfill({ status: 503, json: { error: 'Synthetic acknowledgement outage' } }); }
    if (eventId === 10) { held = true; await gate; }
    if (pool.lastReturnEventId === eventId) { pool.returnedUnread = false; }
    return route.fulfill({ json: { ok: true } });
  }
  page.on('pageerror', error => errors.push(error.message));
  await context.addInitScript(() => { localStorage.setItem('mbbs.staff.token', 'synthetic-token'); window.EventSource = class extends EventTarget { close() {} }; });
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/')) {
      if (path === '/api/auth/me') {return route.fulfill({ json: { operator: { id: 'scm-test', role: 'scm', roles: ['scm'], yardLocationIds: [] } } });}
      if (path === '/api/scm/waitlist/pools') {return route.fulfill({ json: { pools: [pool] } });}
      if (path === '/api/scm/waitlist/pools/1') {return route.fulfill({ json: pool });}
      if (path === '/api/scm/waitlist/pools/1/read') {
        return acknowledgeRead(route);
      }
      if (route.request().method() !== 'GET') {throw new Error('Unexpected write: ' + path);}
      return route.fulfill({ json: { requests: [], yards: [], vendors: [], returnedPools: [], total: 0, revision: 1, enabled: true, orders: {} } });
    }
    const file = path === '/scm/stock-requests' ? '/scm-stock-requests.html' : path;
    return route.fulfill({ body: await readFile('public' + file), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.coverage.startJSCoverage({resetOnNavigation:false});
  try {
    await page.goto('http://localhost/scm/stock-requests?tab=waitlist&poolId=1');
    await expect(page.locator('[data-waitlist-select="2"]')).toBeVisible();
    pool.lastReturnEventId = 10; pool.returnedUnread = true;
    await page.locator('[data-waitlist-refresh]').click();
    await expect(page.locator('.waitlist-returned')).toBeVisible();
    await page.locator('[data-waitlist-select="2"]').check();
    await page.locator('[data-waitlist-quantity="2"]').fill('7');
    await page.locator('[data-waitlist-override]').fill('Retain allocation draft');
    const acknowledge = () => page.locator('.waitlist-returned [data-waitlist-pool="1"]').click();
    await acknowledge();
    await expect(page.getByRole('alert')).toHaveText('Synthetic acknowledgement outage');
    await expect(page.locator('.waitlist-returned')).toBeVisible();
    await expect(page.locator('[data-waitlist-quantity="2"]')).toHaveValue('7');
    failure = false;
    await acknowledge(); await expect.poll(() => held).toBe(true);
    pool.lastReturnEventId = 11;
    await page.locator('[data-waitlist-refresh]').click();
    const response = page.waitForResponse(r => r.url().endsWith('/pools/1/read'));
    release(); await response;
    await expect(page.locator('.waitlist-returned')).toBeVisible();
    await expect(page.locator('[data-waitlist-quantity="2"]')).toHaveValue('7');
    await expect(page.locator('[data-waitlist-override]')).toHaveValue('Retain allocation draft');
    await acknowledge();
    await expect(page.locator('.waitlist-returned')).toHaveCount(0);
    await expect(page.locator('[data-waitlist-quantity="2"]')).toHaveValue('7');
    assert.deepEqual(reads, [10, 10, 11]); assert.deepEqual(errors, []);
  } finally {
    release();
    await mkdir('test-artifacts/repair-race',{recursive:true});
    await writeFile('test-artifacts/repair-race/waitlist-coverage.json',JSON.stringify(await page.coverage.stopJSCoverage()));
    await context.close();
  }
});
