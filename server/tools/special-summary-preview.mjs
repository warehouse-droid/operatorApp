// Reuse the existing local browser fixture for a read-only layout review.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const out='test-artifacts/special-workflow-review/summary-controls-20260928';
let fixture=readFileSync('test/mbt/integration/special-approval-browser.test.js','utf8').split('\ntest(')[0];
fixture=fixture.replace("import test, { before, after } from 'node:test';\n",'')
 .replace(/^before\((async.*)\);$/m,'const setup = $1;').replace(/^after\((async.*)\);$/m,'const teardown = $1;');
const review=`
await setup();
try {
 const results=[];
 for(const audience of ['sales','scm']) {
  const {page,context}=await fixture(audience,1440,d=>Object.assign(d,{salesOrderId:10,salesOrderRef:'SO-TEST',purchaseOrderId:20,purchaseOrderRef:'PO-TEST',purchaseOrderApproved:true,purchaseOrderReference:'VENDOR-REF',stage:'dispatch_arrangement'}));
  try {
   const result=await page.locator('.stock-request-detail').evaluate(root=>{
    const form=root.querySelector('[data-special-fulfillment-form]');
    if(form) return {sameDeliverySpan:form.querySelector('[name=fulfillmentMethod]').parentElement===form.querySelector('button[type=submit]').parentElement && form.querySelector('[name=fulfillmentMethod]').parentElement.tagName==='SPAN',deliveryLabels:[...form.querySelectorAll('.stock-request-summary small')].filter(node=>node.textContent==='Delivery method').length,selectorInSummary:Boolean(form.querySelector('[name=fulfillmentMethod]').closest('.stock-request-summary')),saveInSummary:Boolean(form.querySelector('button[type=submit]').closest('.stock-request-summary')),deliveryForms:root.querySelectorAll('[data-special-fulfillment-form]').length};
    const ref=root.querySelector('[data-special-po-reference-form]'),responses=[...root.querySelectorAll('h3')].find(h=>h.textContent==='Line responses');
    return {referenceAboveResponses:ref.getBoundingClientRect().bottom<=responses.getBoundingClientRect().top,referenceForms:root.querySelectorAll('[data-special-po-reference-form]').length};
   });
   if(audience==='sales') {assert.equal(result.sameDeliverySpan,true);assert.equal(result.deliveryLabels,1);assert.equal(result.selectorInSummary,true);assert.equal(result.saveInSummary,true);assert.equal(result.deliveryForms,1);}
   else {assert.equal(result.referenceAboveResponses,true);assert.equal(result.referenceForms,1);}
   await page.locator('.stock-request-detail').screenshot({path:out+'/'+audience+'-summary.png'});
   results.push({audience,...result});
  }finally{await context.close();}
 }
 console.log(JSON.stringify(results));
} finally {await teardown();}
`;
const path=`${out}/browser-preview.mjs`;writeFileSync(path,fixture+review);
const result=spawnSync(process.execPath,[path],{encoding:'utf8',env:{...process.env,SPECIAL_BROWSER_ARTIFACTS:out},timeout:60000});
writeFileSync(`${out}/preview.log`,(result.stdout||'')+(result.stderr||''));assert.equal(result.status,0,result.stderr);console.log(result.stdout);
