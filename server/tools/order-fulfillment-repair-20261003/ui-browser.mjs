import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chromium,expect} from '@playwright/test';

const output='test-artifacts/review-navigation';fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const results=[];
try {
  for(const mode of ['pickup','delivery','receipt']) {
    const page=await browser.newPage({viewport:{width:800,height:1100},serviceWorkers:'block'});
    const errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));
    await page.coverage.startJSCoverage({resetOnNavigation:false});
    await page.route('http://localhost:32189/**',async route=>{
      const url=new URL(route.request().url());
      if(url.pathname.startsWith('/api/')) {
        if(route.request().method()==='POST')posts.push(url.pathname);
        let value={};
        if(url.pathname==='/api/auth/me')value={operator:{id:'review-browser',display_name:'Operator',role:'operator',roles:['operator'],operatorYardLocationIds:[1]}};
        else if(url.pathname==='/api/delivery/notifications')value={total:0,salesOrder:{},transferOrder:{},items:[]};
        else if(url.pathname==='/api/delivery/current-draft')value=null;
        else if(url.pathname==='/api/operator/requests')value=[];
        else if(url.pathname.startsWith('/api/receiving/'))value=[];
        else if(url.pathname==='/api/delivery/orders')value=[];
        return route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      }
      const file=url.pathname==='/operator'?'operator.html':url.pathname.slice(1);
      if(file.startsWith('vendor/'))return route.fulfill({contentType:'application/javascript',body:''});
      const candidate=path.resolve('public',file);assert(candidate.startsWith(path.resolve('public')+'/'));
      return route.fulfill({body:fs.readFileSync(candidate),contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'});
    });
    await page.addInitScript(({sessionKey})=>{
      window.EventSource=class {addEventListener(){} close(){}};
      localStorage.setItem('mbbs.staff.token','review-browser-token');localStorage.setItem('mbbs.operator.token','review-browser-token');
      localStorage.setItem('mbbs.operator.locationId','1');localStorage.setItem('mbbs.ui.language','en');
      if(!localStorage.getItem('mbbs.operator.state'))localStorage.setItem('mbbs.operator.state',JSON.stringify({locationId:1,currentModule:'menu',accountId:'review-browser',sessionKey}));
    },{sessionKey:createHash('sha256').update('review-browser-token').digest('hex')});
    await page.goto('http://localhost:32189/operator');
    await page.waitForFunction(()=>typeof operator!=='undefined'&&operator?.id==='review-browser');
    await page.evaluate(mode=>{
      const order={netsuite_id:7,tranid:'REVIEW7',order_type:mode==='receipt'?'purchase_order':mode==='delivery'?'transfer_order':'sales_order',lines:[]};
      if(mode==='receipt') {
        receiptOrder=order;receiptRequestId='receipt-review';receiptSubmitting=false;receiptResult=null;
        currentModule='receiving-receipt';receivingStep='orders';
        rememberReceiptPosting({jobId:'receipt-review',status:'attention',receiveBlocked:true,transactions:[{id:9,ref:'IR9'}]});
      } else {
        fulfillmentOrder=order;selectedOrder=order;selectedId=7;fulfillmentLoadRequestId='load-review';fulfillmentSubmitting=false;fulfillmentResult=null;
        currentModule=mode==='pickup'?'customer-pickup-load':'delivery-fulfill';
        rememberFulfillmentPosting({jobId:'load-review',status:'attention',loadBlocked:true,transactions:[{id:9,ref:'IF9'}]});
      }
      render();
    },mode);
    const proceed=page.locator('.fulfillment-screen [data-action="continue-operator-work"]');
    await expect(proceed).toBeVisible();
    await expect(page.locator('[data-action="confirm-fulfill"],[data-action="confirm-receive"]')).toHaveCount(0);
    await expect(page.locator('[data-action="start-camera"],[data-action="start-receipt-camera"]')).toHaveCount(0);
    await page.screenshot({path:`${output}/${mode}-review.png`,fullPage:true});
    await proceed.click();
    const expected=mode==='receipt'?'receiving':mode==='pickup'?'customer-pickup-scan':'delivery';
    await expect(page.locator('#app')).toHaveAttribute('data-module',expected);
    const state=await page.evaluate(mode=>({busy:fulfillmentSubmitting||receiptSubmitting,
      journal:localStorage.getItem(mode==='receipt'?'mbbs.operator.receipt:review-browser:purchase_order:7':`mbbs.operator.posting:review-browser:${mode==='delivery'?'transfer_order':'sales_order'}:7`)}),mode);
    assert.equal(state.busy,false);assert(state.journal);assert.equal(JSON.parse(state.journal).status,'attention');
    await page.screenshot({path:`${output}/${mode}-continued.png`,fullPage:true});
    await page.reload();await expect(page.locator('#app')).toHaveAttribute('data-module',expected);
    await expect(page.locator('[data-action="continue-operator-work"]')).toHaveCount(0);
    assert.deepEqual(posts,[]);assert.deepEqual(errors,[]);
    fs.writeFileSync(`${output}/${mode}-coverage.json`,JSON.stringify(await page.coverage.stopJSCoverage()));
    results.push({mode,navigation:expected,journalPreserved:true,reloadStaysAway:true,submissions:0,browserErrors:0});
    await page.close();
  }
  console.log(JSON.stringify({passed:true,results}));
} finally {await browser.close();}
