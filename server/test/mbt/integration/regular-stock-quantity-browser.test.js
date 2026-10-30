/* global localStorage, window, document */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {chromium, expect} from '@playwright/test';
import {normalizeStockRequestQuantity} from '../../../src/stock-request-domain.js';

let browser;
test.before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  browser = await chromium.launch({args: ['--no-sandbox', '--disable-dev-shm-usage']});
});
test.after(async () => {await browser?.close();});
const items = [
  {itemId: 901, itemCode: 'PAVER', description: 'Paving stone', salesUom: 'SQFT', toPlt: 120, toLyr: 12, toSec: 4, toPcs: 1},
  {itemId: 902, itemCode: 'BULK', description: 'Bulk material', salesUom: 'TON'},
  {itemId: 903, itemCode: 'DECIMAL', description: 'Decimal paving stone', salesUom: 'SQFT', toPlt: 120.96, toLyr: 15.12}
];
const yards = [{locationId: 1, yardCode: '3445'}, {locationId: 28, yardCode: '150'}];
const availability = item => ({item, yards: yards.map(yard => ({...yard, onHand: 50000, requestableAvailable: 50000}))});

async function fixture(t, width = 1440) {
  const context = await browser.newContext({viewport: {width, height: 1000}, serviceWorkers: 'block'});
  t.after(() => context.close());
  await context.addInitScript(() => {
    localStorage.setItem('mbbs.staff.token', 'quantity-test');
    localStorage.setItem('mbbs.appSidebar.collapsed', 'true');
    window.EventSource = class {addEventListener() {} removeEventListener() {} close() {}};
  });
  const page = await context.newPage(), state = {saved: null, bodies: [], errors: []};
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => state.errors.push(error.message));
  t.after(() => assert.deepEqual(state.errors, []));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), pathname = url.pathname;
    if (url.hostname !== 'localhost') {return route.abort();}
    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/auth/me') {return route.fulfill({json: {operator: {id: 'quantity-test', display_name: 'Quantity Test', role: 'sales', roles: ['sales'], yardLocationIds: [1, 28]}}});}
      if (pathname === '/api/navigation/menu-order') {return route.fulfill({json: {revision: 1, orders: {}}});}
      if (pathname.endsWith('/policy')) {return route.fulfill({json: {enabled: true, allowOverAvailability: false, revision: 1}});}
      if (pathname === '/api/sales/stock-request-items') {return route.fulfill({json: {items: items.filter(item => item.itemCode.includes(url.searchParams.get('search').toUpperCase()))}});}
      if (pathname.endsWith('/availability/refresh')) {
        return route.fulfill({json: availability(items.find(item => pathname.includes('/' + item.itemId + '/')))});
      }
      if (pathname === '/api/sales/stock-requests' && route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        state.bodies.push(body);
        state.saved = {id: 10, revision: 1, workflowVersion: 2, requestRef: 'REQ-QUANTITY', status: 'submitted', bucket: 'pending',
          destinationLocationId: 1, destinationName: '3445', regular: {deliveryMethod: 'pickup'}, transfers: [], events: [], remarks: '',
          lines: body.lines.map((line, index) => {
            const item = items.find(row => row.itemId === line.itemId), quantity = normalizeStockRequestQuantity(line, item);
            return {...item, ...line, ...quantity, id: index + 1, itemName: item.itemCode, quantityMode: quantity.mode, status: 'submitted', sourceName: '150'};
          }), availability: body.lines.map(line => availability(items.find(item => item.itemId === line.itemId)))};
        return route.fulfill({json: state.saved});
      }
      if (pathname === '/api/sales/stock-requests') {
        return route.fulfill({json: {requests: state.saved ? [state.saved] : [], yards, filterOptions: {vendors: [], sourceYards: [], destinationYards: []}}});
      }
      if (pathname === '/api/sales/stock-requests/10') {return route.fulfill({json: state.saved});}
      return route.fulfill({json: {requests: [], yards: [], total: 0, count: 0, unread: 0, orders: []}});
    }
    const file = pathname === '/sales/stock-requests' ? '/sales-stock-requests.html' : pathname;
    try {
      return route.fulfill({body: await readFile('public' + file), contentType: {js: 'application/javascript', css: 'text/css', html: 'text/html', svg: 'image/svg+xml'}[file.split('.').at(-1)] || 'application/octet-stream'});
    } catch {return route.fulfill({status: 404, body: ''});}
  });
  await page.goto('http://localhost/sales/stock-requests?tab=regular');
  await page.locator('[data-sales-stock-action="new"]').click();
  await page.locator('[data-regular-field="deliveryMethod"]').selectOption('pickup');
  return {page, state};
}

async function choose(line, code) {
  await line.locator('[data-sales-stock-field="itemSearch"]').fill(code);
  await line.locator('[data-sales-stock-action="choose-item"]').click();
  await expect(line.locator('[data-sales-stock-field="salesQty"]')).toBeEditable();
}
const input = (line, field) => line.locator(`[data-sales-stock-field="${field}"]`);

test('item code and sales UOM share the pack row, calculate both directions and save/reopen the rounded request', async t => {
  const {page, state} = await fixture(t), line = page.locator('[data-sales-stock-line]').first();
  await choose(line, 'PAVER');
  for (const width of [1440, 1280]) {
    await page.setViewportSize({width, height: 1000});
    const boxes = await Promise.all(['itemSearch', 'pallets', 'layers', 'sections', 'pieces', 'salesQty'].map(field => input(line, field).boundingBox()));
    assert.ok(boxes.every(box => Math.abs(box.y - boxes[0].y) < 2), 'Item code and all five quantity inputs share the same row');
    assert.ok(boxes.slice(1).every((box, index) => box.x >= boxes[index].x + boxes[index].width), 'Inputs do not overlap');
  }
  await input(line, 'salesQty').pressSequentially('2000');
  await expect(input(line, 'salesQty')).toBeFocused();
  await expect(input(line, 'salesQty')).toHaveValue('2000');
  await expect(input(line, 'pallets')).toHaveValue('16');
  await expect(input(line, 'layers')).toHaveValue('7');
  await expect(line.locator('[data-sales-stock-quantity-help]')).toContainText('Closest pack quantity: 2,004 SQFT');
  await input(line, 'salesQty').press('Tab');
  await expect(input(line, 'salesQty')).toHaveValue('2004');
  await input(line, 'pallets').fill('2');
  await input(line, 'layers').fill('3');
  await input(line, 'sections').fill('1');
  await input(line, 'pieces').fill('2');
  await expect(input(line, 'salesQty')).toHaveValue('282');
  await input(line, 'salesQty').fill('2000');
  await page.locator('[data-sales-stock-form] button[type="submit"]').click();
  await expect(page.locator('[data-sales-stock-action="edit"]')).toBeVisible();
  assert.equal(state.bodies.length, 1);
  assert.deepEqual(state.bodies[0].lines[0], {itemId: 901, sourceLocationId: 28, pallets: 16, layers: 7, sections: 0, pieces: 0});
  assert.equal(state.saved.lines[0].salesQty, 2004);
  await page.locator('[data-sales-stock-action="edit"]').click();
  await expect(input(line, 'salesQty')).toHaveValue('2004');
  await expect(input(line, 'layers')).toHaveValue('7');
});

test('clearing, invalid input, item replacement and multiple lines cannot retain stale quantities', async t => {
  const {page} = await fixture(t), line = page.locator('[data-sales-stock-line]').first();
  await choose(line, 'PAVER');
  await input(line, 'salesQty').fill('2000');
  await input(line, 'salesQty').fill('');
  await expect(input(line, 'pallets')).toHaveValue('');
  await expect(input(line, 'layers')).toHaveValue('');
  await input(line, 'pallets').fill('2');
  await input(line, 'salesQty').fill('-10');
  await expect(input(line, 'pallets')).toHaveValue('');
  assert.equal(await input(line, 'salesQty').evaluate(element => element.validity.valid), false);
  await input(line, 'salesQty').fill('120');
  await page.locator('[data-sales-stock-action="add-line"]').click();
  const second = page.locator('[data-sales-stock-line]').nth(1);
  await choose(second, 'DECIMAL');
  await input(second, 'salesQty').fill('2000');
  await input(second, 'salesQty').press('Tab');
  await expect(input(second, 'salesQty')).toHaveValue('1995.84');
  await expect(input(line, 'salesQty')).toHaveValue('120');
  await choose(line, 'BULK');
  await expect(input(line, 'salesQty')).toHaveValue('');
  await expect(input(line, 'pallets')).toHaveCount(0);
  await input(line, 'salesQty').fill('2.75');
  await input(line, 'salesQty').press('Tab');
  await expect(input(line, 'salesQty')).toHaveValue('2.75');
  await expect(input(second, 'salesQty')).toHaveValue('1995.84');
});

test('mobile conversion is usable without overflow and waitlist keeps exact sales quantities', async t => {
  const {page} = await fixture(t, 390), line = page.locator('[data-sales-stock-line]').first();
  await choose(line, 'PAVER');
  await input(line, 'salesQty').fill('2000');
  await input(line, 'salesQty').press('Tab');
  await expect(input(line, 'salesQty')).toHaveValue('2004');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.locator('[data-regular-field="deliveryMethod"]').selectOption('waitlist');
  await expect(input(line, 'pallets')).toHaveCount(0);
  await input(line, 'salesQty').fill('2011');
  await input(line, 'salesQty').press('Tab');
  await expect(input(line, 'salesQty')).toHaveValue('2011');
  await page.locator('[data-regular-field="deliveryMethod"]').selectOption('pickup');
  await expect(input(line, 'salesQty')).toHaveValue('2016');
});

test('Sales SO previews sit beside their references and open one in-app dialog on desktop and mobile', async t => {
  for (const width of [1440, 390, 320]) {
    const {page, state} = await fixture(t, width);
    const detail = {id: 10, revision: 1, requestRef: 'REQ-PREVIEW', workflowVersion: 2,
      workflowKind: 'backorder', requestType: 'regular', status: 'completed', stage: 'completed', bucket: 'completed',
      regular: {deliveryMethod: 'backorder'}, destinationLocationId: 1, destinationName: '3445',
      customerName: 'Preview customer', fulfillmentMethod: 'yard_pickup',
      salesOrderId: 123, salesOrderRef: 'SOB123456', salesOrderStatus: 'Fulfilled',
      purchaseOrderId: 456, purchaseOrderRef: 'POB123456', purchaseOrderStatus: 'Received',
      lines: [{id: 1, itemName: 'PAVER', productName: 'Paving stone', quantity: 120, uom: 'SQFT',
        vendorName: 'Test vendor', destinationName: '3445', salesDecision: 'accepted', supplyStatus: 'in_stock', originalRate: null}],
      events: [], transfers: [], availability: []};
    state.saved = detail;
    await page.route('**/sales-order/document.pdf', route => route.fulfill({contentType: 'application/pdf', body: '%PDF-1.4\n%%EOF'}));
    await page.route('**/orders/sales_order.pdf', route => route.fulfill({contentType: 'application/pdf', body: '%PDF-1.4\n%%EOF'}));
    await page.reload();
    await expect(page.locator('[data-backorder-detail]')).toBeVisible();
    for (const kind of ['backorder', 'special']) {
      if (kind === 'special') {
        await page.evaluate(async detail => {
          const {specialPlanningStatus} = await import('/special-stock-case-status.js?inlineSo=20261027-v1');
          document.querySelector('.stock-request-page').classList.add('special-stock-page');
          document.querySelector('.stock-request-detail').innerHTML = specialPlanningStatus(detail, false, {audience: 'sales', showOrderPreviews: true});
        }, detail);
      }
      const reference = page.locator(kind === 'backorder' ? '.stock-request-order-reference' : '.special-sales-order-reference');
      const preview = reference.getByRole('button', {name: 'Preview SO', exact: true});
      await expect(page.getByRole('button', {name: 'Preview SO', exact: true})).toHaveCount(1);
      const [text, button] = await Promise.all([reference.locator('strong').boundingBox(), preview.boundingBox()]);
      assert.ok(button.x >= text.x + text.width, `${kind}: Preview SO is beside the SO reference`);
      assert.ok(Math.abs(button.y + button.height / 2 - text.y - text.height / 2) < 2, `${kind}: SO reference and preview align vertically`);
      const row = await reference.boundingBox();
      assert.ok(row.x >= 0 && row.x + row.width <= width + 1, `${kind}: SO row fits the viewport at ${width}px`);
      assert.ok(button.x + button.width <= row.x + row.width + 1, `${kind}: Preview SO stays inside its reference span`);
      await preview.click();
      const dialog = page.locator('dialog.special-document-dialog');
      await expect(dialog).toHaveCount(1);
      await expect(dialog.locator('iframe')).toHaveAttribute('src', /^blob:/);
      await dialog.getByRole('button', {name: 'Close', exact: true}).click();
      await expect(dialog).toHaveCount(0);
      await expect(preview).toBeFocused();
    }
  }
});
