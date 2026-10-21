// Exercise the actual pages against the existing isolated browser fixture.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const out='test-artifacts/special-workflow-review/detail-display-20260928';
let fixture=readFileSync('test/mbt/integration/special-approval-browser.test.js','utf8').split('\ntest(')[0];
fixture=fixture.replace("import test, { before, after } from 'node:test';\n",'')
 .replace(/^before\((async.*)\);$/m,'const setup = $1;').replace(/^after\((async.*)\);$/m,'const teardown = $1;')
 .replace("id: 'test-batch', display_name", "id: state.userId || 'test-batch', display_name");
const review=String.raw`
const sizes=page=>page.locator('.stock-request-detail').evaluate(root=>[root,...root.querySelectorAll('*')].filter(e=>e instanceof HTMLElement).map(e=>Number.parseFloat(getComputedStyle(e).fontSize)));
const settle=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const controls=page=>page.locator('[data-special-detail-display]');
async function step(page,amount) {
 const name=amount>0?'Increase detail text size':'Decrease detail text size';
 for(let i=0;i<Math.abs(amount);i++) await controls(page).getByRole('button',{name}).click();
 await settle(page);
}
function expectOffset(before,after,offset) {
 assert.equal(before.length,after.length);
 before.forEach((size,i)=>assert.ok(Math.abs(after[i]-size-offset)<.01,'Non-additive font size at element '+i+': '+size+' → '+after[i]));
}
await setup();
const results=[];
try {
 for(const audience of ['sales','scm']) {
  const {page,context,state}=await fixture(audience,1440,d=>{
   Object.assign(d,{salesOrderId:10,salesOrderRef:'SO-TEST',purchaseOrderId:20,purchaseOrderRef:'PO-TEST',purchaseOrderApproved:true,purchaseOrderReference:'VENDOR-REF',stage:'dispatch_arrangement',palletRate:25});
   d.lines.forEach(l=>Object.assign(l,{salesDecision:'accepted',packageQuantity:2,rateUom:'PLT',originalRate:123.456789,discountPercent:10,subtotal:222.22}));
  });
  try {
   await expect(controls(page)).toBeVisible();await settle(page);
   const baseline=await sizes(page);
   assert.ok(new Set(baseline).size>3,'The fixture must contain multiple font sizes');
   const listBefore=await page.locator('.stock-request-card').evaluate(e=>getComputedStyle(e).fontSize);
   await step(page,2);await expect(controls(page).locator('output')).toHaveText('+2 px');
   expectOffset(baseline,await sizes(page),2);
   assert.equal(await page.locator('.stock-request-card').evaluate(e=>getComputedStyle(e).fontSize),listBefore);
   // A real case rerender must retain the offset without compounding inherited sizes.
   await page.locator('.stock-request-card[data-id="1"]').click();await settle(page);
   expectOffset(baseline,await sizes(page),2);
   await step(page,-1);expectOffset(baseline,await sizes(page),1);
   await controls(page).getByRole('button',{name:'Reset',exact:true}).click();await settle(page);
   expectOffset(baseline,await sizes(page),0);
   await step(page,-2);expectOffset(baseline,await sizes(page),-2);
   await expect(controls(page).getByRole('button',{name:'Decrease detail text size'})).toBeDisabled();
   await controls(page).getByRole('button',{name:'Reset',exact:true}).click();await settle(page);
   await step(page,2);
   await page.reload();await expect(controls(page).locator('output')).toHaveText('+2 px');await settle(page);
   expectOffset(baseline,await sizes(page),2);
   // Same browser, a different signed-in account starts independently; switching back restores the first account.
   state.userId='test-other';await page.reload();await expect(controls(page).locator('output')).toHaveText('+0 px');
   await step(page,-1);
   state.userId='test-batch';await page.reload();await expect(controls(page).locator('output')).toHaveText('+2 px');await settle(page);
   expectOffset(baseline,await sizes(page),2);
   if(audience==='sales') {
    const form=page.locator('[data-special-fulfillment-form]');
    const placement=await form.evaluate(form=>{
     const select=form.querySelector('select'),save=form.querySelector('button[type=submit]');
     const a=select.getBoundingClientRect(),b=save.getBoundingClientRect();
     return {sameSpan:select.parentElement===save.parentElement,sameRow:Math.abs(a.top-b.top)<1,width:select.parentElement.getBoundingClientRect().width,label:save.textContent};
    });
    assert.equal(placement.sameSpan,true);assert.equal(placement.sameRow,true);assert.equal(placement.label,'Save');assert.ok(placement.width<297);
    await expect(page.locator('[data-special-material="1"] .special-fixed-value')).toHaveText('$123.456789');
    await expect(page.locator('[data-special-material="1"] [data-special-subtotal]')).toHaveText('$222.22');
    await form.locator('select').selectOption('mbt_delivery');await form.locator('[name=deliveryAddress]').fill('Unsaved test address');
    const withDelivery=await sizes(page);await step(page,1);expectOffset(withDelivery,await sizes(page),1);
    await expect(form.locator('[name=deliveryAddress]')).toHaveValue('Unsaved test address');
    results.push({audience,placement,perUser:true,additive:true,pricing:true,unsavedDeliveryPreserved:true});
   } else {
    const ref=page.locator('[data-special-po-reference-form]');await ref.locator('[name=reference]').fill('Unsaved vendor ref');
    await step(page,1);await expect(ref.locator('[name=reference]')).toHaveValue('Unsaved vendor ref');
    results.push({audience,perUser:true,additive:true,unsavedReferencePreserved:true});
   }
   await page.screenshot({path:out+'/'+audience+'-desktop.png',fullPage:true});
   assert.deepEqual(state.posts,[]);assert.deepEqual(state.errors,[]);
  } finally {await context.close();}
 }
 for(const audience of ['sales','scm']) {
  const {page,context,state}=await fixture(audience,390,d=>{d.salesOrderId=10;d.salesOrderApproved=true;d.purchaseOrderLines=[{caseLineId:1,description:'TEST material',quantity:2,uom:'PC',unitPurchaseCost:3}];});
  try {
   await expect(controls(page)).toBeVisible();
   if(audience==='scm') {
    const form=page.locator('[data-special-po-form]');await form.locator('[name=vendorDiscountPercent]').fill('10');
    await expect(form.locator('[data-special-vendor-line-total]')).toHaveText('Vendor discount: $0.60 · Net line total: $5.40');
    await expect(form.locator('[data-special-purchase-totals]')).toHaveText('Gross purchase total: $6.00 · Vendor discount: $0.60 · Net purchase total: $5.40');
    await expect(form.locator('[name=unitPurchaseCost]')).toHaveValue('3');
   }
   await step(page,8);await expect(controls(page).getByRole('button',{name:'Increase detail text size'})).toBeDisabled();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   if(audience==='sales') {
    const pos=await page.locator('[data-special-fulfillment-form]').evaluate(f=>[...f.querySelectorAll('.special-summary-delivery select,.special-summary-delivery button')].map(e=>e.getBoundingClientRect().top));
    assert.equal(pos[0],pos[1]);
   }
   await page.screenshot({path:out+'/'+audience+'-mobile-max.png',fullPage:true});
   assert.deepEqual(state.posts,[]);assert.deepEqual(state.errors,[]);
   results.push({audience,mobile:true,maxOffset:8,noOverflow:true});
  } finally {await context.close();}
 }
 console.log(JSON.stringify(results));
} finally {await teardown();}
`;
const path=out+'/browser-display-preview.mjs';writeFileSync(path,fixture+review);
const result=spawnSync(process.execPath,[path],{encoding:'utf8',env:{...process.env,SPECIAL_BROWSER_ARTIFACTS:out},timeout:60000});
writeFileSync(out+'/preview.log',(result.stdout||'')+(result.stderr||''));assert.equal(result.status,0,result.stderr);console.log(result.stdout);
