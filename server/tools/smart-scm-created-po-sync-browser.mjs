import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { projectSmartScmCreatedPo } from "../src/smart-scm-created-po.js";
import { scmNetSuitePoVersion } from "../src/scm-netsuite-po-version.js";

const directory="test-artifacts/smart-scm-created-po-sync";
const current={header:{history_id:55,vendor:'PERMACON',status_text:'Pending Receipt',truck_capacity_lbs:78000,synced_at:new Date().toISOString()},lines:[
  {line_id:4953527,item_id:4778,item_name:'PER-MEL80S-RDM-NG',quantity:932.8,pallet_qty:10,to_plt:93.28,unit:'SQFT',rate:4.56,amount:4253.57,item_weight:40.55,location_id:28,location:'2967'},
  {line_id:4953528,item_id:4775,item_name:'PER-MEL80S-RDM-AB',quantity:466.4,pallet_qty:5,to_plt:93.28,unit:'SQFT',rate:4.96,amount:2313.34,item_weight:40.55,location_id:28,location:'2967'},
  {line_id:4953529,item_id:4795,item_name:'PER-MEL60S-RDM-AB',quantity:932.8,pallet_qty:8,to_plt:116.6,unit:'SQFT',rate:3.67,amount:3423.38,item_weight:29.08,location_id:28,location:'2967'},
  {line_id:4953530,item_id:1784,item_name:'PALLET',quantity:23,unit:'EACH',rate:35,amount:805,item_weight:40,location_id:28,location:'2967'}
]};
const proposal={...projectSmartScmCreatedPo({id:34352,lines:[],physicalPalletLines:[]},current),
  workflowId:8072,workflowKind:'regular_po',workflowStatus:'po_created',status:'completed',
  netsuitePurchaseOrderId:991607,netsuitePurchaseOrderRef:'POB03875',canMoveToHistory:true,canEditVendorReply:false};
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
  const page=await browser.newPage({viewport:{width:1600,height:1000}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.setContent('<main class="smart-shell" id="smartScmApp"></main>');
  for(const css of ['dispatch.css','scm-smart.css','scm-smart-vendor.css']) await page.addStyleTag({path:`public/${css}`});
  await page.evaluate((record)=>{
    window.record=record;
    window.apiCalls=[];
    window.smartState={tab:'vendors',busy:'',data:{yards:[]},vendorReplyLoads:[record]};
    window.smartScmApp=document.getElementById('smartScmApp');
    window.smartCanWrite=()=>true;
    window.smartNumber=(value,places=1)=>new Intl.NumberFormat('en-CA',{maximumFractionDigits:places}).format(Number(value));
    window.smartEscape=(value)=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
    window.smartPill=(_value,label)=>label||'';
    window.smartDate=()=>'';
    window.smartApi=async (url,options)=>{window.apiCalls.push({url,options});return url.includes('vendor-reply-loads?') ? [record] : {};};
    window.smartWork=async (_label,fn)=>fn();
    window.smartRender=()=>{window.smartScmApp.innerHTML=window.smartVendorLoadCard(record);};
  },proposal);
  await page.addScriptTag({path:'public/scm-smart-vendor.js'});
  await page.evaluate(()=>window.smartRender());
  assert.equal(await page.getByRole('link',{name:'View / Edit PO'}).getAttribute('href'),'/scm/netsuite-po?historyId=55');
  assert.equal(await page.getByText('PER-MEL60S-RDM-AB',{exact:true}).count(),1);
  assert.equal(await page.getByText('PER-MEL60-COP-AB',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Sync from NetSuite'}).click();
  assert.equal(await page.evaluate(()=>window.apiCalls[0].url),'/api/scm/netsuite-po-history/55/refresh');
  await page.screenshot({path:`${directory}/vendor-replies.png`,fullPage:true});

  const editor=await browser.newPage({viewport:{width:1500,height:1000}});
  editor.on('pageerror',error=>errors.push(error.message));
  const history={id:55,purchaseOrderRef:'POB03875',purchaseOrderId:991607,archived:false,archivedAt:null,
    remoteLastModifiedAt:'2026-09-15',lastSyncedAt:new Date().toISOString(),current:{
      tranid:'POB03875',transactionDate:'2026-09-15',vendor:'PERMACON',vendorId:8115,status:'B',statusText:'Pending Receipt',active:true,memo:'Old memo',lines:[]
    }};
  history.version=scmNetSuitePoVersion(history);
  const patches=[];
  await editor.route('http://scm.test/**',async route=>{
    const request=route.request();
    if(request.url().includes('/api/')) {
      if(request.method()==='PATCH') {patches.push(request.postDataJSON());}
      const body=request.url().includes('/options') ? {vendors:[],vendorYards:[],destinations:[]}
        : /\/55(?:\/refresh)?$/.test(request.url()) ? history : {records:[],total:0};
      await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    } else {await route.fulfill({contentType:'text/html',body:'<main id="smartNetSuitePoApp"></main>'});}
  });
  await editor.goto('http://scm.test/scm/netsuite-po?historyId=55');
  await editor.evaluate(()=>{
    delete window.EventSource;
    window.requireDispatchLogin=({onReady})=>{window.ready=onReady;};
  });
  for(const css of ['dispatch.css','scm-smart.css','scm-netsuite-po.css']) await editor.addStyleTag({path:`public/${css}`});
  await editor.addScriptTag({path:'public/scm-netsuite-po.js'});
  await editor.evaluate(()=>window.ready({role:'scm',display_name:'SCM test'}));
  await editor.locator('[data-head-field="memo"]').fill('Updated from the application');
  await editor.getByRole('button',{name:'Save to NetSuite',exact:true}).click();
  await editor.waitForFunction(()=>!document.querySelector('.smart-notice')?.textContent.includes('Saving changes'));
  assert.equal(patches.length,1);
  assert.equal(patches[0].expectedVersion,history.version);
  assert.equal(patches[0].header.memo,'Updated from the application');
  await editor.screenshot({path:`${directory}/po-editor.png`,fullPage:true});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({vendorCurrentItems:true,manualRefresh:true,linkedEditor:true,versionedSave:true,browserErrors:errors.length}));
} finally {await browser.close();}
