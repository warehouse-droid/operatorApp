import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const output='test-artifacts/special-workflow-review/final-browser';
await fs.rm(output,{recursive:true,force:true});await fs.mkdir(output,{recursive:true});
const examples=JSON.parse(await fs.readFile('test-artifacts/special-workflow-review/records.json','utf8'));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const results=[];
try {
 for(const role of ['sales','scm']) {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.tracing.start({screenshots:true,snapshots:true,sources:true});
  const page=await context.newPage(); const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:3000/${role}/stock-requests`);
  await page.locator('[name=username]').fill(`review-${role}`);await page.locator('[name=password]').fill('SpecialReview-2026!');
  await page.locator('[data-form=dispatch-login] button[type=submit]').click();
  await page.locator(role==='scm'?'[data-stock-request-tab=special]':'[data-sales-stock-action=special]').click();
  await page.locator('.special-stage-filter').waitFor();
  const data=await page.evaluate(async role=>(await(await fetch(`/api/${role}/special-stock-requests?limit=150`)).json()).requests,role);
  assert.equal(data.length,7);
  for(const example of examples){
   const actual=data.find(item=>item.id===example.id); assert.equal(actual.stage,example.target);
   assert.match(actual.updatedAt,/^\d{4}-/);
   if(role==='sales')assert.equal(JSON.stringify(actual).includes('unitPurchaseCost'),false);
   await page.locator(`[data-special-${role==='sales'?'sales':'scm'}-action=select][data-id="${example.id}"]`).click();
   await page.locator('.stock-request-detail h2').filter({hasText:example.requestRef}).waitFor();
   await page.screenshot({path:`${output}/${example.target}-${role}.png`,fullPage:true});
  }
  const stageAttr=role==='sales'?'data-special-stage':'data-special-scm-stage';
  await page.locator('.special-stage-filter summary').click();
  for(const [stage,total] of [['new_enquiry',1],['wait_for_production',2]]) {
   const response=page.waitForResponse(response=>response.url().includes(`/api/${role}/special-stock-requests?`)&&response.url().includes(stage));
   await page.locator(`[${stageAttr}][value=${stage}]`).check();
   assert.equal((await(await response).json()).requests.length,total);
  }
  assert.equal(await page.locator(`[${stageAttr}]:checked`).count(),2);
  assert.equal(await page.locator('[data-special-'+(role==='sales'?'sales':'scm')+'-action=select]').count(),2);
  await page.screenshot({path:`${output}/multi-select-${role}.png`,fullPage:true});
  const cleared=page.waitForResponse(response=>response.url().includes(`/api/${role}/special-stock-requests?`));
  await page.locator('[data-special-clear-stages]').click();assert.equal((await(await cleared).json()).requests.length,7);
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>document.documentElement.scrollWidth<=window.innerWidth+2,null,{timeout:3000});
  await page.screenshot({path:`${output}/mobile-${role}.png`,fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+2);
  assert.equal(overflow,false,`${role} mobile overflow`);assert.deepEqual(errors,[]);
  results.push({role,sevenStages:true,multiSelectOr:true,clearShowsAll:true,mobileNoOverflow:true,pageErrors:errors});
  await context.tracing.stop({path:`${output}/${role}-trace.zip`});await context.close();
 }
 await fs.writeFile(`${output}/results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}finally{await browser.close();}
