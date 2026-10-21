import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { app } from '../../src/server.js';
import { query, closeDb } from '../../src/db.js';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
assert.ok(process.env.DATABASE_URL.endsWith('/mbt_verify'));
const out='test-artifacts/special-status-following-20261005';
const caseId=Number((await query("SELECT id FROM sales_stock_requests WHERE request_ref='SPREQ-TEST-STATUS'")).rows[0].id);
const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const results=[];
let currentPage;
try{
 for(const audience of ['sales','scm'])for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:960}});
  const page=await context.newPage(),errors=[];
  currentPage=page;
  page.on('pageerror',error=>errors.push(error.message));
  await page.coverage.startJSCoverage({resetOnNavigation:false});
  await page.goto(`${base}/${audience}/stock-requests`,{waitUntil:'domcontentloaded'});
  await page.locator('[name=username]').fill('special-status-test');
  await page.locator('[name=password]').fill('test-status-only');
  await page.locator('[data-form=login] button[type=submit]').click();
  await page.waitForFunction(()=>Boolean(window.localStorage.getItem('mbbs.staff.token')));
  await page.waitForURL(url=>!url.pathname.startsWith('/login'));
  await page.goto(`${base}/${audience}/stock-requests`,{waitUntil:'domcontentloaded'});
  const tab=audience==='sales'?'[data-sales-stock-action=special]':'[data-stock-request-tab=special]';
  const searchSelector=audience==='sales'?'[data-special-search]':'[data-special-scm-search]';
  await page.locator(`${tab},${searchSelector}`).first().waitFor();
  if(await page.locator(tab).count())await page.locator(tab).click();
  const search=page.locator(searchSelector);
  await search.fill('SPREQ-TEST-STATUS');
  const card=page.locator(`[data-special-${audience==='sales'?'sales':'scm'}-action=select][data-id="${caseId}"]`);
  await card.waitFor();await card.click();
  const detail=page.locator('.stock-request-detail');
  await detail.locator('.special-planning-order').first().waitFor();
  const text=await detail.locator('.special-planning-status').innerText();
  assert.match(text,/SO delivery: Delivered/);assert.match(text,/PO receipt: Arrived at yard/);
  assert.match(text,/2026-10-05 09:34:03 EDT/);assert.match(text,/2026-10-02 19:00:11 EDT/);
  assert.doesNotMatch(text,/Est\. arrival/);
  assert.equal(await detail.locator('[data-special-document=sales_order]').count(),1);
  assert.equal(await detail.locator('[data-special-document=purchase_order]').count(),audience==='scm'?1:0);
  if(audience==='sales')assert.doesNotMatch(text,/NetSuite:|Pending Bill/);
  else{assert.match(text,/NetSuite: Sales Order : Pending Billing/);assert.match(text,/NetSuite: Purchase Order : Pending Bill/);}
  for(const time of await detail.locator('.special-planning-completed-time time').all()){
   assert.equal(await time.evaluate(element=>{
    const value=element.getBoundingClientRect(),card=element.closest('.special-planning-order').getBoundingClientRect();
    return value.left>=card.left-1&&value.right<=card.right+1;
   }),true,'Completion time fits its order card');
  }
  assert.match(await card.innerText(),/Delivered/);assert.match(await card.innerText(),/Arrived at yard/);
  assert.equal(await detail.locator('time[datetime="2026-10-05T13:34:03.290Z"]').count(),1);
  assert.equal(await detail.locator('time[datetime="2026-10-02T23:00:11.110Z"]').count(),1);
  assert.deepEqual(errors,[]);
  await page.screenshot({path:`${out}/browser-${audience}-${width}.png`,fullPage:true});
  await writeFile(`${out}/browser-coverage-${audience}-${width}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));
  results.push({audience,width,physicalStatuses:true,actualTimes:true,previewsCorrect:true,pageErrors:errors});
  await context.close();
 }
 await writeFile(`${out}/browser-summary.json`,JSON.stringify({version:browser.version(),checks:results},null,2));
 console.log(JSON.stringify({browserChecks:results.length,allPassed:true}));
}catch(error){
 if(currentPage&&!currentPage.isClosed()){
  await currentPage.screenshot({path:`${out}/browser-failure.png`,fullPage:true});
  await writeFile(`${out}/browser-failure.json`,JSON.stringify({url:currentPage.url(),message:error.message,body:await currentPage.locator('body').innerText()},null,2));
 }
 throw error;
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await closeDb();}
