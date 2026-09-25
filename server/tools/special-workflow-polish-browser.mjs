import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const output = process.env.SPECIAL_POLISH_BROWSER_OUTPUT || 'test-artifacts/special-workflow-polish/browser';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const results = [], storage = {};
const customer = { id: 8899100, entityNumber: 'TEST-REVIEW', displayName: 'TEST Review Customer', phone: '416-555-0100' };
function fixture({ accepted = false, so = false, count = 6 } = {}) {
  const lines = Array.from({ length: count }, (_, index) => ({ id: 7101 + index, productName: `TEST product ${index + 1}`, quantity: 2, uom: 'PLT', originalRate: 144, rateUom: 'PLT', pricingSource: 'enquiry', discountPercent: 0, packageQuantity: 2, conversionToPc: 12, subtotal: 288,
    salesDecision: accepted ? 'accepted' : 'pending', supplyStatus: 'in_stock', vendorYard: 'TEST vendor yard',
    responseVendorId: 8899200, responseVendorName: 'TEST Review Vendor', availableDate: null,
    itemResolution: accepted ? { itemId: 2055, description: `TEST sales product ${index + 1}`, salesQuantity: 24, salesUom: 'PC' } : null }));
  const orderLines = lines.map(line => ({ caseLineId: line.id, itemId: 2055, description: line.itemResolution?.description || line.productName, quantity: 24, uom: 'PC', rate: 12, unitPurchaseCost: 4 }));
  return { id: 7100, requestRef: 'SPREQ-TEST-7100', revision: 7, stage: so ? 'confirmed' : accepted ? 'await_customer_confirmation' : 'new_enquiry',
    customerId: customer.id, customerName: customer.displayName, customerPhone: customer.phone,
    vendorId: 8899200, vendorName: 'TEST Review Vendor', storeLocationId: 1, storeName: '3445', inquiryDate: '2099-01-01', updatedAt: '2026-09-24T12:00:00Z',
    fulfillmentMethod: 'yard_pickup', operationalYardLocationId: 1, palletTotal: 0, palletRate: '',
    closeStatus: 'active', salesOrderId: so ? 9917100 : null, salesOrderRef: so ? 'TEST SO' : null,
    salesOrderApproved: so, salesOrderSkipped: false, purchaseOrderSkipped: false,
    salesOrderLines: accepted ? orderLines : [], purchaseOrderLines: accepted ? orderLines : [],
    lines, media: [], events: [], readinessAlerts: [] };
}
async function open(role, { detail = fixture(), enabled = false, response = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: storage[role] });
  const page = await context.newPage();
  if (process.env.SPECIAL_POLISH_BROWSER_MUTATION) {
    const [file, from, to] = JSON.parse(process.env.SPECIAL_POLISH_BROWSER_MUTATION);
    const source = await readFile(file, 'utf8');
    assert.equal(source.split(from).length, 2, 'Mutation target must be unique');
    await page.route(`**/${file.split('/').at(-1)}*`, route => route.fulfill({ contentType: 'text/javascript', body: source.replace(from, to) }));
  }
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let current = structuredClone(detail);
  const requests = [];
  await page.route(`**/api/${role}/special-stock-requests**`, async route => {
    const request = route.request(), url = new URL(request.url());
    const path = url.pathname.split('/special-stock-requests')[1];
    const method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();
    requests.push({ path, method, body });
    let payload, status = 200;
    if (path === '/policy') payload = { enabled: true, testSkipOrdersEnabled: enabled };
    else if (path === '/customers') { await new Promise(resolve => setTimeout(resolve, 150)); payload = { customers: [customer] }; }
    else if (path === '/vendors') payload = { vendors: [{ id: 8899200, name: 'TEST Review Vendor' }] };
    else if (method === 'GET' && !path) payload = { requests: [current], yards: [{ locationId: 1, yardCode: '3445' }] };
    else if (method === 'GET') payload = current;
    else {
      const custom = response ? await response({ path, method, body, current }) : null;
      if (custom) { payload = custom.payload; status = custom.status || 200; }
      else { current = { ...current, revision: current.revision + 1 }; payload = current; }
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.goto(`http://127.0.0.1:3000/${role}/stock-requests`);
  await page.locator(role === 'scm' ? '[data-stock-request-tab=special]' : '[data-sales-stock-action=special]').click();
  await page.locator('.stock-request-detail h2').filter({ hasText: detail.requestRef }).waitFor();
  return { page, context, requests, errors };
}
async function check(name, role, options, run) {
  if (process.env.SPECIAL_POLISH_BROWSER_FILTER && !new RegExp(process.env.SPECIAL_POLISH_BROWSER_FILTER).test(name)) return;
  const state = await open(role, options);
  try {
    await run(state);
    assert.deepEqual(state.errors, []);
    await state.page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    const overflow = await state.page.evaluate(() => ({ viewport: window.innerWidth, width: document.documentElement.scrollWidth,
      elements: [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > window.innerWidth + 2)
        .slice(0, 20).map(node => ({ tag: node.tagName, class: node.className, right: node.getBoundingClientRect().right, width: node.getBoundingClientRect().width })) }));
    await writeFile(`${output}/${name}-diagnostic.json`, JSON.stringify(overflow, null, 2));
    await state.page.screenshot({ path: `${output}/${name}-failed.png`, fullPage: true });
    results.push({ name, passed: false, error: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
  } finally { await state.context.close(); }
}
const saved = page => page.locator('.stock-request-notice').filter({ hasText: /Saved\.|draft saved|creation skipped/i }).first().waitFor();
const failed = page => page.locator('.stock-request-error').filter({ hasText: 'TEST rejected' }).waitFor();

try {
  for (const role of ['sales', 'scm']) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:3000/${role}/stock-requests`);
    await page.locator('[name=username]').fill(`review-${role}`);
    await page.locator('[name=password]').fill('SpecialReview-2026!'); // Disposable isolated review login.
    await page.locator('[data-form=dispatch-login] button[type=submit]').click();
    await page.locator(role === 'scm' ? '[data-stock-request-tab=special]' : '[data-sales-stock-action=special]').waitFor();
    storage[role] = await context.storageState();
    await context.close();
  }
  await check('delivery-fields', 'sales', {}, async ({ page }) => {
    await page.locator('[data-special-sales-action=new]').click();
    await page.locator('[data-special-initial-fulfillment]').selectOption('mbt_delivery');
    assert.equal(await page.locator('[name=deliveryContactName], [name=deliveryContactPhone]').count(), 0);
    assert.equal(await page.locator('[name=deliveryAddress]').getAttribute('required'), '');
    await page.setViewportSize({ width: 390, height: 844 });
    // Sidebar margin animates after a breakpoint change; inspect settled layout.
    await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth + 2, null, { timeout: 3000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), true);
  });
  await check('scm-fields-and-eta', 'scm', {}, async ({ page }) => {
    const form = page.locator('[data-special-response-form]').first();
    assert.equal(await form.locator('[name=vendorId]').isVisible(), false);
    assert.equal(await form.locator('[name=vendorReference], [name=unitPurchaseCost]').count(), 0);
    assert.equal(await form.locator('[name=availableDate]').isVisible(), false);
    await form.locator('[name=supplyStatus]').selectOption('production');
    assert.equal(await form.locator('[name=availableDate]').isVisible(), true);
    await form.locator('[name=availableDate]').fill('2099-03-01');
    await form.locator('[name=supplyStatus]').selectOption('no_stock');
    assert.equal(await form.locator('[name=availableDate]').isVisible(), false);
  });
  await check('three-column-layout', 'scm', {}, async ({ page }) => {
    const columns = await page.locator('[data-special-response-form] .stock-request-line-fields').first().evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length);
    assert.ok(columns <= 3, `Expected at most 3 columns, got ${columns}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth + 2, null, { timeout: 3000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), true);
  });
  for (const mobile of [false, true]) await check(`save-scroll-${mobile ? 'mobile' : 'desktop'}`, 'scm', {}, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const form = page.locator('[data-special-response-form]').nth(3);
    await form.locator('[name=salesVisibleNote]').fill('Keep this line in view');
    await form.locator('button[type=submit]').scrollIntoViewIfNeeded();
    const position = () => page.evaluate(mobile => mobile ? window.scrollY : document.querySelector('.stock-request-detail').scrollTop, mobile);
    const before = await position();
    assert.ok(before > 100);
    await form.locator('button[type=submit]').click();
    await saved(page);
    assert.ok(Math.abs(await position() - before) < 8, `Scroll moved from ${before} to ${await position()}`);
  });
  await check('scm-error-retains-all-lines', 'scm', { response: () => ({ status: 400, payload: { error: 'TEST rejected' } }) }, async ({ page }) => {
    const forms = page.locator('[data-special-response-form]');
    await forms.nth(1).locator('[name=scmInternalNote]').fill('Unsaved second line note');
    await forms.first().locator('[name=salesVisibleNote]').fill('Unsaved first line reply');
    await forms.first().locator('button[type=submit]').click();
    await failed(page);
    assert.equal(await forms.first().locator('[name=salesVisibleNote]').inputValue(), 'Unsaved first line reply');
    assert.equal(await forms.nth(1).locator('[name=scmInternalNote]').inputValue(), 'Unsaved second line note');
  });
  await check('scm-success-retains-other-line', 'scm', {}, async ({ page }) => {
    const forms = page.locator('[data-special-response-form]');
    await forms.nth(1).locator('[name=scmInternalNote]').fill('Keep unsaved second line');
    await forms.first().locator('button[type=submit]').click();
    await saved(page);
    assert.equal(await forms.nth(1).locator('[name=scmInternalNote]').inputValue(), 'Keep unsaved second line');
  });
  await check('single-customer-autocomplete', 'sales', { detail: fixture({ accepted: true, count: 1 }) }, async ({ page }) => {
    const form = page.locator('[data-special-so-form]');
    assert.equal(await form.locator('[name=customerId]').isVisible(), false);
    assert.equal(await form.getByLabel('NetSuite Customer', { exact: false }).count(), 1);
    const search = form.locator('[data-special-customer-search]');
    await search.fill('TEST Review');
    await page.locator('[data-special-sales-action=choose-customer]').first().waitFor();
    assert.equal(await search.evaluate(node => document.activeElement === node), true);
    assert.equal(await form.locator('[name=customerId]').inputValue(), '');
    await page.locator('[data-special-sales-action=choose-customer]').first().click();
    assert.equal(await form.locator('[name=customerId]').inputValue(), String(customer.id));
    await search.fill('Changed customer');
    assert.equal(await form.locator('[name=customerId]').inputValue(), '');
  });
  await check('so-conflict-retains-values', 'sales', { detail: fixture({ accepted: true, count: 1 }), response: () => ({ status: 409, payload: { error: 'TEST rejected', code: 'SPECIAL_REVISION_CONFLICT' } }) }, async ({ page }) => {
    const form = page.locator('[data-special-so-form]');
    await form.locator('[data-special-material] [name=quantity]').fill('222');
    await form.locator('[name=palletTotal]').fill('2');
    await form.locator('[name=palletRate]').fill('34');
    await form.locator('button[type=submit]').click();
    await failed(page);
    assert.equal(await form.locator('[data-special-material] [name=quantity]').inputValue(), '222');
    assert.equal(await form.locator('[name=palletTotal]').inputValue(), '2');
    assert.equal(await form.locator('[name=palletRate]').inputValue(), '34');
  });
  await check('gate-off-hides-buttons', 'sales', { detail: fixture({ accepted: true, count: 1 }) }, async ({ page }) => {
    assert.equal(await page.getByRole('button', { name: /Skip SO creation/i }).count(), 0);
  });
  await check('so-error-retains-quote-choice', 'sales', { detail: { ...fixture({ accepted: true, count: 1 }), estimateId: 991234 }, response: ({method}) => method === 'PUT' ? null : ({ status: 400, payload: { error: 'TEST rejected' } }) }, async ({ page }) => {
    await page.locator('[data-special-so-source]').selectOption('estimate_transform');
    await page.locator('[data-special-so-form] button[type=submit]').click(); await saved(page);
    await page.locator('[data-special-sales-action=create-so]').click();
    await failed(page);
    assert.equal(await page.locator('[data-special-so-source]').inputValue(), 'estimate_transform');
  });
  await check('gate-on-skip-so', 'sales', { detail: fixture({ accepted: true, count: 1 }), enabled: true,
    response: ({ current }) => ({ payload: { ...current, revision: 8, stage: 'confirmed', salesOrderSkipped: true, salesOrderApproved: true } }) }, async ({ page, requests }) => {
    await page.getByRole('button', { name: 'Skip SO creation', exact: true }).click({ timeout: 2000 });
    await page.locator('.stock-request-detail').getByText(/SO creation skipped/i).first().waitFor();
    assert.equal(requests.filter(row => row.method === 'POST').length, 1);
    assert.equal(requests.find(row => row.method === 'POST').path, '/7100/sales-order/skip');
    assert.equal(await page.locator('[data-special-sales-action=refresh-so]').count(), 0);
  });
  await check('gate-on-skip-po', 'scm', { detail: { ...fixture({ accepted: true, count: 1 }), salesOrderSkipped: true, salesOrderApproved: true, stage: 'confirmed' }, enabled: true,
    response: ({ current }) => ({ payload: { ...current, revision: 8, stage: 'dispatch_arrangement', purchaseOrderSkipped: true } }) }, async ({ page, requests }) => {
    await page.getByRole('button', { name: 'Skip PO Creation', exact: true }).click({ timeout: 2000 });
    await page.locator('.stock-request-detail').getByText(/PO creation skipped/i).first().waitFor();
    assert.equal(requests.filter(row => row.method === 'POST').length, 1);
    assert.equal(requests.find(row => row.method === 'POST').path, '/7100/purchase-order/skip');
    assert.equal(requests.find(row => row.method === 'POST').body.lines[0].unitPurchaseCost, '4');
  });
} finally {
  await browser.close();
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
