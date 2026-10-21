// One-time operational action explicitly requested by SCM. Never used by stock checks.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
import {createStockCheckRuntime} from '/app/src/stock-check/runtime.js';
import {readPortalDocument} from '/app/src/stock-check/unilock-dom.js';
import {allowedPortalUrl,sanitizeFailure} from '/app/src/stock-check/domain.js';
import {pool,closeDb} from '/app/src/db.js';

const runtime=createStockCheckRuntime({authenticate:(_req,_res,next)=>next(),dataDir:'/app/data'});
const directory='/app/data/stock-check/operations/cart-clear-20261014';
let client,credentials,browser,locked=false;
const audit={at:new Date().toISOString(),requestedAction:'Remove every Unilock cart line',removed:[]};
try {
  client=await pool.connect();
  locked=(await client.query('SELECT pg_try_advisory_lock(19671122,288) AS locked')).rows[0].locked;
  assert.equal(locked,true,'A stock check is active; retry after it finishes.');
  const accounts=await runtime.repo.listAccounts(1),account=accounts.find(row=>row.active&&row.selected);
  assert.ok(account,'The vendor must have a selected active account.');
  credentials=await runtime.repo.getCredentials(1,account.id);
  browser=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();
  page.setDefaultTimeout(25000);
  let removing=false;
  page.on('dialog',async dialog=>{if(removing&&dialog.type()==='confirm') {await dialog.accept();}else {await dialog.dismiss();}});
  await context.route('**/*',async route=>{
    const request=route.request();
    try {
      if(request.isNavigationRequest()||request.method()!=='GET') {allowedPortalUrl(request.url());}
      const target=new URLSearchParams(request.postData()??'').get('__EVENTTARGET')??'';
      assert.equal(/add.?to.?cart|ibAdd|checkout|place.?order|submit.?order|payment/iu.test(target),false);
      await route.continue();
    }catch {await route.abort();}
  });
  await page.goto('https://ontario.order.unilock.com/login.aspx',{waitUntil:'domcontentloaded'});
  await page.locator('#txtUserName').fill(credentials.username);
  await page.locator('[id$="_txtPassword"]').fill(credentials.password);
  await Promise.all([page.waitForEvent('framenavigated',{predicate:frame=>frame===page.mainFrame()}),page.locator('[id$="_bLogin"]').click()]);
  await page.waitForLoadState('domcontentloaded');
  await page.locator('a[href*="logout" i]').first().waitFor({state:'attached'});
  assert.ok(await page.locator('a[href*="logout" i]').count(),'Vendor login failed.');
  const visit=async()=>{
    await page.goto('https://ontario.order.unilock.com/shoppingCart.aspx',{waitUntil:'domcontentloaded'});
    const doc=await readPortalDocument(page);assert.equal(doc.cartParseFailures,0,'Every cart line must be readable.');return doc;
  };
  let doc=await visit();
  const summary=rows=>rows.map(({sku,quantity,uom})=>({sku,quantity,uom}));
  audit.before=summary(doc.cartRows);
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  if(doc.cartRows.length) {await page.locator('[id="'+doc.cartRows[0].quantityId+'"]').scrollIntoViewIfNeeded();}
  await page.screenshot({path:directory+'/before.jpg',type:'jpeg',quality:80});
  while(doc.cartRows.length) {
    const row=doc.cartRows[0],remaining=summary(doc.cartRows.slice(1));
    removing=true;
    try {await Promise.all([page.waitForEvent('framenavigated',{predicate:frame=>frame===page.mainFrame()}),page.locator('[id="'+row.removeId+'"]').click()]);}
    finally {removing=false;}
    doc=await visit();
    assert.deepEqual(summary(doc.cartRows),remaining,'The vendor must remove exactly the selected line.');
    audit.removed.push({sku:row.sku,quantity:row.quantity,uom:row.uom});
    await fs.writeFile(directory+'/audit.json',JSON.stringify(audit,null,2)+'\n',{mode:0o600});
  }
  doc=await visit();assert.equal(doc.cartRows.length,0);
  await page.evaluate(()=>window.scrollTo(0,Math.max(0,document.body.scrollHeight-900)));
  await page.screenshot({path:directory+'/empty.jpg',type:'jpeg',quality:80});
  audit.after=[];audit.verifiedEmpty=true;audit.completedAt=new Date().toISOString();
  await fs.writeFile(directory+'/audit.json',JSON.stringify(audit,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(audit));
}catch(error) {
  console.error(sanitizeFailure(error,[credentials?.password]));process.exitCode=1;
}finally {
  if(credentials) {credentials.password=null;}
  await browser?.close();
  if(locked) {await client.query('SELECT pg_advisory_unlock(19671122,288)');}
  client?.release();await closeDb();
}
