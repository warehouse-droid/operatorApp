import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { app } from '../../../src/server.js';
import { closeDb, query } from '../../../src/db.js';
import { seedOperatorPickup } from '../../support/operator-ui-enhancements-fixture.mjs';

/* global document, localStorage, window */

let browser, http, base;
test.after(async () => {
  await browser?.close();
  if (http) { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
  await closeDb();
});
test.before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  http = app.listen(0, '127.0.0.1');
  await new Promise(resolve => http.once('listening', resolve));
  base = `http://127.0.0.1:${http.address().port}`;
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});

async function open(t, module, unit) {
  const f = await seedOperatorPickup({ quantity: 25 });
  const fields = { pieces: ['piece_qty', 'to_pcs', 1, 5], layers: ['layer_qty', 'to_lyr', 5, 1],
    sections: ['section_qty', 'to_sec', 5, 1] };
  const [field, factor, conversion, required] = fields[unit];
  await query(`UPDATE sales_order_lines SET pallet_qty=1, piece_qty=0, to_pcs=0, to_plt=20,
    ${unit === 'pieces' ? '' : `${field}=${required}, ${factor}=${conversion},`}
    pack_quantity_source='netsuite_manual' WHERE id=$1`, [f.lineId]);
  if (unit === 'pieces') { await query('UPDATE sales_order_lines SET piece_qty=5,to_pcs=1 WHERE id=$1', [f.lineId]); }
  if (module === 'delivery') { await query("UPDATE sales_orders SET sales_order_type='Delivery',expected_delivery_date=current_date WHERE netsuite_id=$1", [f.orderId]); }
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  t.after(() => context.close());
  await context.addInitScript(({ token, state }) => {
    // Exercise the real app and database without unrelated global alert refreshes.
    window.EventSource = class { addEventListener() {} close() {} };
    localStorage.setItem('mbbs.staff.token', token);
    localStorage.setItem('mbbs.operator.token', token);
    localStorage.setItem('mbbs.operator.locationId', '1');
    localStorage.setItem('mbbs.ui.language', 'en');
    localStorage.setItem('mbbs.operator.state', JSON.stringify(state));
  }, { token: f.token, state: { accountId: f.operator.id,
    sessionKey: crypto.createHash('sha256').update(f.token).digest('hex'), locationId: 1,
    currentModule: module, selectedId: f.orderId, selectedLineId: f.lineId, viewMode: 'active' } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(base + '/operator');
  await expect(page.locator(`[data-selected-line="${f.lineId}"]`)).toBeVisible();
  return { f, page, conversion };
}

async function set(page, unit, quantity) {
  const input = page.locator(`[data-pack="${unit}"]`), current = Number(await input.inputValue());
  for (let count = 0; count < Math.abs(quantity - current); count++) {
    await page.locator(`[data-action="step-qty"][data-unit="${unit}"][data-delta="${quantity > current ? 1 : -1}"]`).click();
  }
  await expect(input).toHaveValue(String(quantity));
}
async function balance(page, loaded, confirmed, remaining) {
  await expect(page.locator('.selected-measures.converted-pack-balance')).toBeHidden();
  await expect(page.locator('[data-selected-line] > .selected-measures:not(.converted-pack-balance)')).toBeVisible();
  for (const [key, value] of Object.entries({ total: 25, loaded, confirmed, remaining })) {
    await expect(page.locator(`[data-pack-balance="${key}"] b`)).toHaveText(String(value));
  }
}
async function confirm(page, action = 'confirm-line') {
  const response = page.waitForResponse(r => r.request().method() === 'POST'
    && /\/lines\/(?:[^/]+\/(?:confirm|packed-quantity)|confirm-page)$/u.test(new URL(r.url()).pathname));
  await page.locator(`[data-action="${action}"]`).click();
  const saved = await response;
  assert.equal(saved.ok(), true, await saved.text());
}
async function load(page, f, module) {
  const result = await page.request.post(`${base}/api/${module === 'delivery' ? 'delivery' : 'customer-pickup'}/orders/${f.orderId}/load`, {
    headers: { authorization: `Bearer ${f.token}` }, data: { locationId: 1,
      photoDataUrls: ['data:image/png;base64,dGVzdDE=', 'data:image/png;base64,dGVzdDI='] }
  });
  assert.equal(result.ok(), true, await result.text());
  return result.json();
}

for (const unit of ['pieces', 'layers', 'sections']) {
  test(`real browser pickup in ${unit}: confirm 10, load 10, show 15 remaining, load 15`, async t => {
    const { f, page, conversion } = await open(t, 'customer-pickup', unit);
    await balance(page, 0, 0, 25);
    await expect(page.locator('[data-pack="pallets"]')).toHaveValue('1');
    await set(page, 'pallets', 0);
    await set(page, unit, 10 / conversion);
    await page.locator('[data-action="step-qty"][data-unit="pallets"][data-delta="1"]').click();
    await expect(page.locator('[data-pack="pallets"]')).toHaveValue('0');
    await set(page, unit, 25 / conversion);
    await page.locator(`[data-action="step-qty"][data-unit="${unit}"][data-delta="1"]`).click();
    await expect(page.locator(`[data-pack="${unit}"]`)).toHaveValue(String(25 / conversion));
    await set(page, unit, 10 / conversion);
    await confirm(page);
    await balance(page, 0, 10, 15);
    if (unit === 'pieces') {
      await page.setViewportSize({ width: 390, height: 844 });
      await balance(page, 0, 10, 15);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await confirm(page, 'confirm-page');
    await balance(page, 0, 10, 15);
    await page.reload();
    await balance(page, 0, 10, 15);
    await expect(page.locator(`[data-pack="${unit}"]`)).toHaveValue(String(10 / conversion));
    await page.locator('[data-action="start-fulfill"]').click();
    await expect(page.locator('.fulfillment-lines')).toContainText(`${10 / conversion} ${unit === 'pieces' ? 'pcs' : unit === 'layers' ? 'lyr' : 'sec'}`);
    await page.locator('[data-action="cancel-fulfill"]').click();
    const first = await load(page, f, 'customer-pickup');
    assert.equal(first.pickupStatus, 'partial_loaded');
    assert.equal(first.loaded.salesQuantity, 10);
    await page.reload();
    await balance(page, 10, 0, 15);
    await expect(page.locator('[data-pack="pallets"]')).toHaveValue('0');
    await expect(page.locator(`[data-pack="${unit}"]`)).toHaveValue(String(15 / conversion));
    await confirm(page);
    await balance(page, 10, 15, 0);
    const second = await load(page, f, 'customer-pickup');
    assert.equal(second.pickupStatus, 'loaded');
    assert.equal(second.loaded.salesQuantity, 15);
    assert.equal(second.remainingLines, 0);
    await page.reload();
    await expect(page.locator('.detail-panel')).toContainText('Loaded 25 PC of 25 PC; no remaining pickup quantity.');
    await expect(page.locator('[data-pack]')).toHaveCount(0);
    const saved = (await query('SELECT loaded_qty,quantity,pallet_qty FROM sales_order_lines WHERE id=$1', [f.lineId])).rows[0];
    assert.deepEqual([saved.loaded_qty, saved.quantity, saved.pallet_qty].map(Number), [25, 25, 1]);
    t.diagnostic(`${unit}: total 25 → confirmed 10 / remaining 15 → loaded 10 / remaining 15 → loaded 25 / remaining 0`);
  });

  test(`Delivery Prep browser edits ${unit} against the shared total`, async t => {
    const { page, conversion } = await open(t, 'delivery', unit);
    await set(page, 'pallets', 0);
    await set(page, unit, 10 / conversion);
    await confirm(page);
    await balance(page, 0, 10, 15);
    await page.reload();
    await expect(page.locator(`[data-pack="${unit}"]`)).toHaveValue(String(10 / conversion));
    await set(page, unit, 15 / conversion);
    await confirm(page);
    await balance(page, 0, 15, 10);
    await set(page, unit, 0);
    await set(page, 'pallets', 1);
    await set(page, unit, 5 / conversion);
    await page.locator(`[data-action="step-qty"][data-unit="${unit}"][data-delta="1"]`).click();
    await expect(page.locator(`[data-pack="${unit}"]`)).toHaveValue(String(5 / conversion));
    await confirm(page);
    await balance(page, 0, 25, 0);
  });
}
