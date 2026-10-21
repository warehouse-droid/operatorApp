// Operational availability evidence for the requested SCM change; no cart actions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
import {createStockCheckRuntime} from '/app/src/stock-check/runtime.js';
import {readPortalDocument} from '/app/src/stock-check/unilock-dom.js';
import {sanitizeFailure,allowedPortalUrl} from '/app/src/stock-check/domain.js';
import {closeDb} from '/app/src/db.js';

const runtime=createStockCheckRuntime({authenticate:(_req,_res,next)=>next(),dataDir:'/app/data'});
const directory='/app/data/stock-check/operations/pre-cart-availability-20261014';
const mode=process.argv[2]??'inspect';
const output={at:new Date().toISOString(),mode,jobs:[],products:[]};
let credentials,browser;
try {
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  if(mode==='jobs') {
    const source=await fs.readFile('/app/src/stock-check/unilock-stock.js','utf8');
    assert.ok(source.includes('result=await checkProductAvailability(state)'));
    assert.equal(source.includes('async function submitQuantity'),false);
    for(const [sku,quantity] of [['0262XL0631907-0',5],['02U1183661507-0',2]]) {
      const products=await runtime.repo.listProducts({vendorId:1,search:sku});assert.equal(products.total,1);
      let job=await runtime.repo.createJob(1,{kind:'stock_test',productId:products.items[0].id,quantity},'authorized-unilock-pre-cart-check');
      console.log(JSON.stringify({queued:job.id,sku}));
      const deadline=Date.now()+150000;
      while(['queued','running'].includes(job.status)&&Date.now()<deadline) {
        await new Promise(resolve=>setTimeout(resolve,1000));job=await runtime.repo.getJob(job.id);
      }
      output.jobs.push(job);
      await fs.writeFile(directory+'/jobs.json',JSON.stringify(output,null,2)+'\n',{mode:0o600});
      assert.equal(job.status,'completed',job.result?.reason??'The stock check did not complete.');
      assert.equal(job.result.availabilityEvidenceVersion,2);assert.equal(job.result.verifiedQuantity,null);
      assert.equal(job.result.cartAcceptanceVerified,false);assert.equal(job.result.quantityVerified,false);
      assert.equal(job.steps.some(step=>['add_to_cart','quantity_entry','cart_cleanup'].includes(step.key)),false);
      assert.ok(job.steps.find(step=>step.key==='availability_check').screenshot);
      assert.ok(job.steps.find(step=>step.key==='add_to_cart_skipped'));
      console.log(JSON.stringify({completed:job.id,sku,status:job.result.status,availability:job.result.availabilityText,eta:job.result.eta}));
    }
  }
  const account=(await runtime.repo.listAccounts(1)).find(row=>row.active&&row.selected);assert.ok(account);
  credentials=await runtime.repo.getCredentials(1,account.id);
  browser=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();
  await context.route('**/*',async route=>{
    const request=route.request();
    try {
      if(request.isNavigationRequest()||request.method()!=='GET') {allowedPortalUrl(request.url());}
      const target=new URLSearchParams(request.postData()??'').get('__EVENTTARGET')??'';
      assert.equal(/add.?to.?cart|ibAdd|removefromcart|butUpdatCart|checkout|place.?order|submit.?order|payment/iu.test(target),false);
      await route.continue();
    }catch {await route.abort();}
  });
  await page.goto('https://ontario.order.unilock.com/login.aspx',{waitUntil:'domcontentloaded'});
  await page.locator('#txtUserName').fill(credentials.username);await page.locator('[id$="_txtPassword"]').fill(credentials.password);
  await Promise.all([page.waitForEvent('framenavigated',{predicate:frame=>frame===page.mainFrame()}),page.locator('[id$="_bLogin"]').click()]);
  await page.waitForLoadState('domcontentloaded');
  await page.locator('a[href*="logout" i]').first().waitFor({state:'attached'});
  await page.goto('https://ontario.order.unilock.com/shoppingCart.aspx',{waitUntil:'domcontentloaded'});
  const cart=await readPortalDocument(page);assert.equal(cart.cartParseFailures,0);assert.equal(cart.cartRows.length,0,'The cart must remain empty.');
  output.cartEmpty=true;
  for(const [slug,sku] of mode==='jobs'?[]:[['beacon-hill-smooth','0262XL0631907-0'],['urban','02U1183661507-0']]) {
    const products=await runtime.repo.listProducts({vendorId:1,search:sku});assert.equal(products.total,1);
    await page.goto(products.items[0].url,{waitUntil:'domcontentloaded'});
    const doc=await readPortalDocument(page);assert.equal(doc.selected?.sku,sku);
    const controls=await page.locator('[id*="avail" i],select').evaluateAll(nodes=>nodes.map(node=>({id:node.id,text:node.textContent,value:node.value,
      visible:Boolean(node.getClientRects().length)&&window.getComputedStyle(node).visibility!=='hidden',html:node.outerHTML.slice(0,1200)})));
    console.log(JSON.stringify({sku,url:page.url(),availability:doc.productBundleAvailability,source:doc.productAvailabilitySource,stockLabel:doc.stockLabel,errors:doc.errors,controls}));
    await page.screenshot({path:directory+'/'+slug+'-diagnosis.jpg',type:'jpeg',quality:80,fullPage:true});
    if(mode==='inspect') {output.products.push({sku,availability:doc.productBundleAvailability,source:doc.productAvailabilitySource,controls});continue;}
    const target=doc.productAvailabilityId?page.locator('[id="'+doc.productAvailabilityId+'"]'):
      page.locator(doc.productAvailabilitySource==='product_bundle'?'[id$="_uomctl_iuom"]':'[id$="_stockAvail"]').first();
    await target.waitFor({state:'visible'});
    await target.evaluate(node=>node.scrollIntoView({block:'center',inline:'nearest'}));
    const file=slug+'-'+mode+'.jpg';await page.screenshot({path:directory+'/'+file,type:'jpeg',quality:80});
    output.products.push({sku,stockLabel:doc.stockLabel,availability:doc.productBundleAvailability,
      source:doc.productAvailabilitySource,errors:doc.errors,control:await target.evaluate(node=>({id:node.id,value:node.value,text:node.textContent,top:node.getBoundingClientRect().top})),screenshot:file});
  }
  await fs.writeFile(directory+'/'+mode+'.json',JSON.stringify(output,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({at:output.at,mode,cartEmpty:output.cartEmpty,products:output.products,jobs:output.jobs.map(job=>({id:job.id,result:job.result}))}));
}catch(error) {
  console.error(sanitizeFailure(error,[credentials?.password]));process.exitCode=1;
}finally {
  if(credentials) {credentials.password=null;}
  await browser?.close();await closeDb();
}
