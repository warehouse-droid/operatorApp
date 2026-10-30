import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
let server,browser,base;
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname;
  if(name==='/'){res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/stock-requests.css"><main id="summary"></main><script src="/regular-stock-ui.js"></script><script src="/regular-stock-status-ui.js"></script>');return;}
  try{if(!/^\/[a-z0-9-]+\.(js|css)$/.test(name))throw Error('not an asset');res.setHeader('content-type',name.endsWith('.js')?'text/javascript':'text/css');res.end(await readFile('public'+name));}
  catch{res.statusCode=404;res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 await mkdir('test-artifacts/hourly-browser',{recursive:true});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
for(const width of [390,1440])test('hourly SO status is visible and escaped at '+width+'px',async()=>{
 const page=await browser.newPage({viewport:{width,height:900}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.coverage.startJSCoverage();await page.goto(base);await page.evaluate(()=>window.RegularStockStatus.ready);
 for(const completed of [false,true]){
  const request={workflowVersion:2,status:completed?'completed':'active',regular:{deliveryMethod:'pickup',salesOrderRef:'SO-HOURLY',handoffStatus:'complete',
   salesOrderProgress:{completed,statusText:completed?'Sales Order : Pending Billing':'Sales Order : Partially Fulfilled',checkedAt:'2026-10-28T10:00:00.000Z'}},lines:[{id:1,status:completed?'fulfilled':'converted'}]};
  await page.evaluate(value=>{document.querySelector('#summary').innerHTML=window.RegularStockUI.summary(value)+window.RegularStockStatus.render(value);},request);
  assert.equal(await page.getByText(request.regular.salesOrderProgress.statusText,{exact:true}).isVisible(),true);
  assert.equal(await page.getByText('Last checked',{exact:true}).isVisible(),true);
  assert.equal(await page.locator('[data-regular-main-status]').getAttribute('data-regular-main-status'),completed?'completed':'in_progress');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 }
 await page.evaluate(()=>{document.querySelector('#summary').innerHTML=window.RegularStockUI.summary({workflowVersion:2,regular:{deliveryMethod:'pickup',salesOrderProgress:{statusText:'<img src=x onerror=alert(1)>',checkedAt:'<script>alert(1)</script>'}},lines:[]});});
 assert.equal(await page.locator('#summary img,#summary script').count(),0);assert.deepEqual(errors,[]);
 await writeFile('test-artifacts/hourly-browser/coverage-'+width+'.json',JSON.stringify(await page.coverage.stopJSCoverage()));await page.close();
});
