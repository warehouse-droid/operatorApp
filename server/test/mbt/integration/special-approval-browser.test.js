/* global document, localStorage */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

let browser;
let capture = 0;
const out = process.env.SPECIAL_BROWSER_ARTIFACTS || 'test-artifacts/special-workflow-review/po-approval-reference-20260928';
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
        if (path.endsWith('/quantity-change')) {
          record.quantityReviewPending=true;
          record.quantityReview={id:'local-review',mode:'issued',status:'pending',localOnly:true,
            lines:body.lines.filter(line=>line.remove).map(line=>({...line,productName:record.lines.find(item=>item.id===line.caseLineId)?.productName}))};
        }
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


test('SCM sees delivery method and PO vendor pricing shares a desktop row',async()=>{
 const {page,context}=await fixture('scm',1600,d=>{d.salesOrderId=10;d.salesOrderApproved=true;d.fulfillmentMethod='mbt_delivery';d.deliveryAddress='TEST delivery';d.purchaseOrderLines=[{caseLineId:1,description:'TEST material',quantity:2,uom:'PC',unitPurchaseCost:3}];});
 try{
 await expect(page.locator('.stock-request-summary')).toContainText('Delivery method');await expect(page.locator('.stock-request-summary')).toContainText('Delivery');
 const positions=await page.locator('[data-special-po-line] input').evaluateAll(nodes=>Object.fromEntries(nodes.map(n=>[n.name,n.getBoundingClientRect().y])));
 assert.equal(positions.quantity,positions.vendorDiscountPercent);assert.equal(positions.unitPurchaseCost,positions.vendorDiscountPercent);
 }finally{await context.close();}
});
test('Confirmed request preserves SCM readiness instructions for an accepted production ETA', async () => {
 const {page,context,state}=await fixture('scm',1440,d=>{d.salesOrderId=10;d.purchaseOrderId=20;d.purchaseOrderApproved=true;d.stage='confirmed';d.lines[0].salesDecision='accepted';d.lines[0].supplyStatus='production';d.lines[0].availableDate='2099-02-01';});
 try{
 await expect(page.locator('.stock-request-heading')).toContainText('Confirmed');
 await expect(page.locator('.stock-request-detail')).toContainText('Waiting for SCM readiness confirmation');
 await expect(page.locator('[data-special-stock-line][data-kind="readiness"]')).toBeVisible();
 assert.deepEqual(state.errors,[]);
 }finally{await context.close();}
});
test('Sales local adjustment removal preserves the selection after a failed save and submits only that removal', async () => {
 const {page,context,state}=await fixture('sales',390,d=>{d.salesOrderId=10;d.stage='confirmed';
  d.lines.forEach(l=>Object.assign(l,{salesDecision:'accepted',originalRate:10,packageQuantity:2,discountPercent:0,conversionToPc:1,rateUom:'PCS',requiredDate:'2099-02-01'}));});
 try{
 const section=page.locator('[data-special-adjustment-section]'),form=page.locator('[data-special-quantity-form]');
 await expect(form).toHaveCount(0);await expect(section).toContainText('local request');
 await section.getByRole('button',{name:'Edit',exact:true}).click();await expect(form).toBeVisible();
 await form.locator('[name=quantity]').first().fill('99');
 await form.getByRole('button',{name:'Cancel',exact:true}).click();await expect(form).toHaveCount(0);assert.equal(state.posts.length,0);
 await section.getByRole('button',{name:'Edit',exact:true}).click();await expect(form.locator('[name=quantity]').first()).toHaveValue('2');
 const removed=form.locator('[data-special-material="2"]');await removed.getByLabel('Remove item').check();
 await expect(removed.locator('[name=quantity]')).toBeDisabled();
 state.fail=true;await form.getByRole('button',{name:'Request adjustment',exact:true}).click();
 await expect(removed.getByLabel('Remove item')).toBeChecked();await expect(removed.locator('[name=quantity]')).toBeDisabled();
 state.fail=false;await form.getByRole('button',{name:'Request adjustment',exact:true}).click();
 assert.equal(state.posts.at(-1).path,'/api/sales/special-stock-requests/1/quantity-change');
 assert.deepEqual(state.posts.at(-1).body.lines.find(l=>l.caseLineId===2),{caseLineId:2,remove:true});
 assert.equal(state.posts.at(-1).body.lines.find(l=>l.caseLineId===1).quantity,'2');
 await expect(page.getByText('Remove item: TEST product 2',{exact:true})).toBeVisible();
 await expect(form).toHaveCount(0);await expect(section.getByRole('button',{name:'Edit',exact:true})).toBeVisible();
 assert.deepEqual(state.errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 await page.screenshot({path:`${out}/sales-local-removal-mobile.png`,fullPage:true});
 }finally{await context.close();}
});
test('SCM removal review explains the local effect and identifies the removed material',async()=>{
 const {page,context}=await fixture('scm',1440,d=>{d.salesOrderId=10;d.stage='confirmed';d.quantityReviewPending=true;
  d.quantityReview={id:'remove-review',mode:'issued',status:'pending',localOnly:true,lines:[{caseLineId:2,productName:'TEST product 2',remove:true}]};});
 try{
 const form=page.locator('[data-special-quantity-review-form]');await expect(form).toContainText('local request');
 await expect(form).toContainText('Remove item');await expect(form).toContainText('TEST product 2');
 await expect(form.getByRole('button',{name:'Confirm adjustment'})).toBeVisible();
 }finally{await context.close();}
});
test('approved PO exposes shared reference form and preserves failed edits',async()=>{
 const {page,context,state}=await fixture('scm',1440,d=>{d.salesOrderId=10;d.purchaseOrderId=20;d.purchaseOrderApproved=true;d.purchaseOrderRef='PO-NATIVE';d.purchaseOrderReference='VENDOR';});
 try{const form=page.locator('[data-special-po-reference-form]');await expect(form).toBeVisible();await form.locator('[name=reference]').fill('NEW-REF');state.fail=true;await form.getByRole('button').click();await expect(form.locator('[name=reference]')).toHaveValue('NEW-REF');state.fail=false;await form.getByRole('button').click();assert.equal(state.posts.at(-1).body.previousReference,'VENDOR');assert.equal(state.posts.at(-1).body.reference,'NEW-REF');}
 finally{await context.close();}
});
test('Sales delivery editor remains available after SO and PO creation',async()=>{
 const {page,context,state}=await fixture('sales',1440,d=>{d.salesOrderId=10;d.purchaseOrderId=20;d.purchaseOrderApproved=true;d.stage='dispatch_arrangement';});
 try{const form=page.locator('[data-special-fulfillment-form]');await expect(form).toBeVisible();await form.locator('[name=fulfillmentMethod]').selectOption('vendor_pickup');await form.getByRole('button',{name:'Save',exact:true}).click();assert.equal(state.posts.at(-1).path,'/api/sales/special-stock-requests/1/fulfillment');assert.equal(state.posts.at(-1).body.fulfillmentMethod,'vendor_pickup');}
 finally{await context.close();}
});

test('mobile Sales delivery form preserves contact details across method toggles and failed saves',async()=>{
 const {page,context,state}=await fixture('sales',390,d=>{d.salesOrderId=10;d.purchaseOrderId=20;d.fulfillmentMethod='mbt_delivery';d.deliveryAddress='TEST site';d.deliveryContactName='TEST contact';d.stage='confirmed';d.purchaseOrderApproved=false;d.purchaseOrderPendingApproval=true;});
 try{
 const form=page.locator('[data-special-fulfillment-form]');await expect(page.locator('.stock-request-detail')).toContainText('PO approval pending');
 await form.locator('[name=deliveryContactPhone]').fill('555-0100');await form.locator('[name=fulfillmentMethod]').selectOption('vendor_pickup');await expect(form.locator('[name=deliveryAddress]')).toBeHidden();
 await form.locator('[name=fulfillmentMethod]').selectOption('mbt_delivery');await expect(form.locator('[name=deliveryContactPhone]')).toHaveValue('555-0100');
 state.fail=true;await form.getByRole('button',{name:'Save',exact:true}).click();await expect(form.locator('[name=deliveryContactPhone]')).toHaveValue('555-0100');
 state.fail=false;await form.getByRole('button',{name:'Save',exact:true}).click();assert.equal(state.posts.at(-1).body.deliveryContactPhone,'555-0100');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);assert.deepEqual(state.errors,[]);
 await page.screenshot({path:`${out}/sales-delivery-mobile.png`,fullPage:true});
 }finally{await context.close();}
});
test('planned Sales order hides delivery editor; SCM pending PO hides reference editor and escapes delivery text',async()=>{
 const sales=await fixture('sales',1440,d=>{d.salesOrderId=10;d.dispatchPlanning={anyPlanned:true,salesOrder:{planned:true}};});
 try{await expect(sales.page.locator('[data-special-fulfillment-form]')).toHaveCount(0);}finally{await sales.context.close();}
 const scm=await fixture('scm',390,d=>{d.salesOrderId=10;d.purchaseOrderId=20;d.purchaseOrderApproved=false;d.purchaseOrderPendingApproval=true;d.fulfillmentMethod='mbt_delivery';d.deliveryAddress='<img src=x onerror=alert(1)>';});
 try{await expect(scm.page.locator('[data-special-po-reference-form]')).toHaveCount(0);await expect(scm.page.locator('.stock-request-detail')).toContainText('PO approval pending');await expect(scm.page.locator('.stock-request-detail img')).toHaveCount(0);assert.equal(await scm.page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);}
 finally{await scm.context.close();}
});

test('failed delivery recovery keeps header editable and saves the edited target explicitly', async () => {
 const {page,context,state}=await fixture('sales',390,d=>{d.salesOrderId=10;d.stage='confirmed';
  d.fulfillmentChange={id:'failed-delivery',status:'attention',hasPlan:false,error:'Preparation unavailable',
   target:{fulfillmentMethod:'mbt_delivery',deliveryAddress:'Old site'}};});
 try {
  const form=page.locator('[data-special-fulfillment-form]');
  await expect(form.locator('[name=fulfillmentMethod]')).toBeEnabled();
  await expect(form.locator('[name=deliveryAddress]')).toBeEnabled();
  await form.locator('[name=deliveryAddress]').fill('Replacement site');
  await form.getByRole('button',{name:'Save',exact:true}).click();
  assert.equal(state.posts.at(-1).path,'/api/sales/special-stock-requests/1/fulfillment');
  assert.equal(state.posts.at(-1).body.replaceChangeId,'failed-delivery');
  assert.equal(state.posts.at(-1).body.changeId,undefined);
  assert.equal(state.posts.at(-1).body.deliveryAddress,'Replacement site');
  assert.deepEqual(state.errors,[]);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  await page.screenshot({path:`out-placeholder/delivery-recovery-mobile.png`.replace('out-placeholder',out),fullPage:true});
 } finally { await context.close(); }
});
test('delivery recovery distinguishes retry from discard and hides discard after a saved remote plan', async () => {
 for (const hasPlan of [false,true]) {
  const {page,context,state}=await fixture('sales',1440,d=>{d.salesOrderId=10;d.stage='confirmed';
   d.fulfillmentChange={id:'failed-delivery',status:hasPlan?'attention':'failed',hasPlan,error:'Remote check failed',
    target:{fulfillmentMethod:'mbt_delivery',deliveryAddress:'Saved site'}};});
  try {
   const form=page.locator('[data-special-fulfillment-form]');
   await expect(form.locator('[name=deliveryAddress]')).toBeEnabled();
   await form.locator('[name=deliveryAddress]').fill('Unsaved site');
   await page.locator('[data-special-sales-action=retry-delivery]').click();
   assert.deepEqual(state.posts.at(-1).body,{expectedRevision:1,changeId:'failed-delivery'});
   const discard=page.locator('[data-special-sales-action=discard-delivery]');
   if(hasPlan) await expect(discard).toHaveCount(0);
   else {
    await discard.click();
    assert.deepEqual(state.posts.at(-1).body,{expectedRevision:2,changeId:'failed-delivery',action:'discard'});
   }
   assert.deepEqual(state.errors,[]);
  } finally { await context.close(); }
 }
});
