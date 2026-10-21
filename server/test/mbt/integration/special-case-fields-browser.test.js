/* global document, localStorage */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

let browser;
let capture = 0;
const out = process.env.SPECIAL_BATCH_BROWSER_OUTPUT || 'test-artifacts/special-case-fields-20261003/browser';
before(async () => { await mkdir(out, { recursive: true }); browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] }); });
after(async () => browser?.close());
async function fixture(audience, width = 1440, configure = () => {}, now = null) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('mbbs.staff.token', 'test-batch'));
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  if (now) await page.clock.install({ time: new Date(now) });
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  const close = context.close.bind(context);
  context.close = async () => {
    await writeFile(`${out}/browser-coverage-${++capture}.json`, JSON.stringify(await page.coverage.stopJSCoverage()));
    return close();
  };
  const record = { id: 1, requestRef: 'SPREQ-BATCH', stage: 'new_enquiry', revision: 1, storeName: '3445', storeLocationId: 1,
    customerName: 'TEST Customer', vendorName: 'TEST Vendor', vendorId: 8899200, inquiryDate: '2099-01-01', closeStatus: 'active', fulfillmentMethod: 'yard_pickup',
    lines: [1,2,3].map(id => ({ id, productName: `TEST product ${id}`, quantity: 2, uom: 'PLT', salesDecision: 'pending', supplyStatus: 'in_stock', vendorYard: `Yard ${id}` })),
    salesOrderLines: [], purchaseOrderLines: [], events: [], media: [], readinessAlerts: [] };
  configure(record);
  const state = { record, posts: [], reads: [], errors: [], fail: false, failDetailRead: false, stockCheckReply: null };
  page.on('pageerror', e => state.errors.push(e.message));
  await page.route('**/*', async route => {
    const { pathname: path, hostname } = new URL(route.request().url());
    if (hostname !== 'localhost') return route.abort();
    if (path.startsWith('/api/')) {
      if (['POST','PUT'].includes(route.request().method())) {
        const body = route.request().postDataJSON(); state.posts.push({ path, body });
        if (state.fail) return route.fulfill({ status: 409, json: { error: 'Review changed. Try again.' } });
        if (path.endsWith('/sales-order-draft')) record.netsuiteSalesRepId = Number(body.salesRepId);
        if (path.endsWith('/sales-order/create')) { record.salesOrderId = 10; record.salesOrderRef = 'TEST-SO'; }
        if (path.endsWith('/purchase-order/create')) { record.purchaseOrderId = 20; record.purchaseOrderRef = 'TEST-PO'; }
        for (const input of body.lines || []) {
          const line = record.lines.find(l => l.id === input.lineId);
          if (line) Object.assign(line, input, input.decision ? { salesDecision: input.decision } : {});
        }
        record.revision++;
        if (path.endsWith('/stock-check') && state.stockCheckReply) return route.fulfill({ json: state.stockCheckReply(record) });
        return route.fulfill({ json: record });
      }
      if (path.endsWith('/sales-reps')) return route.fulfill({ json: { salesReps: [{ id: 123, name: 'TEST NetSuite Rep A' }, { id: 456, name: 'TEST NetSuite Rep B' }] } });
      if (path.endsWith('/vendors')) return route.fulfill({ json: { vendors: [{id:8899200,name:'TEST Vendor'}] } });
      if (path === '/api/auth/me') return route.fulfill({ json: { operator: { id: 'test-batch', display_name: 'TEST Rep', role: audience, roles: [audience] } } });
      if (path.endsWith('/policy')) return route.fulfill({ json: { enabled: true } });
      if (path.endsWith('/special-stock-requests/1')) {
        state.reads.push(path);
        return route.fulfill(state.failDetailRead ? { status: 503, json: { error: 'Detail refresh unavailable.' } } : { json: record });
      }
      if (path.endsWith('/special-stock-requests')) return route.fulfill({ json: { yards: [{ locationId: 1, yardCode: '3445' }], requests: [record] } });
      return route.fulfill({ json: { requests: [], yards: [], total: 0 } });
    }
    const file = ({ '/scm/stock-requests': '/scm-stock-requests.html', '/sales/stock-requests': '/sales-stock-requests.html' })[path] || path;
    try { return route.fulfill({ body: await readFile('public' + file), contentType: ({ js: 'application/javascript', css: 'text/css', html: 'text/html' })[file.split('.').at(-1)] || 'application/octet-stream' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(`http://localhost/${audience}/stock-requests?tab=special`);
  await page.locator('.stock-request-card[data-id="1"]').click();
  return { page, context, state };
}

const patch = { productName: 'Corrected Stone', color: 'Black', size: '90mm', detailSpec: 'Rough', quantity: '5', uom: 'LYR',
  palletQty: '1', layerQty: '2', sectionQty: '3', pieceQty: '4', requiredDate: '2099-03-01' };
function configure(record) {
  record.palletTotal = 0; record.palletRate = null;
  record.lines = [{ id: 1, productName: 'Stone', color: 'Grey', size: '80mm', detailSpec: 'Smooth', quantity: 2,
    packageQuantity: 2, rateUom: 'PLT', uom: 'PLT', originalRate: 100, discountPercent: 10, requiredDate: '2099-02-01', customerNote: 'Old note',
    palletQty: 0, layerQty: 0, sectionQty: 0, pieceQty: 0, salesDecision: 'pending', supplyStatus: 'in_stock', vendorYard: 'North' }];
}
async function fill(line, values) { for (const [key, value] of Object.entries(values)) {
  const input = line.locator(`[name=${key}]`); await expect(input).toBeVisible(); await expect(input).toBeEnabled();
  if (key === 'uom') await input.selectOption(value); else await input.fill(value);
} }
test('Sales editor submits every New Request field and retains values through decline on a phone', async () => {
  const { page, context, state } = await fixture('sales', 390, configure);
  try {
    await page.getByRole('button', { name: 'Edit case lines', exact: true }).click();
    const form = page.locator('[data-special-case-edit-form]'), line = form.locator('[data-special-case-edit-line="1"]');
    await expect(line.locator('[name=color]')).toHaveValue('Grey');
    const values = { ...patch, discountPercent: '25', requiredDate: '2099-03-01', customerNote: 'New note' };
    await fill(line, values); await line.getByRole('button', { name: 'Decline', exact: true }).click();
    for (const [key, value] of Object.entries(values)) await expect(line.locator(`[name=${key}]`)).toHaveValue(value);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await form.screenshot({ path: out + '/sales-phone-fields.png' });
    await form.getByRole('button', { name: 'Save line changes' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Save and restart enquiry' }).click();
    await expect(form).toHaveCount(0); assert.equal(state.posts.length, 1);
    for (const [key, value] of Object.entries(values)) assert.equal(String(state.posts[0].body.lines[0][key]), value, key);
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});
test('SCM stock check submits editable material details and packing in its existing batch', async () => {
  const { page, context, state } = await fixture('scm', 1440, configure);
  try {
    const line = page.locator('[data-special-stock-line="1"]');
    await expect(line.locator('[name=productName]')).toBeHidden();
    const firstRow = await Promise.all(['requiredDate', 'supplyStatus', 'vendorName'].map(name => line.locator(`[name=${name}]`).boundingBox()));
    assert.ok(firstRow.every(box => box && Math.abs(box.y - firstRow[0].y) < 1), JSON.stringify(firstRow));
    const secondRow = await Promise.all(['vendorYard', 'salesVisibleNote', 'scmInternalNote'].map(name => line.locator(`[name=${name}]`).locator('..').boundingBox()));
    assert.ok(secondRow.every(box => box && Math.abs(box.y - secondRow[0].y) < 1), JSON.stringify(secondRow));
    await line.screenshot({ path: out + '/scm-compact-desktop.png' });
    for (const status of ['production', 'vendor_transfer']) {
      await line.locator('[name=supplyStatus]').selectOption(status);
      await expect(line.locator('[name=availableDate]')).toBeVisible();
      const withEta = await Promise.all(['requiredDate', 'supplyStatus', 'vendorName', 'availableDate'].map(name => line.locator(`[name=${name}]`).boundingBox()));
      assert.ok(withEta.every(box => box && Math.abs(box.y - withEta[0].y) < 1), JSON.stringify(withEta));
    }
    await line.screenshot({ path: out + '/scm-eta-first-row-desktop.png' });
    await line.locator('[name=supplyStatus]').selectOption('in_stock');
    await expect(line.locator('[name=availableDate]')).toBeHidden();
    await line.getByRole('button', { name: 'Edit', exact: true }).click();
    await fill(line, patch);
    await line.screenshot({ path: out + '/scm-fields.png' });
    await line.getByRole('button', { name: 'Hide details', exact: true }).click();
    await expect(line.locator('[name=productName]')).toBeHidden();
    await page.getByRole('button', { name: 'Save stock check', exact: true }).click();
    await expect.poll(() => state.posts.length).toBe(1);
    for (const [key, value] of Object.entries(patch)) assert.equal(String(state.posts[0].body.lines[0][key]), value, key);
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});
test('SCM description is normal size and quantity, UOM and packing align in one desktop row', async () => {
  const { page, context, state } = await fixture('scm', 1440, configure);
  try {
    const description = page.locator('.stock-request-line > header').getByText('Stone Grey 80mm Smooth', { exact: true });
    const font = await description.evaluate(node => ({ tag: node.tagName, size: parseFloat(getComputedStyle(node).fontSize), body: parseFloat(getComputedStyle(document.body).fontSize) }));
    assert.notEqual(font.tag, 'SMALL'); assert.ok(font.size >= font.body);
    const form = page.locator('[data-special-stock-line="1"]');
    await form.getByRole('button', { name: 'Edit', exact: true }).click();
    const controls = await Promise.all(['quantity', 'uom', 'palletQty', 'layerQty', 'sectionQty', 'pieceQty'].map(name => form.locator(`[name=${name}]`).boundingBox()));
    assert.ok(controls.every(box => box && box.width >= 75 && Math.abs(box.y - controls[0].y) < 1), JSON.stringify(controls));
    await page.locator('.stock-request-line').filter({ has: form }).screenshot({ path: out + '/scm-desktop-layout.png' });
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});
test('SCM long descriptions and stock correction controls remain readable on a phone', async () => {
  const { page, context, state } = await fixture('scm', 390, record => {
    configure(record); record.lines[0].productName = 'Stone '.repeat(60); record.lines[0].detailSpec = 'Detailed specification '.repeat(30);
  });
  try {
    const form = page.locator('[data-special-stock-line="1"]');
    await form.screenshot({ path: out + '/scm-compact-phone.png' });
    await form.getByRole('button', { name: 'Edit', exact: true }).click();
    await fill(form, patch);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    for (const name of ['quantity', 'uom', 'palletQty', 'layerQty', 'sectionQty', 'pieceQty', 'requiredDate']) {
      const input = form.locator(`[name=${name}]`); await expect(input).toBeVisible();
      assert.ok((await input.boundingBox()).width >= 100, name);
    }
    await form.screenshot({ path: out + '/scm-phone-layout.png' });
    await page.getByRole('button', { name: 'Save stock check', exact: true }).click();
    await expect.poll(() => state.posts.length).toBe(1); assert.equal(state.posts[0].body.lines[0].requiredDate, patch.requiredDate);
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});

test('SCM refreshes the right panel status and ETA layout from the latest request after saving', async () => {
  const { page, context, state } = await fixture('scm', 1440, configure);
  try {
    const form = page.locator('[data-special-stock-line="1"]');
    const readsBefore = state.reads.length;
    state.stockCheckReply = saved => {
      const reply = structuredClone(saved);
      saved.stage = 'await_customer_confirmation';
      Object.assign(saved.lines[0], { supplyStatus: 'vendor_transfer', availableDate: '2099-03-20', responseVendorName: 'Updated Vendor' });
      return reply;
    };
    await page.getByRole('button', { name: 'Save stock check', exact: true }).click();
    await expect(page.locator('.stock-request-detail > .stock-request-heading > .stock-request-pill')).toHaveText('Await Customer Confirmation');
    assert.equal(state.posts.length, 1); assert.equal(state.reads.length, readsBefore + 1);
    await expect(form.locator('[name=supplyStatus]')).toHaveValue('vendor_transfer');
    await expect(form.locator('[name=availableDate]')).toHaveValue('2099-03-20');
    await expect(form.locator('[name=vendorName]')).toHaveValue('Updated Vendor');
    const row = await Promise.all(['requiredDate', 'supplyStatus', 'vendorName', 'availableDate'].map(name => form.locator(`[name=${name}]`).boundingBox()));
    assert.ok(row.every(box => box && Math.abs(box.y - row[0].y) < 1), JSON.stringify(row));
    await expect(form.locator('[name=productName]')).toBeHidden();
    await expect(page.locator('.stock-request-card .stock-request-pill')).toHaveText('Await Customer Confirmation');
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});

test('SCM keeps a successful stock check when refreshing the latest detail fails', async () => {
  const { page, context, state } = await fixture('scm', 1440, configure);
  try {
    const form = page.locator('[data-special-stock-line="1"]');
    await form.getByRole('button', { name: 'Edit', exact: true }).click();
    await form.locator('[name=productName]').fill('Saved corrected item');
    state.stockCheckReply = saved => { state.failDetailRead = true; return saved; };
    await page.getByRole('button', { name: 'Save stock check', exact: true }).click();
    await expect(page.getByText(/Stock check saved\. The latest status could not be reloaded/)).toBeVisible();
    assert.equal(state.posts.length, 1);
    await expect(form.locator('[name=productName]')).toHaveValue('Saved corrected item');
    await expect(form.locator('[name=productName]')).toBeHidden();
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});

for (const width of [1440, 390]) test(`SCM saves collapsed material values and keeps stock fields through a failed save at ${width}px`, async () => {
  const { page, context, state } = await fixture('scm', width, record => {
    configure(record);
    Object.assign(record.lines[0], { productName: 'SLEEK PAVER HD2 SMOOTH', color: 'Shale Grey',
      size: '3 9/16 × 15 7/8 × 31 15/16', detailSpec: '84.59 ft2 /pal\n10.57 ft2 /layer',
      quantity: 1691.8, packageQuantity: 1691.8, uom: 'SQFT', rateUom: 'SQFT', palletQty: 20 });
  });
  try {
    const form = page.locator('[data-special-stock-line="1"]');
    for (const name of Object.keys(patch).filter(name => name !== 'requiredDate')) await expect(form.locator(`[name=${name}]`)).toBeHidden();
    await expect(form.locator('[name=requiredDate]')).toHaveCount(1);
    await form.locator('[name=supplyStatus]').selectOption('production');
    await expect(form.locator('[name=availableDate]')).toBeVisible();
    await expect(form.locator('[name=availableDate]')).toHaveAttribute('required', '');
    await form.locator('[name=availableDate]').fill('2099-03-01');
    await form.screenshot({ path: out + `/scm-eta-first-row-${width}.png` });
    await form.locator('[name=salesVisibleNote]').fill('Stock will be produced.');
    await form.locator('[name=scmInternalNote]').fill('Confirmed with vendor.');
    state.fail = true;
    await page.getByRole('button', { name: 'Save stock check', exact: true }).click();
    await expect(page.getByText('Review changed. Try again.', { exact: true })).toBeVisible();
    await expect(form.locator('[name=productName]')).toBeHidden();
    await expect(form.locator('[name=availableDate]')).toHaveValue('2099-03-01');
    await expect(form.locator('[name=salesVisibleNote]')).toHaveValue('Stock will be produced.');
    await expect(form.locator('[name=scmInternalNote]')).toHaveValue('Confirmed with vendor.');
    state.fail = false;
    await page.getByRole('button', { name: 'Save stock check', exact: true }).click();
    await expect.poll(() => state.posts.length).toBe(2);
    const response = state.posts[1].body.lines[0];
    for (const key of ['productName', 'color', 'size', 'detailSpec', 'quantity', 'uom', 'palletQty', 'layerQty', 'sectionQty', 'pieceQty', 'requiredDate']) {
      assert.equal(String(response[key]), String(state.posts[0].body.lines[0][key]), key);
    }
    assert.equal(response.productName, 'SLEEK PAVER HD2 SMOOTH');
    assert.equal(response.quantity, '1691.8'); assert.equal(response.uom, 'SQFT'); assert.equal(response.palletQty, '20');
    assert.equal(response.detailSpec, '84.59 ft2 /pal\n10.57 ft2 /layer');
    assert.equal(response.supplyStatus, 'production'); assert.equal(response.availableDate, '2099-03-01');
    assert.equal(response.salesVisibleNote, 'Stock will be produced.');
    await expect(form.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});
test('New Request defaults each new line to today plus 14 calendar days and preserves chosen dates', async () => {
  const { page, context, state } = await fixture('sales', 1440, configure, '2026-12-31T02:00:00Z');
  try {
    await page.getByRole('button', { name: 'New Special case', exact: true }).click();
    const form = page.locator('[data-special-case-form]');
    await expect(form.locator('[name=requiredDate]')).toHaveValue('2027-01-13');
    await form.locator('[name=requiredDate]').fill('2027-01-20');
    await form.getByRole('button', { name: 'Add line', exact: true }).click();
    await expect(form.locator('[name=requiredDate]').nth(0)).toHaveValue('2027-01-20');
    await expect(form.locator('[name=requiredDate]').nth(1)).toHaveValue('2027-01-13');
    await form.getByRole('button', { name: 'Refresh reps', exact: true }).click();
    await expect(form.locator('[name=requiredDate]').nth(0)).toHaveValue('2027-01-20');
    await expect(form.locator('[name=requiredDate]').nth(1)).toHaveValue('2027-01-13');
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});
test('issued order adjustment submits all material fields without a conversion control', async () => {
  const { page, context, state } = await fixture('sales', 1440, record => { configure(record); record.salesOrderId = 99;
    record.salesOrderRef = 'TEST-SO'; record.lines[0].salesDecision = 'accepted'; record.lines[0].conversionToPc = 2; });
  try {
    await page.locator('[data-special-adjustment-section]').getByRole('button', { name: 'Edit', exact: true }).click();
    const form = page.locator('[data-special-quantity-form]'), line = form.locator('[data-special-material="1"]');
    await expect(form.locator('[name=conversionToPc]')).toHaveCount(0);
    await expect(form).not.toContainText('Pieces per sales UOM');
    const values = { ...patch, discountPercent: '20', requiredDate: '2099-03-01', customerNote: 'New note' };
    await fill(line, values); await form.screenshot({ path: out + '/order-adjustment-fields.png' });
    await form.getByRole('button', { name: 'Request adjustment', exact: true }).click();
    await expect.poll(() => state.posts.length).toBe(1);
    for (const [key, value] of Object.entries(values)) assert.equal(String(state.posts[0].body.lines[0][key]), value, key);
    assert.equal(Object.hasOwn(state.posts[0].body.lines[0], 'conversionToPc'), false);
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});

test('opening multiline saved details and notes never silently changes them during an unrelated price edit', async () => {
  const { page, context, state } = await fixture('sales', 1440, record => {
    configure(record); record.lines[0].detailSpec = 'Top finish\nSide finish'; record.lines[0].customerNote = 'Call first\nUse side gate';
  });
  try {
    await page.getByRole('button', { name: 'Edit case lines', exact: true }).click();
    const form = page.locator('[data-special-case-edit-form]');
    await expect(form.locator('[name=detailSpec]')).toHaveValue('Top finish\nSide finish');
    await expect(form.locator('[name=customerNote]')).toHaveValue('Call first\nUse side gate');
    await form.locator('[name=rate]').fill('90'); await form.getByRole('button', { name: 'Save line changes' }).click();
    await expect(form).toHaveCount(0); assert.equal(state.posts.length, 1);
    assert.equal(Object.hasOwn(state.posts[0].body.lines[0], 'detailSpec'), false);
    assert.equal(Object.hasOwn(state.posts[0].body.lines[0], 'customerNote'), false);
  } finally { await context.close(); }
});

for (const audience of ['sales', 'scm']) test(`${audience} pending adjustment shows every corrected field without a conversion prompt`, async () => {
  const next = { productName: 'Corrected Stone', color: 'Black', size: '90mm', detailSpec: 'Rough', uom: 'LYR',
    requiredDate: '2099-03-01', customerNote: '<b data-injected>Reviewed note</b>', palletQty: 1, layerQty: 2, sectionQty: 3, pieceQty: 4 };
  const { page, context, state } = await fixture(audience, 1440, record => {
    configure(record); record.salesOrderId = 99; record.salesOrderRef = 'TEST-SO'; record.lines[0].salesDecision = 'accepted';
    record.lines[0].conversionToPc = 2; record.quantityReviewPending = true;
    record.quantityReview = { id: 'review-fields', status: 'pending', mode: 'issued', lines: [{
      caseLineId: 1, productName: 'Stone', fromPackageQuantity: 2, toPackageQuantity: 2, packageUom: 'PLT',
      fromQuantity: 4, toQuantity: 8, fromPurchaseQuantity: 4, toPurchaseQuantity: 8, salesUom: 'PC', purchaseUom: 'PC',
      fromConversion: 2, toConversion: 4, fromDiscountPercent: 10, toDiscountPercent: 20,
      fromFields: Object.fromEntries(Object.keys(next).map(key => [key, record.lines[0][key]])), toFields: next
    }] };
  });
  try {
    const review = audience === 'scm' ? page.locator('[data-special-quantity-review-form]')
      : page.locator('.stock-request-detail .stock-request-notice').filter({ hasText: 'Order adjustment · SCM review required' });
    const labels = { productName: 'Product name', color: 'Colour', size: 'Size', detailSpec: 'Detail Spec', uom: 'Sales UOM',
      requiredDate: 'Required date', customerNote: 'Line note', palletQty: 'PLT', layerQty: 'LYR', sectionQty: 'SEC', pieceQty: 'PCS' };
    for (const [key, value] of Object.entries(next)) await expect(review).toContainText(`${labels[key]}: ${state.record.lines[0][key]} → ${value}`);
    await expect(review).not.toContainText('Pieces per sales UOM');
    await expect(review).toContainText('Stone discount: 10% → 20%');
    await expect(page.locator('[data-injected]')).toHaveCount(0);
    assert.equal(state.posts.length, 0); assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});
