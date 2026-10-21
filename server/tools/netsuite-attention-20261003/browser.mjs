import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
const source=readFileSync('public/mbt-gates.js','utf8');
const functions=source.slice(source.indexOf('function fulfillmentActionSelect('),source.indexOf('function renderHistoricalFulfillmentEvents('));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage();await page.setContent('<main id="queue"></main>');
 await page.evaluate(()=>Object.assign(window,{saving:false,fulfillmentLoadError:'',salesOrderFulfillmentAttention:document.querySelector('#queue'),
  fulfillmentCandidates:[{id:'a',dispatchOrderRef:'SO-WAIT',status:'waiting_evidence',lastError:'Operator evidence incomplete'},
   {id:'b',dispatchOrderRef:'SO-ERROR',status:'attention',lastError:'Source line mismatch'}]}));
 await page.addScriptTag({content:functions+'\nrenderSalesOrderFulfillmentCandidates();'});
 assert.match(await page.locator('#queue').textContent(),/1 needs Admin review/);
 assert.match(await page.locator('summary').textContent(),/1 waiting for load evidence/);
 assert.equal(await page.locator('[data-candidate-status="waiting_evidence"] .danger').count(),0);
 assert.equal(await page.locator('[data-candidate-status="waiting_evidence"] button').count(),0);
 assert.equal(await page.locator('[data-candidate-status="attention"] .danger').textContent(),'Source line mismatch');
 await page.screenshot({path:'test-artifacts/netsuite-attention-20261003/queue.png',fullPage:true});
 writeFileSync('test-artifacts/netsuite-attention-20261003/browser.json',JSON.stringify({passed:true,checks:5})+'\n');
 console.log('5 browser checks passed');
}finally{await browser.close();}
