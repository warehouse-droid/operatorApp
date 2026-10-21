import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const out='test-artifacts/delivery-instruction-netsuite';await mkdir(out,{recursive:true});
const server=createServer(async(req,res)=>{
 try{const url=new URL(req.url,'http://localhost'),file=url.pathname==='/sales/delivery-instructions'?'/sales-delivery-instructions.html':url.pathname;
  assert(!file.includes('..'));const bytes=await readFile('public'+file);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(bytes);
 }catch{res.writeHead(404);res.end('Not found');}
});
server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true,args:['--no-sandbox']}),checks=[],errors=[];
const context=await browser.newContext({viewport:{width:1365,height:1000}}),page=await context.newPage();page.setDefaultTimeout(4000);
const coverage=[];
page.on('pageerror',error=>errors.push(error.message));await page.coverage.startJSCoverage({resetOnNavigation:false});
let detail={orderId:123,orderRef:'SOB-EXAMPLE',revision:0,customer:'Example customer',status:'Pending Fulfillment',editable:true,additionalText:'Local note',automatic:{text:'Original note',phones:[]},media:[]};
let netSuite={identity:{orderId:123,orderRef:detail.orderRef,locationId:1,deliveryMethodId:2,status:'B'},values:{memo:'Delivery Address: 12 Main St\nOriginal note',shipDate:'2026-09-30',deliverByDate:'2026-10-01'},editable:true,lockReason:''};
let saves=0,releaseSave=null,releaseLoad=null,holdLoad=false,failSave=false,failLoad=false;
await page.route('**/*',async route=>{
 const url=new URL(route.request().url());
 if(url.origin!==base)return route.abort();
 if(url.pathname==='/dispatch-auth.js')return route.fulfill({contentType:'text/javascript',body:'var dispatchAuthToken=""; function dispatchLogout(){} function requireDispatchLogin(o){o.onReady({display_name:"Example Sales"});}'});
 if(url.pathname.startsWith('/api/')){
  const method=route.request().method(),input=route.request().postDataJSON();let body;
  if(url.pathname.endsWith('/netsuite')){
   if(method==='PUT'){
    saves++;await new Promise(resolve=>{releaseSave=resolve;});releaseSave=null;
    if(failSave)return route.fulfill({status:409,json:{error:{message:'NetSuite changed. Reload and review.'},code:'CONFLICT'}});
    netSuite={...netSuite,values:input.values};detail={...detail,revision:detail.revision+1,automatic:{text:input.values.memo,phones:[]}};
   }else{
    if(holdLoad)await new Promise(resolve=>{releaseLoad=resolve;});
    if(failLoad)return route.fulfill({status:502,json:{error:'NetSuite temporarily unavailable.'}});
   }
   body={...detail,netSuite};
  }else if(url.pathname.endsWith('/orders'))body=[detail,{...detail,orderId:124,orderRef:'SOB-OTHER'}];
  else{if(method==='PUT')detail={...detail,revision:detail.revision+1,additionalText:input.additionalText};body=detail;}
  return route.fulfill({json:body});
 }
 return route.continue();
});
try{
 await page.goto(base+'/sales/delivery-instructions');
 const memo=page.locator('#salesDeliveryInstructionMemo'),ship=page.locator('#salesDeliveryInstructionShipDate'),by=page.locator('#salesDeliveryInstructionDeliverByDate');
 await memo.waitFor();assert.equal(await memo.inputValue(),netSuite.values.memo);assert.equal(await ship.inputValue(),'2026-09-30');assert.equal(await by.inputValue(),'2026-10-01');checks.push('Native memo and two independent calendar dates load');
 await page.locator('#salesDeliveryInstructionText').fill('Unsaved local note');
 await memo.fill('Use <rear> gate');await ship.fill('2028-02-29');await by.fill('2028-03-01');
 await page.evaluate(()=>window.dispatchEvent(new Event('mbbs-language-changed')));assert.equal(await memo.inputValue(),'Use <rear> gate');checks.push('Drafts survive language rerender');
 await page.locator('[data-delivery-instruction-action="save-netsuite"]').click();
 await page.waitForFunction(()=>document.body.textContent.includes('Saving to NetSuite'));
 assert.equal(await page.locator('button:enabled, input:enabled, textarea:enabled').count(),0);
 assert.equal(await page.locator('.app-sidebar').evaluate(el=>el.inert),true);
 assert.equal(await memo.inputValue(),'Use <rear> gate');assert.equal(await page.locator('#salesDeliveryInstructionText').inputValue(),'Unsaved local note');
 await page.evaluate(()=>document.querySelector('[data-delivery-instruction-action="save-netsuite"]').dispatchEvent(new window.MouseEvent('click',{bubbles:true})));
 assert.equal(saves,1);releaseSave();await page.getByText('Saved to NetSuite.',{exact:true}).waitFor();
 assert.equal(await memo.inputValue(),'Use <rear> gate');assert.equal(await by.inputValue(),'2028-03-01');checks.push('Busy status, disabled actions, duplicate suppression and verified save');
 assert.equal(await page.locator('#salesDeliveryInstructionText').inputValue(),'Unsaved local note');checks.push('NetSuite save retains unsaved app-only text');
 await memo.fill('Retain this draft');failSave=true;await page.locator('[data-delivery-instruction-action="save-netsuite"]').click();
 await page.waitForFunction(()=>document.body.textContent.includes('Saving to NetSuite'));releaseSave();await page.getByText('NetSuite changed. Reload and review.',{exact:true}).waitFor();
 assert.equal(await memo.inputValue(),'Retain this draft');assert(!await page.locator('body').textContent().then(text=>text.includes('[object Object]')));checks.push('Structured conflict message and draft retained');
 failSave=false;
 await page.locator('[data-delivery-instruction-action="save-text"]').click();await page.getByText('Delivery instruction saved.',{exact:true}).waitFor();assert.equal(await memo.inputValue(),'Retain this draft');checks.push('Saving app text retains NetSuite draft');
 failLoad=true;await page.locator('[data-delivery-instruction-action="reload-netsuite"]').click();await page.getByText('NetSuite temporarily unavailable.',{exact:true}).waitFor();assert.equal(await memo.inputValue(),'Retain this draft');checks.push('Failed reload retains draft and exposes retry');
 failLoad=false;await page.locator('[data-delivery-instruction-action="reload-netsuite"]').click();await page.waitForFunction(()=>document.querySelector('#salesDeliveryInstructionMemo').value==='Use <rear> gate');checks.push('Explicit reload refreshes native values');
 holdLoad=true;await page.locator('[data-delivery-instruction-action="reload-netsuite"]').click();await page.getByRole('status').filter({hasText:'Loading NetSuite values'}).waitFor();
 assert.equal(await page.locator('button:enabled, input:enabled, textarea:enabled').count(),0);releaseLoad();holdLoad=false;await page.locator('[data-delivery-instruction-action="save-netsuite"]:enabled').waitFor();checks.push('Waiting for NetSuite read also disables page actions');
 await page.screenshot({path:out+'/sales-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{window.MBBS_I18N.setLanguage?.('zh-CN');});
 assert.equal(await page.locator('[data-delivery-instruction-action="save-netsuite"]').textContent(),'保存至 NetSuite');assert.match(await page.locator('label[for="salesDeliveryInstructionDeliverByDate"]').textContent(),/最迟送达日期/);checks.push('Chinese labels describe the native fields');
 await page.screenshot({path:out+'/sales-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);checks.push('Mobile layout does not overflow');
 // Chromium replaces script IDs on reload even when navigation reset is disabled.
 // Preserve the exercised editor before loading a fresh document.
 coverage.push(...await page.coverage.stopJSCoverage());await page.coverage.startJSCoverage({resetOnNavigation:false});
 failLoad=true;await page.reload();await page.getByText('NetSuite temporarily unavailable.',{exact:true}).waitFor();
 assert.equal(await memo.isDisabled(),true);assert.equal(await page.locator('[data-delivery-instruction-action="save-netsuite"]').isDisabled(),true);assert.equal(await page.locator('#salesDeliveryInstructionText').isEnabled(),true);checks.push('First read failure cannot save unknown or blank native values');
 failLoad=false;await page.locator('[data-delivery-instruction-action="reload-netsuite"]').click();await page.locator('[data-delivery-instruction-action="save-netsuite"]:enabled').waitFor();
 detail={...detail,editable:false,lockReason:'Dropoff already completed.'};await page.locator('[data-delivery-instruction-action="reload-netsuite"]').click();await page.getByText('Dropoff already completed.',{exact:true}).waitFor();
 assert.equal(await memo.isDisabled(),true);assert.equal(await ship.isDisabled(),true);assert.equal(await by.isDisabled(),true);assert.equal(await page.locator('[data-delivery-instruction-action="save-netsuite"]').isDisabled(),true);checks.push('Completed delivery fields remain readable and locked');
 assert.deepEqual(errors,[]);
}finally{
 coverage.push(...await page.coverage.stopJSCoverage());await writeFile(out+'/browser-coverage.json',JSON.stringify(coverage));
 await writeFile(out+'/browser.json',JSON.stringify({checks,errors},null,2));
 await browser.close();await new Promise(resolve=>server.close(resolve));
}
console.log(JSON.stringify({browserChecks:checks.length,errors}));
