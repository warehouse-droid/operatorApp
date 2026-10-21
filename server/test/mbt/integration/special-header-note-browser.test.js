/* global localStorage, getComputedStyle */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const out = process.env.SPECIAL_HEADER_NOTE_BROWSER_OUTPUT || 'test-artifacts/special-header-note-20261001/browser';
let browser, capture = 0;
before(async () => { await mkdir(out, { recursive: true }); browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] }); });
after(async () => browser?.close());
async function fixture({ width = 1440, patch = {} } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('mbbs.staff.token', 'test-header-note'));
  const page = await context.newPage(); page.setDefaultTimeout(5000); await page.coverage.startJSCoverage({ resetOnNavigation: false });
  const record = { id: 1, requestRef: 'SPREQ-000022', revision: 3, status: 'active', stage: 'await_customer_confirmation',
    closeStatus: 'active', storeLocationId: 1, storeName: '3445', customerName: 'TEST Customer', customerPhone: '555-0100',
    vendorName: 'TEST Vendor', remarks: 'Original note', inquiryDate: '2099-01-01', expiresOn: '2099-03-01', fulfillmentMethod: 'yard_pickup',
    palletTotal: 3, palletRate: 40, lines: [{ id: 10, productName: 'Stone', color: 'Grey', size: '80mm', detailSpec: 'Smooth',
      quantity: 2, packageQuantity: 2, uom: 'PLT', rateUom: 'PLT', originalRate: 100, discountPercent: 10, subtotal: 180,
      requiredDate: '2099-02-01', supplyStatus: 'in_stock', salesDecision: 'accepted', vendorYard: 'West yard', pricingSource: 'enquiry' }],
    salesOrderLines: [], purchaseOrderLines: [], media: [], events: [], readinessAlerts: [], ...patch };
  const state = { posts: [], errors: [], record, rejectNext: false, serverError: false };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.hostname !== 'localhost') return route.abort();
    if (path.startsWith('/api/')) {
      if (request.method() !== 'GET') {
        const body = request.postDataJSON(); state.posts.push({ path, body, method: request.method() });
        if (path.endsWith('/case-lines')) {
          for (const line of body.lines || []) record.lines.find(item => item.id === line.lineId).originalRate = Number(line.rate);
          record.revision++; return route.fulfill({ json: record });
        }
        assert.equal(path, '/api/sales/special-stock-requests/1/header'); assert.equal(request.method(), 'PUT');
        if (state.rejectNext) { state.rejectNext = false; record.revision++; record.remarks = 'SCM changed note';
          return route.fulfill({ status: 409, json: { error: 'Request changed. Review the latest request.', code: 'SPECIAL_REVISION_CONFLICT' } }); }
        if (state.serverError) { state.serverError = false; return route.fulfill({ status: 500, json: { error: 'Save failed; try again.' } }); }
        assert.equal(body.expectedRevision, record.revision);
        const fields = ['remarks','fulfillmentMethod','deliveryAddress','deliveryContactName','deliveryContactPhone','deliveryDate','windowStart','windowEnd','deliveryInstructions','deliveryFeeRate'];
        let changed = false;
        for (const field of fields) if (Object.hasOwn(body,field) && String(record[field] ?? '') !== String(body[field])) { record[field] = body[field]; changed = true; }
        if (changed) record.revision++;
        return route.fulfill({ json: record });
      }
      if (path === '/api/auth/me') return route.fulfill({ json: { operator: { id: 'test-header-note', display_name: 'TEST Sales', role: 'sales', roles: ['sales'], yard_location_ids: [1] } } });
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

const note = '44 Sherwood Ave, Scarborough, ON M1R 1N5\n\n全贴砖方案\n墙砖净面积估算： 约 5,200 sqft\n含 5% 损耗总面积： 5,200 × 1.05 = 5,460 sqft';
const header = page => page.locator('[data-special-header-form]');
test('Sales edits Note and delivery address/contact directly with one Save header button and preserves request progress', async () => {
  const { page, state, close } = await fixture(); try {
    const form = header(page); await expect(form).toBeVisible(); await expect(form.locator('[name=remarks]')).toHaveValue('Original note');
    await expect(page.getByRole('button', { name: 'Edit note', exact: true })).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Save header', exact: true })).toHaveCount(1);
    await form.locator('[name=remarks]').fill(note); await form.locator('[name=fulfillmentMethod]').selectOption('mbt_delivery');
    await form.locator('[name=deliveryAddress]').fill('44 Sherwood Ave'); await form.locator('[name=deliveryContactName]').fill('客户 王');
    await form.locator('[name=deliveryContactPhone]').fill('416-555-0100'); await form.locator('[name=deliveryDate]').fill('2099-02-01');
    await form.getByRole('button', { name: 'Save header', exact: true }).click(); await expect(page.locator('.stock-request-feedback')).toContainText('Header saved');
    assert.equal(state.posts.length, 1); assert.equal(state.posts[0].body.expectedRevision, 3); assert.equal(state.posts[0].body.remarks, note);
    assert.equal(state.record.deliveryContactName, '客户 王'); assert.equal(state.record.stage, 'await_customer_confirmation');
    assert.equal(state.record.lines[0].supplyStatus, 'in_stock'); assert.equal(state.record.lines[0].salesDecision, 'accepted');
    await expect(header(page).locator('[name=remarks]')).toHaveValue(note);
    await header(page).screenshot({ path: out + '/saved-header.png' });
  } finally { await close(); }
});
test('phone header Note supports pickup, clearing, and a no-op save without exposing hidden delivery fields', async () => {
  const { page, state, close } = await fixture({ width: 390 }); try {
    const form = header(page); await expect(form).toBeVisible(); await expect(form.locator('[name=deliveryAddress]')).toBeHidden();
    await form.locator('[name=remarks]').fill(note); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await form.screenshot({ path: out + '/phone-header.png' }); await form.getByRole('button', { name: 'Save header', exact: true }).click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Header saved'); assert.equal(state.posts.length, 1);
    assert.ok(!Object.hasOwn(state.posts[0].body, 'deliveryAddress')); assert.equal(state.record.remarks, note);
    await header(page).getByRole('button', { name: 'Save header', exact: true }).click(); await expect(page.locator('.stock-request-feedback')).toContainText('already saved');
    assert.equal(state.posts.length, 1); await header(page).locator('[name=remarks]').fill('');
    await header(page).getByRole('button', { name: 'Save header', exact: true }).click(); await expect(header(page).locator('[name=remarks]')).toHaveValue('');
    assert.equal(state.posts.length, 2); assert.equal(state.record.stage, 'await_customer_confirmation');
  } finally { await close(); }
});
test('header errors retain Note/address and revision conflicts require explicit reload before another save', async () => {
  const { page, state, close } = await fixture(); try {
    let form = header(page); await form.locator('[name=remarks]').fill(note); state.serverError = true;
    await form.getByRole('button', { name: 'Save header', exact: true }).click(); await expect(page.locator('.stock-request-feedback')).toContainText('Save failed');
    await expect(header(page).locator('[name=remarks]')).toHaveValue(note); await expect(header(page).getByRole('button', { name: 'Save header', exact: true })).toBeEnabled();
    state.rejectNext = true; await header(page).getByRole('button', { name: 'Save header', exact: true }).click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Request changed'); await expect(header(page).locator('[name=remarks]')).toHaveValue(note);
    await expect(header(page).getByRole('button', { name: 'Save header', exact: true })).toBeDisabled();
    assert.equal(state.posts.length, 2); await header(page).getByRole('button', { name: 'Reload header', exact: true }).click();
    form = header(page); await expect(form.locator('[name=remarks]')).toHaveValue('SCM changed note'); await form.locator('[name=remarks]').fill(note);
    await form.getByRole('button', { name: 'Save header', exact: true }).click(); await expect(page.locator('.stock-request-feedback')).toContainText('Header saved');
    assert.equal(state.posts.at(-1).body.expectedRevision, 4);
  } finally { await close(); }
});
test('unsaved header fields survive rerenders and must be saved before opening line or Add item editors', async () => {
  const { page, state, close } = await fixture(); try {
    await header(page).locator('[name=remarks]').fill(note);
    await page.getByRole('button', { name: 'Edit case lines', exact: true }).click(); await expect(page.locator('.stock-request-feedback')).toContainText('Save header');
    await expect(page.locator('[data-special-case-edit-form]')).toHaveCount(0); await expect(header(page).locator('[name=remarks]')).toHaveValue(note);
    await page.getByRole('button', { name: 'Add item', exact: true }).click(); await expect(page.locator('.stock-request-feedback')).toContainText('Save header');
    await expect(page.getByRole('dialog')).toHaveCount(0); assert.equal(state.posts.length, 0);
    await header(page).getByRole('button', { name: 'Save header', exact: true }).click(); await expect(page.locator('.stock-request-feedback')).toContainText('Header saved');
    await page.getByRole('button', { name: 'Edit case lines', exact: true }).click(); await expect(page.locator('[data-special-case-edit-form]')).toBeVisible();
    await header(page).locator('[name=remarks]').fill('Unsaved second note'); await header(page).getByRole('button', { name: 'Save header', exact: true }).click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Save or cancel'); await expect(header(page).locator('[name=remarks]')).toHaveValue('Unsaved second note');
    await page.locator('[data-special-case-edit-line="10"] [name=rate]').fill('80');
    await page.locator('[data-special-case-edit-form]').getByRole('button', { name: 'Save line changes', exact: true }).click();
    await expect(page.locator('[data-special-case-edit-form]')).toBeVisible();
    await expect(header(page).locator('[name=remarks]')).toHaveValue('Unsaved second note');
    await expect(page.locator('.stock-request-feedback')).toContainText('Cancel case edits');
    assert.equal(state.posts.length, 1);
  } finally { await close(); }
});
test('closed requests display safely escaped multiline Notes without a Note editor', async () => {
  for (const patch of [{ closeStatus: 'closed', stage: 'closed' }, { operationallyComplete:true,stage:'completed' }]) {
    const { page, state, close } = await fixture({ patch: { ...patch, remarks: note + '\n<script>window.bad=true</script>' } }); try {
      await expect(header(page)).toHaveCount(0); await expect(page.locator('[name=remarks]')).toHaveCount(0);
      const display = page.locator('.special-header-note-content'); await expect(display).toContainText(note);
      assert.equal(await display.evaluate(element => getComputedStyle(element).whiteSpace), 'pre-wrap');
      assert.equal(await page.evaluate(() => window.bad), undefined); assert.equal(state.posts.length, 0);
    } finally { await close(); }
  }
});

test('pickup-to-delivery header shows, retains and submits the customer fee on desktop and phone', async () => {
  for (const width of [1440, 390]) {
    const { page, state, close } = await fixture({ width }); try {
      const form = header(page), fee = form.locator('[name=deliveryFeeRate]');
      await expect(fee).toBeHidden(); await expect(fee).toBeDisabled();
      await form.locator('[name=fulfillmentMethod]').selectOption('mbt_delivery');
      await expect(fee).toBeVisible(); await expect(fee).toBeEnabled(); await expect(fee).toHaveValue('');
      await form.locator('[name=deliveryAddress]').fill('TEST Delivery');
      await form.locator('[name=deliveryDate]').fill('2099-02-01');
      await fee.fill(width === 390 ? '0' : '235');
      await form.locator('[name=fulfillmentMethod]').selectOption('vendor_pickup');
      await expect(fee).toBeHidden(); await expect(fee).toBeDisabled();
      await form.locator('[name=fulfillmentMethod]').selectOption('mbt_delivery');
      await expect(fee).toHaveValue(width === 390 ? '0' : '235');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await form.getByRole('button', { name: 'Save header', exact: true }).click();
      await expect(page.locator('.stock-request-feedback')).toContainText('Header saved');
      assert.equal(state.posts.length, 1); assert.equal(state.posts[0].body.deliveryFeeRate, width === 390 ? '0' : '235');
      await expect(header(page).locator('[name=deliveryFeeRate]')).toHaveValue(width === 390 ? '0' : '235');
      await header(page).screenshot({ path: out + `/delivery-fee-header-${width}.png` });
    } finally { await close(); }
  }
});

test('header fee survives save errors and pickup omits the hidden field from submission', async () => {
  const { page, state, close } = await fixture(); try {
    const form = header(page);
    await form.locator('[name=fulfillmentMethod]').selectOption('mbt_delivery');
    await form.locator('[name=deliveryAddress]').fill('TEST Delivery');
    await form.locator('[name=deliveryDate]').fill('2099-02-01');
    await form.locator('[name=deliveryFeeRate]').fill('235'); state.serverError = true;
    await form.getByRole('button', { name: 'Save header', exact: true }).click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Save failed');
    await expect(header(page).locator('[name=deliveryFeeRate]')).toHaveValue('235');
    await header(page).locator('[name=fulfillmentMethod]').selectOption('yard_pickup');
    await header(page).locator('[name=remarks]').fill('Updated pickup note');
    await header(page).getByRole('button', { name: 'Save header', exact: true }).click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Header saved');
    assert.equal(state.posts.length, 2); assert.equal(Object.hasOwn(state.posts.at(-1).body, 'deliveryFeeRate'), false);
  } finally { await close(); }
});


test('confirmed and planned issued requests keep a Note-only editor on desktop and phone',async()=>{
  for(const width of [1440,390])for(const planned of [false,true]){
    const {page,state,close}=await fixture({width,patch:{stage:'confirmed',salesOrderId:42,salesOrderRef:'TEST-SOB42',purchaseOrderId:43,
      dispatchPlanning:{anyPlanned:planned},dispatchPlanned:planned}});
    try{
      const form=page.locator('[data-special-note-form]');await expect(form).toBeVisible();
      await expect(form.locator('[name=fulfillmentMethod]')).toHaveCount(0);
      await form.locator('[name=remarks]').fill(note);await form.getByRole('button',{name:'Save note',exact:true}).click();
      await expect(page.locator('.stock-request-feedback')).toContainText('Note saved');
      assert.equal(state.posts.length,1);assert.deepEqual(Object.keys(state.posts[0].body).sort(),['expectedRevision','remarks']);
      assert.equal(state.record.remarks,note);assert.equal(state.record.stage,'confirmed');assert.equal(state.record.salesOrderId,42);
      await expect(page.locator('[data-special-note-form] [name=remarks]')).toHaveValue(note);
      await page.locator('[data-special-note-form]').screenshot({path:out+`/confirmed-note-${width}-${planned}.png`});
    }finally{await close();}
  }
});

test('issued Note edits keep unsaved text after a failed save and require reload after a revision conflict',async()=>{
  const {page,state,close}=await fixture({patch:{stage:'confirmed',salesOrderId:42,salesOrderRef:'TEST-SOB42'}});
  try{
    const form=()=>page.locator('[data-special-note-form]');await form().locator('[name=remarks]').fill(note);state.serverError=true;
    await form().getByRole('button',{name:'Save note',exact:true}).click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Save failed');await expect(form().locator('[name=remarks]')).toHaveValue(note);
    state.rejectNext=true;await form().getByRole('button',{name:'Save note',exact:true}).click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Request changed');await expect(form().locator('[name=remarks]')).toHaveValue(note);
    await expect(form().getByRole('button',{name:'Save note',exact:true})).toBeDisabled();
    await form().getByRole('button',{name:'Reload note',exact:true}).click();await expect(form().locator('[name=remarks]')).toHaveValue('SCM changed note');
    await form().locator('[name=remarks]').fill('');await form().getByRole('button',{name:'Save note',exact:true}).click();
    await expect(form().locator('[name=remarks]')).toHaveValue('');assert.equal(state.posts.at(-1).body.expectedRevision,4);
  }finally{await close();}
});
