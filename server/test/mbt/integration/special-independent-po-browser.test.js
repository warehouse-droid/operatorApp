/* global document, localStorage */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

let browser;
let capture = 0;
const out = 'test-artifacts/special-independent-po/browser';
before(async () => { await mkdir(out, { recursive: true }); browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], env:{...process.env,XDG_CONFIG_HOME:'/tmp/independent-po-chromium-config',XDG_CACHE_HOME:'/tmp/independent-po-chromium-cache'} }); });
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
      if (/\/items\/\d+\/units$/.test(path)) return route.fulfill({json:path.includes('/9001/') ? {units:[],noUnits:true,defaultUnitId:null} : {units:[{id:1,name:'PC',aliases:['PC','PCS']},{id:2,name:'PLT',aliases:['PLT']}],noUnits:false,defaultUnitId:1}});
      if (path.endsWith('/items')) return route.fulfill({json:{items:[{itemId:9001,itemName:'TEST Delivery Fee',description:'Delivery fee',stockUnit:''}]}});
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

for (const width of [1440,390]) test(`SCM independently edits quantities, selects NetSuite UOM and adds a fee at ${width}px`,async()=>{
  const {page,context,state}=await fixture('scm',width,d=>{
    d.salesOrderId=10;d.salesOrderApproved=true;d.salesOrderSource='standalone';d.palletTotal=0;
    d.lines=d.lines.slice(0,1);d.lines[0].salesDecision='accepted';
    d.purchaseOrderLines=[{caseLineId:1,itemId:2055,description:'Customer material',quantity:24,uom:'PC',unitPurchaseCost:10,palletQty:1}];
  });
  try {
    const form=page.locator('[data-special-po-form]'),material=form.locator('[data-special-po-line="1"]');
    await expect(material.locator('input[name=uom]')).toHaveCount(0);
    await expect(material.locator('select[name=uom] option')).toHaveCount(3);
    await material.locator('[name=uom]').selectOption('PLT');
    await material.locator('[name=quantity]').fill('2');await material.locator('[name=description]').fill('Vendor material');
    for(const [field,value] of Object.entries({palletQty:'2',sectionQty:'3',layerQty:'4',pieceQty:'30',vendorDiscountPercent:'10'}))await material.locator(`[name=${field}]`).fill(value);
    await form.getByRole('button',{name:'Add Item',exact:true}).click();
    let extra=form.locator('[data-special-po-extra]').first();
    await extra.getByLabel('Search NetSuite item').fill('Delivery');
    await extra.getByRole('button',{name:'TEST Delivery Fee'}).click();
    await expect(extra.locator('[name=uom]')).toContainText('No unit');
    await extra.locator('[name=unitPurchaseCost]').fill('25');
    await expect(form.locator('[data-special-purchase-totals]')).toContainText('43.00');
    await form.getByRole('button',{name:'Add Item',exact:true}).click();
    await form.locator('[data-special-po-extra]').last().getByRole('button',{name:'Remove item'}).click();
    await expect(form.locator('[data-special-po-extra]')).toHaveCount(1);
    state.fail=true;await form.getByRole('button',{name:'Create PO in NetSuite'}).click();
    await expect(page.locator('.stock-request-feedback')).toContainText('Review changed');
    extra=form.locator('[data-special-po-extra]').first();
    await expect(extra.locator('[name=unitPurchaseCost]')).toHaveValue('25');
    await expect(material.locator('[name=uom]')).toHaveValue('PLT');
    await expect(material.locator('[name=pieceQty]')).toHaveValue('30');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
    await page.screenshot({path:`${out}/editor-${width}.png`,fullPage:true});
    state.fail=false;await form.getByRole('button',{name:'Create PO in NetSuite'}).click();
    await expect.poll(()=>state.posts.length).toBe(2);
    const body=state.posts.at(-1).body;
    assert.equal(body.lines[0].uom,'PLT');assert.equal(Number(body.lines[0].unitId),2);
    assert.equal(body.lines[0].pieceQty,'30');assert.equal(body.extraLines.length,1);
    assert.equal(Number(body.extraLines[0].itemId),9001);assert.equal(body.extraLines[0].uom,'');
    assert.equal(body.extraLines[0].unitPurchaseCost,'25');assert.deepEqual(state.errors,[]);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
    await page.screenshot({path:`${out}/independent-${width}.png`,fullPage:true});
  } finally {await context.close();}
});


