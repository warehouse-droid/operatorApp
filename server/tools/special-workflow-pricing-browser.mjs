import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const output = process.env.SPECIAL_POLISH_BROWSER_OUTPUT || 'test-artifacts/special-workflow-pricing/browser';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const results = [], storage = {};
const customer = { id: 8899100, entityNumber: 'TEST-REVIEW', displayName: 'TEST Review Customer', phone: '416-555-0100' };
function fixture({ accepted = false, so = false, count = 6 } = {}) {
  const lines = Array.from({ length: count }, (_, index) => ({ id: 7101 + index, productName: `TEST product ${index + 1}`, quantity: 2, uom: 'PLT', originalRate: 120, rateUom: 'PLT', pricingSource: 'enquiry', discountPercent: 10, packageQuantity: 2, conversionToPc: 12, subtotal: 216,
    salesDecision: accepted ? 'accepted' : 'pending', supplyStatus: 'in_stock', vendorYard: 'TEST vendor yard',
    responseVendorId: 8899200, responseVendorName: 'TEST Review Vendor', availableDate: null,
    itemResolution: accepted ? { itemId: 2055, description: `TEST sales product ${index + 1}`, salesQuantity: 24, salesUom: 'PC' } : null }));
  const orderLines = lines.map(line => ({ caseLineId: line.id, itemId: 2055, description: line.itemResolution?.description || line.productName, quantity: 24, uom: 'PC', rate: 9, unitPurchaseCost: 4 }));
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
  const page = await context.newPage(); page.setDefaultTimeout(5000);
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
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    await page.goto(`http://127.0.0.1:3000/${role}/stock-requests`);
    await page.locator('[name=username]').fill(`review-${role}`);
    await page.locator('[name=password]').fill('SpecialReview-2026!'); // Disposable isolated review login.
    await page.locator('[data-form=dispatch-login] button[type=submit]').click();
    await page.locator(role === 'scm' ? '[data-stock-request-tab=special]' : '[data-sales-stock-action=special]').waitFor();
    storage[role] = await context.storageState();
    await context.close();
  }

  await check('initial-line-pricing', 'sales', {}, async ({page}) => {
    await page.locator('[data-special-sales-action=new]').click();
    const first=page.locator('[data-special-composer-line]').first();
    assert.equal(await first.locator('[name=rate]').getAttribute('required'),'');
    await first.locator('[name=quantity]').fill('2'); await first.locator('[name=rate]').fill('120');
    await first.locator('[name=discountPercent]').fill('10');
    assert.match(await first.locator('[data-special-subtotal]').textContent(),/216\.00/);
    await page.locator('[data-special-sales-action=add-case-line]').click();
    const second=page.locator('[data-special-composer-line]').nth(1);
    await second.locator('[name=quantity]').fill('3');await second.locator('[name=rate]').fill('20');await second.locator('[name=discountPercent]').fill('25');
    assert.match(await second.locator('[data-special-subtotal]').textContent(),/45\.00/);
    assert.match(await first.locator('[data-special-subtotal]').textContent(),/216\.00/);
    await page.setViewportSize({width:390,height:844});
    await page.waitForFunction(()=>document.documentElement.scrollWidth<=window.innerWidth+2);
  });
  await check('so-pricing-retained', 'sales', { detail:fixture({accepted:true,count:1}), response:()=>({status:409,payload:{error:'TEST rejected'}}) }, async ({page,requests}) => {
    const line=page.locator('[data-special-material]').first();
    assert.equal(await line.locator('[name=quantity]').inputValue(),'2');
    assert.equal(await line.locator('[name=uom]').inputValue(),'PLT');
    assert.equal(await line.locator('[name=rate]').inputValue(),'120');
    assert.equal(await line.locator('[name=rate]').getAttribute('readonly'),'');
    assert.equal(await line.locator('[name=discountPercent]').inputValue(),'10');
    await line.locator('[name=quantity]').fill('3');await line.locator('[name=discountPercent]').fill('25');
    assert.match(await line.locator('[data-special-subtotal]').textContent(),/270\.00/);
    await page.locator('[data-special-so-form] button[type=submit]').click();await failed(page);
    const body=requests.find(request=>request.method==='PUT').body.materialLines[0];
    assert.equal(body.quantity,36);assert.equal(body.uom,'PC');assert.equal(Number(body.packageQuantity),3);assert.equal(Number(body.rate),120);assert.equal(Number(body.discountPercent),25);
    assert.equal(await line.locator('[name=quantity]').inputValue(),'3');assert.equal(await line.locator('[name=discountPercent]').inputValue(),'25');
  });
  await check('so-delivery-minimum', 'sales', {detail:fixture({accepted:true,count:1})}, async({page})=>{
    await page.locator('[data-special-fulfillment]').selectOption('mbt_delivery');
    const min=await page.locator('[name=deliveryDate]').getAttribute('min');assert.match(min,/^\d{4}-\d{2}-\d{2}$/);
    await page.locator('[name=deliveryDate]').fill('2000-01-01');
    assert.equal(await page.locator('[name=deliveryDate]').evaluate(node=>node.validity.rangeUnderflow),true);
  });
  const pending={...fixture({accepted:true,so:true,count:1}),quantityReviewPending:true,quantityReview:{id:'test-review',status:'pending',mode:'issued',lines:[{caseLineId:7101,productName:'TEST product',packageUom:'PLT',fromPackageQuantity:2,toPackageQuantity:3,fromQuantity:24,toQuantity:36,fromPurchaseQuantity:24,toPurchaseQuantity:36,salesUom:'PC',purchaseUom:'PC'}]}};
  await check('scm-quantity-review', 'scm', {detail:pending, response:({current})=>({payload:{...current,quantityReviewPending:false,quantityReview:{...current.quantityReview,status:'approved'}}})}, async({page,requests})=>{
    assert.match(await page.locator('.stock-request-card').textContent(),/Quantity changed/);
    assert.equal(await page.locator('[data-special-po-form]').count(),0);
    const form=page.locator('[data-special-quantity-review-form]');
    assert.match(await form.textContent(),/24.*36/s);
    await form.getByRole('button',{name:'Confirm quantity change',exact:true}).click();await saved(page);
    const request=requests.find(row=>row.method==='POST');assert.equal(request.path,'/7100/quantity-review');assert.equal(request.body.reviewId,'test-review');assert.equal(request.body.decision,'approve');
  });
  await check('sales-issued-quantity-proposal', 'sales', {detail:fixture({accepted:true,so:true,count:1}),response:()=>({status:400,payload:{error:'TEST rejected'}})}, async({page,requests})=>{
    const form=page.locator('[data-special-quantity-form]');await form.locator('[name=quantity]').fill('4');
    await form.getByRole('button',{name:'Request quantity change'}).click();await failed(page);
    const request=requests.find(row=>row.method==='POST');assert.equal(request.path,'/7100/quantity-change');
    assert.deepEqual(request.body.lines,[{caseLineId:7101,quantity:'4'}]);assert.equal(await form.locator('[name=quantity]').inputValue(),'4');
  });
} finally {
  await browser.close(); await writeFile(`${output}/results.json`,JSON.stringify(results,null,2));
}
if(results.some(result=>!result.passed))process.exitCode=1;
