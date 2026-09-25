import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const output = process.env.SPECIAL_POLISH_BROWSER_OUTPUT || process.env.SPECIAL_ENQUIRY_BROWSER_OUTPUT || 'test-artifacts/special-workflow-enquiry/browser';
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
  if (process.env.SPECIAL_BUTTON_COVERAGE_DIR) await page.coverage.startJSCoverage();
  if (process.env.SPECIAL_POLISH_BROWSER_MUTATION) {
    const [file, from, to] = JSON.parse(process.env.SPECIAL_POLISH_BROWSER_MUTATION);
    const source = await readFile(file, 'utf8');
    assert.equal(source.split(from).length, 2, 'Mutation target must be unique');
    await page.route(`**/${file.split('/').at(-1)}*`, route => route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: source.replace(from, to) }));
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
  } finally {
    if (process.env.SPECIAL_BUTTON_COVERAGE_DIR) {
      await mkdir(process.env.SPECIAL_BUTTON_COVERAGE_DIR, {recursive:true});
      const entries=(await state.page.coverage.stopJSCoverage()).filter(entry=>entry.url.includes('/sales-special-stock-requests.js'));
      await writeFile(`${process.env.SPECIAL_BUTTON_COVERAGE_DIR}/${name}.json`,JSON.stringify(entries));
    }
    await state.context.close();
  }
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

  await check('initial-fields-and-decision', 'sales', {detail:fixture({count:1})}, async({page})=>{
    assert.equal(await page.locator('[data-special-decision-form] option[value=request_update]').count(),0);
    await page.locator('[data-special-sales-action=new]').click();
    assert.equal(await page.locator('[data-special-composer-line] [name=brand]').count(),0);
    assert.doesNotMatch(await page.locator('[data-special-case-form]').textContent(),/three working days from today/i);
    assert.match(await page.locator('[data-special-case-form]').textContent(),/three working days after SO placement/i);
    const today=await page.evaluate(()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
    assert.equal(await page.locator('[name=requiredDate]').getAttribute('min'),today);
  });
  await check('fixed-unit-default', 'sales', {detail:{...fixture({accepted:true,count:1}),lines:fixture({accepted:true,count:1}).lines.map(line=>({...line,conversionToPc:null}))}},async({page,requests})=>{
    assert.equal(await page.locator('[name=conversionToPc]').count(),0);
    await page.locator('[data-special-so-form] button[type=submit]').click();await saved(page);
    const line=requests.find(row=>row.method==='PUT').body.materialLines[0];
    assert.equal(Number(line.conversionToPc),1);assert.equal(line.quantity,2);assert.equal(Number(line.rate),120);
  });
  await check('existing-conversion-retained', 'sales', {detail:fixture({accepted:true,count:1})},async({page,requests})=>{
    assert.equal(await page.locator('[name=conversionToPc]').count(),0);
    await page.locator('[data-special-so-form] button[type=submit]').click();await saved(page);
    const line=requests.find(row=>row.method==='PUT').body.materialLines[0];assert.equal(Number(line.conversionToPc),12);assert.equal(line.quantity,24);
  });
  async function disabled(page,expected=true){
    for(const selector of ['create-so','skip-so'])assert.equal(await page.locator(`[data-special-sales-action=${selector}]`).isDisabled(),expected);
  }
  for(const [name,edit] of [
    ['quantity',async page=>page.locator('[data-special-material] [name=quantity]').fill('3')],
    ['discount',async page=>page.locator('[data-special-material] [name=discountPercent]').fill('25')],
    ['selector-change',async page=>page.locator('[name=operationalYardLocationId]').dispatchEvent('change')],
    ['ancillary-add',async page=>page.locator('[data-special-sales-action=add-ancillary]').click()],
    ['ancillary-remove',async page=>page.locator('[data-special-sales-action=remove-ancillary]').click()],
    ['quote-source',async page=>page.locator('[data-special-so-source]').selectOption('estimate_transform')]
  ]) await check(`dirty-${name}`, 'sales', {enabled:true,detail:{...fixture({accepted:true,count:1}),estimateId:42,salesOrderLines:[...fixture({accepted:true,count:1}).salesOrderLines,{ancillary:true,itemId:1900,description:'TEST fee',quantity:1,uom:'EACH',rate:5}]}},async({page})=>{
    await disabled(page,false);await edit(page);await disabled(page);
    if(name==='quote-source'){
      await page.locator('[data-special-so-form] button[type=submit]').click();await saved(page);await disabled(page,false);
      assert.equal(await page.locator('[data-special-so-source]').inputValue(),'estimate_transform');
    }
  });
  await check('dirty-action-dispatch','sales',{enabled:true,detail:fixture({accepted:true,count:1})},async({page,requests})=>{
    await page.locator('[data-special-material] [name=discountPercent]').fill('25');
    await page.locator('[data-special-sales-action=create-so]').dispatchEvent('click');
    await page.waitForTimeout(100);
    assert.equal(requests.filter(row=>row.path.endsWith('/sales-order/create')).length,0);
  });
  await check('failed-save-retains-lock','sales',{enabled:true,detail:fixture({accepted:true,count:1}),response:()=>({status:409,payload:{error:'TEST rejected'}})},async({page})=>{
    await page.locator('[data-special-material] [name=discountPercent]').fill('25');
    await page.locator('[data-special-so-form] button[type=submit]').click();await failed(page);await disabled(page);
    assert.equal(await page.locator('[name=discountPercent]').inputValue(),'25');
  });

  function pendingReview(detail) {
    Object.assign(detail, { quantityReviewPending: true, quantityReview: { mode: 'draft', status: 'pending',
      lines: [{ caseLineId: detail.lines[0].id, productName: detail.lines[0].productName,
        fromPackageQuantity: 500, toPackageQuantity: 50, packageUom: 'PLT', fromQuantity: 500, toQuantity: 50, salesUom: 'PC' }] } });
    return detail;
  }
  async function visiblyBlocked(page, reason) {
    await page.locator('[data-special-sales-action=create-so]').scrollIntoViewIfNeeded();
    await disabled(page);
    const styles = await page.locator('[data-special-sales-action=create-so], [data-special-sales-action=skip-so]').evaluateAll(buttons => buttons.map(button => {
      const style = getComputedStyle(button);
      return { disabled: button.disabled, cursor: style.cursor, background: style.backgroundColor, color: style.color };
    }));
    await writeFile(`${output}/disabled-styles.json`, JSON.stringify(styles, null, 2));
    for (const style of styles) {
      assert.equal(style.cursor, 'not-allowed');
      assert.equal(style.background, 'rgb(229, 231, 235)');
    }
    const message = page.locator('[data-special-so-action-status]');
    assert.equal(await message.isVisible(), true);
    assert.match(await message.textContent(), reason);
  }
  await check('pending-review-visible-lock','sales',{enabled:true,detail:pendingReview({ ...fixture({accepted:true,count:1}),
    requestRef:'SPREQ-000005', revision:7, palletTotal:40, palletRate:40,
    lines:fixture({accepted:true,count:1}).lines.map(line=>({...line,quantity:500,packageQuantity:50,reviewedPackageQuantity:500,conversionToPc:1,originalRate:5,discountPercent:0}))
  })},async({page,requests})=>{
    await visiblyBlocked(page,/SCM.*confirm/i);
    for (const action of ['create-so','skip-so']) await page.locator(`[data-special-sales-action=${action}]`).dispatchEvent('click');
    assert.equal(requests.filter(row=>/\/sales-order\/(create|skip)$/.test(row.path)).length,0);
  });
  let approved=false;
  await check('quantity-lock-lifecycle','sales',{enabled:true,detail:fixture({accepted:true,count:1}),response:({current})=>{
    current.lines[0].packageQuantity=50;
    pendingReview(current);
    if(approved) { current.quantityReviewPending=false; current.quantityReview.status='confirmed'; }
    return {payload:current};
  }},async({page})=>{
    await disabled(page,false);
    await page.locator('[data-special-material] [name=quantity]').fill('50');
    await visiblyBlocked(page,/save.*draft/i);
    await page.locator('[data-special-so-form] button[type=submit]').click();await saved(page);
    await visiblyBlocked(page,/SCM.*confirm/i);
    await Promise.all([page.waitForResponse(response=>/special-stock-requests\/7100$/.test(response.url())),page.locator('[data-special-sales-action=refresh]').click()]);
    await visiblyBlocked(page,/SCM.*confirm/i);
    approved=true;
    await Promise.all([page.waitForResponse(response=>response.request().method()==='PUT'),page.locator('[data-special-so-form] button[type=submit]').click()]);
    await page.waitForFunction(()=>!document.querySelector('[data-special-sales-action=create-so]').disabled);
    await disabled(page,false);
    assert.equal(await page.locator('[data-special-so-action-status]').isVisible(),false);
  });
  await check('media-retains-quantity-lock','sales',{enabled:true,detail:{...fixture({accepted:true,count:1}),fulfillmentMethod:'mbt_delivery'},response:({path,current})=>{
    if(path.endsWith('/media-ticket')) return {payload:{id:'test-media',upload:{uploadUrl:'http://127.0.0.1:3000/test-media-upload',token:'test-only'}}};
    if(path.endsWith('/media')) { current.media=[{id:'test-media',status:'staged',mimeType:'image/png',byteSize:100}]; return {payload:current}; }
  }},async({page})=>{
    await page.route('**/test-media-upload',route=>route.fulfill({json:{key:'test-image.png'}}));
    await page.locator('[data-special-material] [name=quantity]').fill('50');
    // Opening the file picker blurs quantity before uploading. Commit that
    // change event so a later rerender cannot accidentally re-mark a lost edit.
    await page.locator('[data-special-material] [name=quantity]').press('Tab');
    await page.locator('[data-special-media]').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')});
    await page.locator('.stock-request-notice').filter({hasText:'Delivery media staged.'}).waitFor();
    assert.equal(await page.locator('[data-special-material] [name=quantity]').inputValue(),'50');
    await visiblyBlocked(page,/save.*draft/i);
  });
  await check('so-material-five-column-row','sales',{detail:fixture({accepted:true,count:1})},async({page})=>{
    const fields=page.locator('[data-special-material] [name=quantity], [data-special-material] [name=uom], [data-special-material] [name=rate], [data-special-material] [name=discountPercent], [data-special-material] [data-special-subtotal]');
    const boxes=await fields.evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width};}));
    assert.equal(boxes.length,5);
    assert.ok(boxes.every(box=>Math.abs(box.y-boxes[0].y)<1),JSON.stringify(boxes));
    assert.ok(boxes.every((box,i)=>!i || box.x>boxes[i-1].x));
    assert.equal(await page.locator('[data-special-material] [name=rate]').getAttribute('readonly'),'');
    await page.locator('[data-special-material]').scrollIntoViewIfNeeded();
    await page.screenshot({path:`${output}/so-material-five-column-desktop.png`,fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.waitForFunction(()=>document.documentElement.scrollWidth<=window.innerWidth);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    const narrow=await fields.evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().width));
    assert.ok(narrow.every(width=>width>100));
  });
  for (const action of ['create-so','skip-so']) await check(`saved-draft-allows-${action}`,'sales',{enabled:true,detail:fixture({accepted:true,count:1})},async({page,requests})=>{
    await disabled(page,false);
    await Promise.all([page.waitForResponse(response=>/\/sales-order\/(create|skip)$/.test(new URL(response.url()).pathname)),page.locator(`[data-special-sales-action=${action}]`).click()]);
    assert.equal(requests.filter(row=>/\/sales-order\/(create|skip)$/.test(row.path)).length,1);
  });

} finally {
  await browser.close(); await writeFile(`${output}/results.json`,JSON.stringify(results,null,2));
}
if(results.some(result=>!result.passed))process.exitCode=1;
