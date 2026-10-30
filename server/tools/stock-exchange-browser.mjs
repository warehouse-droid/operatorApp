/* global window, document */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
const source=readFileSync('public/operator.js','utf8');
function extract(name){
  const start=source.search(new RegExp(`(?:async )?function ${name}\\(`));assert.ok(start>=0,name);
  const end=source.slice(start+1).search(/\n(?:async )?function /);
  return source.slice(start,end<0?undefined:start+1+end);
}
const browser=await chromium.launch({args:['--no-sandbox']});
try{
  for(const width of [390,1024]){
    const page=await browser.newPage({viewport:{width,height:844}});
    await page.setContent(`<style>${readFileSync('public/operator.css','utf8')}\n${readFileSync('public/operator-phone.css','utf8')}</style><main id="app"></main>`);
    await page.evaluate(()=>{
      Object.assign(window,{
        currentModule:'return-select',returnMode:'stock',returnType:'quality',locationId:1,operator:{display_name:'Test operator'},
        currentLocation:()=>({text:'3445'}),t:(_key,fallback)=>fallback,escapeHtml:String,localizeMessage:String,
        shell:(_title,_sub,body)=>{document.getElementById('app').innerHTML=body;},
        returnBusy:false,returnScannerActive:false,cameraOpenLabel:()=> 'Open Camera',renderCameraSwitchButton:()=>'',
        cameraFacingMode:'environment',returnLookupCode:'SOB123',operatorDisplaySettings:{inputMode:()=> 'text'},
        OperatorOrderKeypad:{html:()=>''},returnDraftId:'draft-1',returnIdempotencyKey:'browser-exchange',
        returnPalletQuantity:0,returnVehiclePlate:'',returnHeaderNote:'',returnPalletPhotos:[],returnRecordPhotos:[],
        returnOrderId:()=>123,returnOrderRef:()=> 'SOB123',returnCustomerId:()=>1,returnCustomer:()=>({id:1}),returnOrder:()=>({id:123}),
        returnLookupData:{},returnPayloadLines:()=>[{sourceLineId:1,salesQuantity:2,reasonId:5}],
        returnSelectedRows:()=>[{}],returnPostingPolicies:{stock_exchange:{gateKey:'operator_netsuite_stock_exchange_it_3445',revision:1,effective:true}},
        returnResult:{stockExchange:{id:1,reference:'SE-000001',workflowVersion:2,recordType:'exchange',netSuiteStage:'inventory_transfer',
          netSuiteSyncStatus:'succeeded',netSuiteTransactionRef:'IT123'}}
      });
    });
    await page.addScriptTag({content:['renderReturnSelect','renderReturnLookup','returnModuleTitle','buildReturnPayload','returnPostingFunctions',
      'operatorNetSuitePolicyToken','returnNetSuiteResultLabel','renderReturnSuccess'].map(extract).join('\n')});
    await page.evaluate(()=>{
      window.renderReturnSelect();
      document.getElementById('app').addEventListener('click',event=>{
        const button=event.target.closest('[data-module]');
        if(button){window.currentModule=button.dataset.module;document.getElementById('app').innerHTML=window.renderReturnLookup();}
      });
    });
    assert.equal(await page.locator('[data-module]').count(),3);
    const exchange=page.getByRole('button',{name:/Stock exchange/});
    const box=await exchange.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);
    await exchange.click();
    assert.equal(await page.locator('[data-return-type="normal"]').count(),0);
    assert.equal(await page.locator('#returnOrderLookup').inputValue(),'SOB123');
    const payload=await page.evaluate(()=>window.buildReturnPayload());
    assert.equal(payload.returnMode,'exchange');assert.equal(payload.stockReturnType,'quality');
    assert.ok(payload.expectedPostingPolicies.stock_exchange);
    assert.equal((await page.evaluate(()=>window.buildReturnPayload({draft:true}))).draftType,'exchange');
    await page.evaluate(()=>{document.getElementById('app').innerHTML=window.renderReturnSuccess();});
    assert.match(await page.locator('#app').innerText(),/Inventory Transfer IT123/);
    assert.match(await page.locator('#app').innerText(),/SE-000001/);
    await page.close();console.log(`browser: ${width}px exchange menu, quality selection, payload, draft and posted result passed`);
  }
}finally{await browser.close();}
