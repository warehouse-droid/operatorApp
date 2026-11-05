import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { chromium, webkit, expect } from '@playwright/test';
import { app } from '../../../src/server.js';
import { closeDb, query } from '../../../src/db.js';
import { seedOperatorPickup } from '../../support/operator-ui-enhancements-fixture.mjs';

/* global localStorage, window, consolidationDrafts */

// Tapping a stepper quantity opens a number pad so the operator types the quantity directly.
let http, base;
const browsers = {};
test.after(async () => {
  await Promise.all(Object.values(browsers).map(browser => browser.close()));
  if (http) { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
  await closeDb();
});
test.before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  http = app.listen(0, '127.0.0.1');
  await new Promise(resolve => http.once('listening', resolve));
  base = `http://127.0.0.1:${http.address().port}`;
  browsers.chromium = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  browsers.webkit = await webkit.launch();
});

const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';

async function open(t, { module, engine = 'chromium', viewport = { width: 1280, height: 900 }, phone = false }) {
  const f = await seedOperatorPickup({ quantity: 25 });
  if (module === 'delivery') {
    await query("UPDATE sales_orders SET sales_order_type='Delivery',expected_delivery_date=current_date WHERE netsuite_id=$1", [f.orderId]);
  }
  const context = await browsers[engine].newContext({ viewport, hasTouch: phone, serviceWorkers: 'block', ...(phone ? { userAgent: iphone } : {}) });
  if (phone) {
    // The phone layout is feature-gated per account; this test turns the gate on.
    await context.route('**/api/operator/phone-layout-policy', route => route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ flagKey: 'operator_phone_layout', enabled: true, revision: 1 }) }));
  }
  t.after(() => context.close());
  await context.addInitScript(({ token, state }) => {
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
  return { f, page };
}

const pad = page => page.locator('dialog.stepper-keypad-dialog');
const key = (page, value) => pad(page).locator(`[data-stepper-key="${value}"]`);
async function press(page, keys, touch = false) {
  for (const value of keys) { await (touch ? key(page, value).tap() : key(page, value).click()); }
}
async function shot(page, name) {
  const directory = process.env.OPERATOR_STEPPER_KEYPAD_SCREENSHOTS;
  if (directory) { await page.screenshot({ path: `${directory}/stepper-keypad-${name}.png` }); }
}
async function confirmLine(page) {
  const response = page.waitForResponse(r => r.request().method() === 'POST'
    && /\/lines\/[^/]+\/(?:confirm|packed-quantity)$/u.test(new URL(r.url()).pathname));
  await page.locator('[data-action="confirm-line"]').click();
  const saved = await response;
  assert.equal(saved.ok(), true, await saved.text());
}

test('Customer Pickup: tapping the pack quantity opens a number pad that sets the quantity directly', async t => {
  const { page } = await open(t, { module: 'customer-pickup' });
  const input = page.locator('[data-pack="pieces"]');
  await expect(input).toHaveValue('25');
  await input.click();
  await expect(pad(page)).toBeVisible();
  await expect(pad(page).locator('h2')).toContainText('Pack');
  await expect(pad(page).locator('[data-stepper-keypad-limit]')).toHaveText('Max 25');
  await expect(pad(page).locator('[data-stepper-keypad-value]')).toHaveText('25');
  await expect(pad(page).locator('[data-stepper-keypad-value]')).toHaveClass(/fresh/u);
  await expect(key(page, '.')).toHaveCount(0);
  await shot(page, 'desktop-open');
  // The first digit replaces the current quantity; more than the maximum cannot be confirmed.
  await press(page, ['3', '0']);
  await expect(pad(page).locator('[data-stepper-keypad-value]')).toHaveText('30');
  await expect(pad(page).locator('[data-stepper-keypad-error]')).toHaveText('Cannot be more than 25');
  await expect(pad(page).locator('[data-stepper-keypad-ok]')).toBeDisabled();
  await shot(page, 'desktop-over-max');
  await press(page, ['back']);
  await expect(pad(page).locator('[data-stepper-keypad-error]')).toHaveText('');
  await pad(page).locator('[data-stepper-keypad-ok]').click();
  await expect(pad(page)).toHaveCount(0);
  await expect(input).toHaveValue('3');
  // Cancel, Escape and the backdrop leave the quantity unchanged.
  await input.click();
  await press(page, ['7']);
  await pad(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(pad(page)).toHaveCount(0);
  await expect(input).toHaveValue('3');
  await input.click();
  await page.keyboard.press('9');
  await page.keyboard.press('Escape');
  await expect(pad(page)).toHaveCount(0);
  await expect(input).toHaveValue('3');
  await input.click();
  await press(page, ['8']);
  await page.mouse.click(5, 5);
  await expect(pad(page)).toHaveCount(0);
  await expect(input).toHaveValue('3');
  // Keyboard entry (Zebra / Windows tablets with a keyboard) and Clear.
  await input.focus();
  await page.keyboard.press('Enter');
  await expect(pad(page)).toBeVisible();
  await page.keyboard.press('5');
  await press(page, ['clear']);
  await expect(pad(page).locator('[data-stepper-keypad-value]')).toHaveText('0');
  await page.keyboard.type('12');
  await page.keyboard.press('Enter');
  await expect(pad(page)).toHaveCount(0);
  await expect(input).toHaveValue('12');
  // The + / - buttons keep working from the typed quantity.
  await page.locator('[data-action="step-qty"][data-unit="pieces"][data-delta="1"]').click();
  await expect(input).toHaveValue('13');
  await confirmLine(page);
  await page.reload();
  await expect(page.locator('[data-pack="pieces"]')).toHaveValue('13');
});

test('Delivery Prep on a phone: the number pad fits the screen and the typed quantity is confirmed', async t => {
  const viewport = { width: 390, height: 844 };
  const { f, page } = await open(t, { module: 'delivery', engine: 'webkit', viewport, phone: true });
  await expect(page.locator('html')).toHaveAttribute('data-operator-phone', 'true');
  const input = page.locator('[data-pack="pieces"]');
  await input.tap();
  await expect(pad(page)).toBeVisible();
  const box = await pad(page).boundingBox();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, JSON.stringify(box));
  for (const value of ['1', '5', 'back', 'clear', 'ok']) {
    const target = value === 'ok' ? pad(page).locator('[data-stepper-keypad-ok]') : key(page, value);
    const button = await target.boundingBox();
    assert.ok(button.height >= 44 && button.width >= 44, `${value} key is large enough to tap: ${JSON.stringify(button)}`);
  }
  await shot(page, 'phone-open');
  await press(page, ['1', '8'], true);
  await pad(page).locator('[data-stepper-keypad-ok]').tap();
  await expect(pad(page)).toHaveCount(0);
  await expect(input).toHaveValue('18');
  await confirmLine(page);
  await page.reload();
  await expect(page.locator('[data-pack="pieces"]')).toHaveValue('18');
  const saved = (await query('SELECT packed_piece_qty FROM sales_order_lines WHERE id=$1', [f.lineId])).rows[0];
  assert.equal(Number(saved.packed_piece_qty), 18);
});

test('Consolidation Pick: the number pad sets an allocation and allows decimals only for sales units', async t => {
  const { page } = await open(t, { module: 'customer-pickup' });
  const allocation = { batchOrderId: 'batch-order-1', lineKey: 'line-1', orderRef: 'SOB-KEYPAD', planDate: '2026-11-04',
    truckPlate: 'TRUCK-A', loadName: 'Load 1', units: [{ key: 'pallets', label: 'PLT', required: 3 }] };
  const batch = { summary: {}, items: [{ key: 'item-1', itemName: 'Keypad Paver', description: '', totals: [], allocations: [
    allocation, { ...allocation, batchOrderId: 'batch-order-2', units: [{ key: 'pieces', label: 'M2', required: 2.5 }] }] }] };
  // The operator page's own state (top-level script bindings), as the live batch API would leave it.
  await page.evaluate(`currentModule = "delivery-consolidation"; consolidationStage = "pick";
    consolidationBatch = ${JSON.stringify(batch)}; render();`);
  const pallets = page.locator('.consolidation-allocation').nth(0).locator('.stepper input');
  const sales = page.locator('.consolidation-allocation').nth(1).locator('.stepper input');
  await expect(pallets).toHaveValue('3');
  await pallets.click();
  await expect(pad(page).locator('h2')).toHaveText('PLT');
  await expect(pad(page).locator('[data-stepper-keypad-limit]')).toHaveText('Max 3');
  await expect(key(page, '.')).toHaveCount(0);
  await press(page, ['2']);
  await pad(page).locator('[data-stepper-keypad-ok]').click();
  await expect(pallets).toHaveValue('2');
  await sales.click();
  await expect(pad(page).locator('[data-stepper-keypad-limit]')).toHaveText('Max 2.5');
  await press(page, ['3']);
  await expect(pad(page).locator('[data-stepper-keypad-ok]')).toBeDisabled();
  await press(page, ['clear', '1', '.', '5']);
  await shot(page, 'consolidation-decimal');
  await pad(page).locator('[data-stepper-keypad-ok]').click();
  await expect(sales).toHaveValue('1.5');
  await page.locator('[data-action="step-consolidation"][data-order="batch-order-1"][data-delta="1"]').click();
  await expect(pallets).toHaveValue('3');
  assert.deepEqual(await page.evaluate(() => [...consolidationDrafts.values()].map(draft => ({ ...draft }))),
    [{ pallets: 3 }, { pieces: 1.5 }]);
});
