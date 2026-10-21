/* global document, localStorage */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

let browser;
let capture = 0;
const out = process.env.SPECIAL_BATCH_BROWSER_OUTPUT || 'test-artifacts/special-workflow-review/po-line-discount-20260928';
before(async () => { await mkdir(out, { recursive: true }); browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] }); });
after(async () => browser?.close());
async function fixture(audience, width = 1440, configure = () => {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('mbbs.staff.token', 'test-batch'));
  const page = await context.newPage(); page.setDefaultTimeout(5000);
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
  const state = { record, posts: [], errors: [], fail: false };
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
        return route.fulfill({ json: record });
      }
      if (path.endsWith('/sales-reps')) return route.fulfill({ json: { salesReps: [{ id: 123, name: 'TEST NetSuite Rep A' }, { id: 456, name: 'TEST NetSuite Rep B' }] } });
      if (path.endsWith('/vendors')) return route.fulfill({ json: { vendors: [{id:8899200,name:'TEST Vendor'}] } });
      if (path === '/api/auth/me') return route.fulfill({ json: { operator: { id: 'test-batch', display_name: 'TEST Rep', role: audience, roles: [audience] } } });
      if (path.endsWith('/policy')) return route.fulfill({ json: { enabled: true } });
      if (path.endsWith('/special-stock-requests/1')) return route.fulfill({ json: record });
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

test('SCM one save validates every ETA, preserves all line drafts after failure, and posts once on retry', async () => {
  const { page, context, state } = await fixture('scm');
  try {
    const save = page.getByRole('button', { name: 'Save stock check', exact: true });
    await expect(save).toHaveCount(1);
    const lines = page.locator('[data-special-stock-line]');
    await expect(lines).toHaveCount(3);
    await lines.nth(0).locator('[name=vendorName]').fill('TEST');
    await expect(lines.nth(0).locator('[name=vendorId]')).toHaveValue('');
    await lines.nth(0).locator('[data-special-scm-action="choose-vendor"]').click();
    await expect(lines.nth(0).locator('[name=vendorId]')).toHaveValue('8899200');
    await lines.nth(0).locator('[name=salesVisibleNote]').fill('First reply');
    await lines.nth(1).locator('[name=salesVisibleNote]').fill('Second reply');
    await lines.nth(0).locator('[name=supplyStatus]').selectOption('production');
    await lines.nth(1).locator('[name=supplyStatus]').selectOption('vendor_transfer');
    await lines.nth(0).locator('[name=availableDate]').fill('2099-02-01');
    await save.click(); assert.equal(state.posts.length, 0);
    await lines.nth(1).locator('[name=availableDate]').fill('2099-03-01');
    state.fail = true; await save.click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Review changed');
    await expect(lines.nth(0).locator('[name=salesVisibleNote]')).toHaveValue('First reply');
    await expect(lines.nth(1).locator('[name=salesVisibleNote]')).toHaveValue('Second reply');
    await expect(lines.nth(0).locator('[name=availableDate]')).toHaveValue('2099-02-01');
    await expect(lines.nth(1).locator('[name=availableDate]')).toHaveValue('2099-03-01');
    state.fail = false; await save.click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Saved.');
    assert.equal(state.posts.length, 2);
    assert.equal(state.posts[1].path, '/api/scm/special-stock-requests/1/stock-check');
    assert.deepEqual(state.posts[1].body.lines.map(l => [l.lineId,l.supplyStatus,l.availableDate,l.salesVisibleNote]),
      [[1,'production','2099-02-01','First reply'],[2,'vendor_transfer','2099-03-01','Second reply'],[3,'in_stock',null,'']]);
    assert.equal(state.posts[1].body.expectedRevision, 1);
    assert.deepEqual(state.errors, []);
    await page.screenshot({ path: `${out}/scm-batch.png`, fullPage: true });
  } finally { await context.close(); }
});

for (const supplyStatus of ['in_stock', 'no_stock']) test(`SCM edits item names awaiting customer confirmation and retains them after a failed mobile save (${supplyStatus})`, async () => {
  const { page, context, state } = await fixture('scm', 390, record => {
    record.stage = 'await_customer_confirmation'; record.lines[0].supplyStatus = supplyStatus;
  });
  try {
    const name = page.locator('[data-special-stock-line]').first().locator('[name=productName]');
    await expect(name).toHaveValue('TEST product 1');
    await name.fill('Fire Pit 32" Square Insert <img src=x>');
    state.fail = true;
    await page.getByRole('button', { name: 'Save stock check', exact: true }).click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Review changed');
    await expect(name).toHaveValue('Fire Pit 32" Square Insert <img src=x>');
    state.fail = false;
    await page.getByRole('button', { name: 'Save stock check', exact: true }).click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Saved.');
    assert.equal(state.posts[1].body.lines[0].productName, 'Fire Pit 32" Square Insert <img src=x>');
    await expect(page.locator('.stock-request-line').first().locator('header')).toContainText('Fire Pit 32" Square Insert <img src=x>');
    await expect(page.locator('.stock-request-line img')).toHaveCount(0);
    assert.deepEqual(state.errors, []);
  } finally { await context.close(); }
});

test('SCM retains readiness fields without item-name editing after SO creation', async () => {
  const { page, context } = await fixture('scm', 1440, record => {
    record.salesOrderId = 10;
    record.stage = 'confirmed';
    record.lines.forEach(line => { line.salesDecision = 'accepted'; });
  });
  try {
    await expect(page.locator('[data-special-stock-line][data-kind=readiness]')).toHaveCount(3);
    await expect(page.locator('[data-special-stock-line] [name=productName]')).toHaveCount(0);
  } finally { await context.close(); }
});

test('Sales one save keeps undecided lines pending and requires the decline reason on mobile', async () => {
  const { page, context, state } = await fixture('sales', 390);
  try {
    const save = page.getByRole('button', { name: 'Save customer decisions', exact: true });
    await expect(save).toHaveCount(1);
    const lines = page.locator('[data-special-decision-line]');
    await expect(lines).toHaveCount(3);
    await expect(lines.nth(2).locator('[name=decision]')).toHaveValue('');
    await lines.nth(0).locator('[name=decision]').selectOption('accepted');
    await lines.nth(0).locator('[name=customerNote]').fill('First customer note');
    await lines.nth(1).locator('[name=decision]').selectOption('declined');
    await save.click(); assert.equal(state.posts.length, 0);
    await lines.nth(1).locator('[name=reason]').fill('Too late');
    state.fail = true; await save.click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Review changed');
    await expect(lines.nth(0).locator('[name=decision]')).toHaveValue('accepted');
    await expect(lines.nth(1).locator('[name=reason]')).toHaveValue('Too late');
    await expect(lines.nth(2).locator('[name=decision]')).toHaveValue('');
    state.fail = false; await save.click();
    await expect.poll(() => state.posts.length).toBe(2);
    assert.equal(state.posts[1].path, '/api/sales/special-stock-requests/1/customer-decisions');
    assert.deepEqual(state.posts[1].body.lines, [{ lineId: 1, decision: 'accepted', reason: '', customerNote: 'First customer note' }, { lineId: 2, decision: 'declined', reason: 'Too late', customerNote: '' }]);
    await expect(page.locator('[data-special-decision-line]')).toHaveCount(1);
    assert.equal(state.record.lines[2].salesDecision, 'pending');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    assert.deepEqual(state.errors, []);
    await page.screenshot({ path: `${out}/sales-batch-mobile.png`, fullPage: true });
  } finally { await context.close(); }
});


test('SCM requires a percentage per material, retains distinct failed inputs, and sends gross costs', async () => {
  const {page,context,state}=await fixture('scm',1440,d=>{
    Object.assign(d,{stage:'confirmed',salesOrderId:10,salesOrderApproved:true,purchaseOrderOperationStatus:'idle'});
    d.lines.forEach(l=>{l.salesDecision='accepted';});
    d.purchaseOrderLines=d.lines.map(l=>({caseLineId:l.id,description:l.productName,quantity:10,uom:'PC',unitPurchaseCost:10}));
  });
  try {
    const discount=page.locator('[name=vendorDiscountPercent]'),create=page.getByRole('button',{name:'Create PO in NetSuite',exact:true});
    await expect(discount).toHaveCount(3);
    await expect(page.locator('[name=vendorDiscountAmount]')).toHaveCount(0);
    await expect(discount.nth(0)).toHaveValue('');await create.click();assert.equal(state.posts.length,0);
    for(const [i,pct] of ['0','10','20'].entries()) await discount.nth(i).fill(pct);
    await expect(page.locator('[data-special-purchase-totals]')).toContainText('Gross purchase total: 300 · Vendor discount: 30 · Net purchase total: 270');
    state.fail=true;await create.click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Review changed');
    for(const [i,pct] of ['0','10','20'].entries()) await expect(discount.nth(i)).toHaveValue(pct);
    state.fail=false;await create.click();await expect.poll(()=>state.posts.length).toBe(2);
    assert.equal(state.posts[1].body.vendorDiscountAmount,undefined);
    assert.deepEqual(state.posts[1].body.lines.map(l=>l.vendorDiscountPercent),['0','10','20']);
    assert.deepEqual(state.posts[0].body.lines.map(l=>l.unitPurchaseCost),['10','10','10']);
    assert.deepEqual(state.errors,[]);
  }finally{await context.close();}
});

test('Sales loads real-directory choices, requires one, and sends the selected rep at SO creation', async () => {
  const {page,context,state}=await fixture('sales',1440,d=>{
    Object.assign(d,{customerId:10,palletTotal:0,deliveryContactName:'TEST Contact',deliveryContactPhone:'555-0100'});
    d.lines.forEach(l=>Object.assign(l,{salesDecision:'accepted',originalRate:10,rateUom:'PC',packageQuantity:2,conversionToPc:1,pricingSource:'enquiry'}));
    d.salesOrderLines=d.lines.map(l=>({caseLineId:l.id,itemId:2055,description:l.productName,quantity:2,packageQuantity:2,conversionToPc:1,uom:'PC',rate:10,discountPercent:0}));
  });
  try {
    const rep=page.locator('[name=salesRepId]'),create=page.locator('[data-special-sales-action="create-so"]');
    await expect(rep.locator('option')).toHaveCount(3);await expect(rep).toHaveValue('');await expect(create).toBeDisabled();
    await rep.selectOption('456');
    await page.locator('[data-special-so-form] button[type=submit]').click();
    await expect.poll(()=>state.posts.length).toBe(1);
    assert.equal(state.posts[0].body.salesRepId,456);
    await expect(create).toBeEnabled();await create.click();await expect.poll(()=>state.posts.length).toBe(2);
    assert.equal(Number(state.posts[1].body.salesRepId),456);
    assert.deepEqual(state.errors,[]);
  }finally{await context.close();}
});
