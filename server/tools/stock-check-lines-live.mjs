// Authorized operational checks of existing request lines; run inside the live app.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {chromium} from 'playwright';
import {createStockCheckRuntime} from '/app/src/stock-check/runtime.js';
import {createRequestStockChecks} from '/app/src/stock-check/request-checks.js';
import {readPortalDocument} from '/app/src/stock-check/unilock-dom.js';
import {allowedPortalUrl,sanitizeFailure} from '/app/src/stock-check/domain.js';
import {query,closeDb} from '/app/src/db.js';
const directory='/app/data/stock-check/operations/request-lines-20261014';
const runtime=createStockCheckRuntime({authenticate:(_req,_res,next)=>next(),dataDir:'/app/data'}),checks=createRequestStockChecks(runtime.repo);
const summary={at:new Date().toISOString(),jobs:[]};let credentials,browser;
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function snapshot(id) {
  return {request:(await query('SELECT revision,updated_at FROM sales_stock_requests WHERE id=$1',[id])).rows,
    lines:(await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1 ORDER BY id',[id])).rows};
}
try {
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  for(const [requestId,lineId,sku,name] of [[224,209,'02U1183661507-0',/urban/iu],[232,225,'2310122470301-0',/umbriano/iu]]) {
    const data=await checks.get(requestId),line=data.lines.find(row=>row.lineId===lineId);assert.ok(line);assert.match(line.productName,name);
    const products=await runtime.repo.listProducts({vendorId:data.vendorId,search:sku});assert.equal(products.total,1);assert.equal(products.items[0].sku,sku);
    if(requestId===224) {assert.match(line.productName,/60mm.*18x36.*Indiana Buff/iu);}
    else {assert.match(line.color,/winter marvel/iu);assert.match(line.size,/12\s*x\s*24\s*7\s*cm/iu);}
    const before=digest(await snapshot(requestId));
    const saved=await checks.start(requestId,{lines:[{lineId,productId:products.items[0].id,fingerprint:line.fingerprint}]},'authorized-unilock-request-live-check');
    let job=saved.lines.find(row=>row.lineId===lineId).job;console.log(JSON.stringify({queued:job.id,requestId,lineId,sku}));
    const deadline=Date.now()+210000;
    while(['queued','running'].includes(job.status)&&Date.now()<deadline) {await new Promise(resolve=>setTimeout(resolve,1000));job=await runtime.repo.getJob(job.id);}
    summary.jobs.push({requestId,lineId,job});await fs.writeFile(directory+'/jobs.json',JSON.stringify(summary,null,2),{mode:0o600});
    assert.equal(job.status,'completed',job.result?.reason||'Check did not finish.');assert.equal(job.result.availabilityEvidenceVersion,2);
    assert.equal(job.result.quantityVerified,false);assert.equal(job.result.cartAcceptanceVerified,false);
    assert.equal(before,digest(await snapshot(requestId)),'Manual request data must remain unchanged.');
    const evidence=job.steps.find(step=>step.key==='availability_check'&&step.screenshot);assert.ok(evidence);
    await fs.copyFile(runtime.evidenceDir+'/'+job.id+'/'+evidence.screenshot,directory+'/request-'+requestId+'-availability.jpg');
    assert.equal((await checks.get(requestId)).lines.find(row=>row.lineId===lineId).job.id,job.id);
    console.log(JSON.stringify({completed:job.id,requestId,sku,status:job.result.status,eta:job.result.eta,availability:job.result.availabilityText,manualResponseUnchanged:true}));
  }
  const account=(await runtime.repo.listAccounts(1)).find(row=>row.active&&row.selected);assert.ok(account);
  credentials=await runtime.repo.getCredentials(1,account.id);browser=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage']});
  const context=await browser.newContext(),page=await context.newPage();
  await context.route('**/*',async route=>{
    try {
      const request=route.request();if(request.isNavigationRequest()||request.method()!=='GET') {allowedPortalUrl(request.url());}
      const fields=new URLSearchParams(request.postData()??''),target=fields.get('__EVENTTARGET')??'';
      assert.equal(/add.?to.?cart|ibAdd|removefromcart|butUpdatCart|checkout|place.?order|submit.?order|payment/iu.test(target),false);
      assert.equal([...fields.keys()].some(key=>/ibAddToCart/iu.test(key)),false);await route.continue();
    } catch {await route.abort();}
  });
  await page.goto('https://ontario.order.unilock.com/login.aspx',{waitUntil:'domcontentloaded'});
  await page.locator('#txtUserName').fill(credentials.username);await page.locator('[id$="_txtPassword"]').fill(credentials.password);
  await Promise.all([page.waitForEvent('framenavigated',{predicate:frame=>frame===page.mainFrame()}),page.locator('[id$="_bLogin"]').click()]);
  await page.waitForLoadState('domcontentloaded');await page.locator('a[href*="logout" i]').first().waitFor({state:'attached'});
  await page.goto('https://ontario.order.unilock.com/shoppingCart.aspx',{waitUntil:'domcontentloaded'});
  const cart=await readPortalDocument(page);assert.equal(cart.cartParseFailures,0);assert.equal(cart.cartRows.length,0);summary.cartEmpty=true;
  await fs.writeFile(directory+'/summary.json',JSON.stringify({at:summary.at,cartEmpty:true,jobs:summary.jobs.map(({requestId,lineId,job})=>({requestId,lineId,id:job.id,result:job.result}))},null,2),{mode:0o600});
  console.log(JSON.stringify({passed:true,cartEmpty:true,checks:summary.jobs.length}));
} catch(error) {console.error(sanitizeFailure(error,[credentials?.password]));process.exitCode=1;}
finally {if(credentials) {credentials.password=null;}await browser?.close();await closeDb();}
