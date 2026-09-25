/* global localStorage */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {app} from '../src/server.js';
import {query,closeDb} from '../src/db.js';
import {createOperator,loginOperator} from '../src/auth-repository.js';
import {createCountSheet} from '../src/count-sheet-repository.js';
let server,base,browser,op,manager;
const coverage=[];
const sku={item_id:980400,item_name:'Browser Paver',item_description:'40 pieces per pallet',item_type:'InvtPart',location_id:1,stock_unit:'PCS',sales_unit:'PCS',sales_unit_id:191,to_plt:40,to_pcs:1};
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  for(const role of ['operator','yard_manager']) {
    const username=`inventory-browser-${crypto.randomUUID()}`,password=crypto.randomUUID();
    const actor=await createOperator({username,password,displayName:role,role,operatorYardLocationIds:[1],yardLocationIds:[1]});
    const session={actor,...await loginOperator(username,password)};if(role==='operator')op=session;else manager=session;
  }
  await query("INSERT INTO inventory_items(item_id,item_name,item_description,item_type,stock_unit,to_plt,to_pcs) VALUES(980400,'Browser Paver','40 pieces per pallet','InvtPart','PCS',40,1) ON CONFLICT DO NOTHING");
  await query('INSERT INTO inventory_balances(item_id,location_id,quantity_on_hand,quantity_available) VALUES(980400,1,400,400) ON CONFLICT DO NOTHING');
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
});
after(async()=>{await writeFile('test-artifacts/operator-inventory-browser-coverage.json',JSON.stringify(coverage));await browser?.close();await new Promise(resolve=>server.close(resolve));await closeDb();});
async function pageFor(session,path) {
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block',permissions:['camera']});
  await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),session.token);
  const page=await context.newPage();page.setDefaultTimeout(6000);await page.coverage.startJSCoverage({resetOnNavigation:false});
  await page.goto(base+path);return {page,context};
}
async function finish(page,context,name) {
  await page.screenshot({path:`test-artifacts/operator-inventory-${name}.png`,fullPage:true});
  coverage.push(...await page.coverage.stopJSCoverage());await context.close();
}
test('K2/C2-C3: operator takes sheet, calculates 108 PLT and submits',async()=>{
  const sheet=await createCountSheet(manager.actor,{requestId:crypto.randomUUID(),locationId:1,title:'Browser count assignment',itemIds:[sku.item_id]});
  const {page,context}=await pageFor(op,'/operator');
  await page.locator('button[data-module="inventory"]').click();await page.locator('button[data-module="count-sheets"]').click();
  await page.locator(`[data-inv-action="take"][data-id="${sheet.id}"]`).click();
  await page.locator(`[data-inv-action="count-item"][data-id="${sku.item_id}"]`).click();
  for(const key of ['1','2','×','9','=']) await page.locator(`[data-inv-action="count-key"][data-key="${key}"]`).click();
  await expect(page.locator('[data-count-value="pallets"]')).toHaveText('108');
  const width=await page.locator('.cycle-grid .selected-panel').evaluate(e=>e.getBoundingClientRect().width);assert.equal(Math.round(width),360);
  await page.screenshot({path:'test-artifacts/operator-inventory-calculator.png',fullPage:true});
  await page.locator('[data-inv-action="confirm-count"]').click();
  await page.locator('[data-inv-action="submit-sheet"]').click();
  await expect(page.locator('[data-sheet-status]')).toHaveText('Submitted');
  await page.reload();await expect(page.locator('[data-sheet-status]')).toHaveText('Submitted');
  await finish(page,context,'count-sheet');
});
test('K1/K2/R1: existing cycle count preserves units, validates calculations and keeps buttons below digits',async()=>{
  const {page,context}=await pageFor(op,'/operator');
  await page.locator('button[data-module="inventory"]').click();await page.locator('button[data-module="cycle-count"]').click();
  await page.locator('#cycleSearch').fill('Browser Paver');
  await page.locator('[data-action="select-inventory-item"][data-item="980400"]').click();
  const key=async value=>page.locator(`[data-action="cycle-key"][data-key="${value}"]`).click();
  for(const value of ['1','2','×','9','=']) await key(value);
  await expect(page.locator('[data-cycle-display="cycle-pallets"]')).toHaveText('108');
  await page.locator('[data-action="select-cycle-unit"][data-unit="cycle-pieces"]').click();
  for(const value of ['5','−','7']) await key(value);
  await page.locator('[data-action="confirm-cycle-line"]').click();
  await expect(page.locator('[data-action="confirm-cycle-line"]')).toBeVisible();
  await key('Clear');await key('2');
  await page.locator('[data-action="select-cycle-unit"][data-unit="cycle-pallets"]').click();
  await expect(page.locator('[data-cycle-expression]')).toContainText('108 PLT');
  const geometry=await page.locator('.cycle-grid .selected-panel').evaluate(panel=>({width:panel.getBoundingClientRect().width,digits:panel.querySelector('.cycle-number-pad').getBoundingClientRect().bottom,operators:panel.querySelector('.count-calculator-operators').getBoundingClientRect().top}));
  assert.equal(Math.round(geometry.width),360);assert.ok(geometry.operators>=geometry.digits);
  await page.setViewportSize({width:1024,height:768});
  await page.locator('[data-action="confirm-cycle-line"]').click();
  await expect(page.locator('[data-action="edit-cycle-line"]').filter({hasText:'Browser Paver'})).toContainText('108 PLT');
  await finish(page,context,'cycle-count');
});
test('C1/C5: control creates exact SKU assignment and shows review tools',async()=>{
  const {page,context}=await pageFor(manager,'/control/count-sheets');
  await page.locator('[data-sheet-action="new"]').click();
  await page.locator('#sheetTitle').fill('Created through Control');
  await page.locator('[data-sheet-search]').fill('Browser Paver');
  await page.locator(`[data-sheet-action="add"][data-id="${sku.item_id}"]`).click();
  await page.locator('[data-sheet-action="save"]').click();
  await expect(page.locator('[data-sheet-detail]')).toContainText('Created through Control');
  await expect(page.locator('[data-sheet-status]')).toHaveText('Available');
  assert.ok(await page.locator('.count-sheet-list button').first().evaluate(button=>button.scrollHeight<=button.clientHeight+1),'Sheet summary must fit inside its card');
  await finish(page,context,'control');
});
test('D8/D7: live camera, required reason and photo, 70/30 entry and 40/60 review',async()=>{
  const {page,context}=await pageFor(op,'/operator');let uploadedKey,submitted;
  await page.route('**/api/inventory/damage/items**',route=>route.fulfill({json:new URL(route.request().url()).pathname.endsWith('/items')?[sku]:sku}));
  await page.route('**/api/operator/photo-upload-token',async route=>{
    const body=route.request().postDataJSON();uploadedKey=`operator/operator-damage-photo/2026/09/23/${op.actor.id}/yard-1/${body.orderRef}/photo.jpg`;
    await route.fulfill({json:{uploadUrl:base+'/inventory-photo-test-upload',token:'test-upload-ticket'}});
  });
  await page.route('**/inventory-photo-test-upload',route=>route.fulfill({json:{key:uploadedKey}}));
  await page.route('**/api/inventory/damage/reports',async route=>{
    submitted=route.request().postDataJSON();await route.fulfill({status:202,json:{id:submitted.requestId,status:'pending'}});
  });
  await page.route('**/api/inventory/damage/reports?**',route=>route.fulfill({json:{reports:[{id:'legacy',item_name:'Existing NetSuite line',quantity:3,unit:'PCS',photos:[],status:'posted',transfer_ref:'IT00551',reason_label:'R3 - Chipping / Crack',legacy:true}],transfers:[{id:998187,ref:'IT00551'}]}}));
  await page.locator('button[data-module="inventory"]').click();await page.locator('button[data-module="damage"]').click();
  await page.locator('#damageSearch').fill('Browser');await page.locator(`[data-inv-action="damage-item"][data-id="${sku.item_id}"]`).click();
  await expect(page.locator('[data-inv-action="submit-damage"]')).toBeDisabled();
  await page.locator('[data-damage-quantity="pieces"]').fill('3');await page.locator('#damageReason').selectOption('7');
  await page.locator('[data-inv-action="camera"]').click();
  await page.waitForFunction(()=>document.querySelector('#damageCamera')?.videoWidth>0);
  await page.locator('[data-inv-action="capture"]').click();
  const ratio=await page.locator('.damage-entry-grid').evaluate(e=>{const [a,b]=[...e.children].map(c=>c.getBoundingClientRect().width);return a/(a+b);});assert.ok(Math.abs(ratio-0.7)<0.01);
  await page.screenshot({path:'test-artifacts/operator-inventory-damage-entry.png',fullPage:true});
  await page.locator('[data-inv-action="submit-damage"]').click();await expect(page.locator('[data-damage-saved]')).toBeVisible();
  assert.equal(submitted.photos.length,1);assert.equal(Number(submitted.values.pieces),3);assert.equal(Number(submitted.reasonId),7);
  await page.locator('[data-inv-action="damage-review"]').click();
  await expect(page.locator('.damage-review-details')).toContainText('No photo on record');
  const reviewRatio=await page.locator('.damage-review-grid').evaluate(e=>{const [a,b]=[...e.children].map(c=>c.getBoundingClientRect().width);return a/(a+b);});assert.ok(Math.abs(reviewRatio-0.4)<0.01);
  await page.locator('#damageMonth').fill('2026-08');await page.locator('#damageMonth').dispatchEvent('change');
  await finish(page,context,'damage-review');
});
