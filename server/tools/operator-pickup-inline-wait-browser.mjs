import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {parse} from 'espree';
import {chromium} from '@playwright/test';

const source=await readFile('public/operator.js','utf8');
const functions=parse(source,{ecmaVersion:'latest',sourceType:'script'}).body
  .filter(node=>node.type==='FunctionDeclaration').map(node=>source.slice(node.start,node.end)).join('\n');
const css=await readFile('public/operator.css','utf8');
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.route('**/*',route=>route.abort());
  await page.setContent(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><main id="app" class="tablet-shell"></main></body></html>`);
  await page.addScriptTag({content:functions});
  await page.evaluate(()=>{
    Object.assign(window,{
      app:document.getElementById('app'),currentModule:'customer-pickup-load',locationId:1,
      operator:{id:'operator',display_name:'Operator'},selectedOrder:null,
      fulfillmentOrder:{netsuite_id:42,tranid:'SO42',order_type:'sales_order',lines:[{id:1}]},
      fulfillmentPhotoDataUrls:[],fulfillmentActivePhotoSlot:0,fulfillmentCameraActive:false,
      fulfillmentSubmitting:false,fulfillmentResult:null,fulfillmentJobStage:'',fulfillmentStatusText:'',
      fulfillmentStartedAt:0,fulfillmentProgressTimer:null,fulfillmentValidation:null,fulfillmentLoadRequestId:'request-42',
      fulfillmentNetSuitePolicy:{effective:true,functionKey:'customer_pickup',transactionType:'IF',gateKey:'pickup',revision:1},
      fulfillmentNetSuitePolicyError:'',operatorPhotoCamera:{},consolidationLoadState:{batch:null},pickupPosts:0,
      t:(_key,fallback)=>fallback,tf:(_key,fallback)=>fallback,localizeMessage:value=>value,
      escapeHtml:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
      shell:(_title,_subtitle,body,actions='')=>{window.app.dataset.module=window.currentModule;window.app.innerHTML=body+actions;},
      visibleLines:order=>order.lines,hasPackedQty:()=>true,currentLocation:()=>({text:'3445'}),
      customerPickupRequiredPhotoCount:()=>0,cameraOpenLabel:()=>'Open camera',renderCameraSwitchButton:()=>'',
      renderCompactLoadSummary:()=>'<div class="fulfillment-card fulfillment-summary-card"><strong>SO42</strong><p>Truck load: 26 PC and 1 pallet</p></div>',
      renderLoadValidation:()=>'',stopFulfillmentCamera(){},refreshCustomerPickupPhotoRequirement:async()=>{},
      loadOperatorNetSuitePostingPolicy:async()=>window.fulfillmentNetSuitePolicy,
      prepareOperatorBackgroundPhotos:async()=>({backgroundPhotos:[]}),resumeOperatorBackgroundPhotos(){},showToast(){},
      api:async(_url,options)=>{if(options?.method==='POST'){window.pickupPosts++;}return {status:'running',jobId:'request-42'};},
      pollOperatorNetSuitePostingJob:async(_id,progress)=>{
        progress({stage:'Posting to NetSuite',message:'0/1 NetSuite transaction(s) verified. 8s'});
        return new Promise(resolve=>{window.pickupResolve=resolve;});
      },render:()=>window.renderFulfillmentScreen()
    });
    document.addEventListener('click',event=>{
      if(event.target.closest('[data-action="confirm-fulfill"]')){void window.confirmFulfillment();}
    });
    window.render();
  });
  await page.locator('[data-action="confirm-fulfill"]').click();
  await page.waitForFunction(()=>Boolean(window.pickupResolve));
  assert.equal(await page.locator('.fulfillment-load-screen').isVisible(),true);
  assert.equal(await page.locator('.fulfillment-photo-card').isVisible(),true);
  assert.equal(await page.locator('[data-load-posting-status]').count(),0);
  assert.equal(await page.locator('[data-fulfillment-upload-elapsed]').count(),1);
  assert.equal(await page.locator('[data-action="confirm-fulfill"]').isDisabled(),true);
  assert.equal(await page.locator('[data-action="add-fulfillment-photo"]').isDisabled(),true);
  await page.evaluate(()=>{window.fulfillmentStartedAt=Date.now()-12000;});
  await page.waitForFunction(()=>/\(1[23]s\)/u.test(document.querySelector('[data-fulfillment-upload-elapsed]').textContent));
  await page.screenshot({path:'test-artifacts/operator-pickup-inline-wait/desktop-waiting.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('.fulfillment-photo-card').isVisible(),true);
  assert.equal(await page.locator('[data-fulfillment-upload-elapsed]').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.screenshot({path:'test-artifacts/operator-pickup-inline-wait/phone-waiting.png',fullPage:true});
  await page.evaluate(()=>window.confirmFulfillment());
  assert.equal(await page.evaluate(()=>window.pickupPosts),1);
  await page.evaluate(()=>window.pickupResolve({pickupStatus:'loaded',remainingLines:0,operatorNetSuitePosting:{transactions:[]}}));
  await page.waitForFunction(()=>window.fulfillmentResult?.pickupStatus==='loaded' && !window.fulfillmentSubmitting);
  assert.equal(await page.locator('[data-action="finish-fulfill"]').first().isVisible(),true);
  assert.equal(await page.evaluate(()=>window.fulfillmentProgressTimer),null);
  const result={passed:true,viewports:[1280,390],sameLoadPage:true,oneLiveTimer:true,verificationPanelAbsent:true,
    duplicateSubmitBlocked:true,completionPreserved:true};
  await writeFile('test-artifacts/operator-pickup-inline-wait/browser.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
} finally {await browser.close();}
