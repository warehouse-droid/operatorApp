/* global localStorage, window, StorageEvent, structuredClone, Event, EventTarget, MessageEvent */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const out=process.env.SPECIAL_PO_REFERENCE_BROWSER_OUTPUT || 'test-artifacts/special-po-reference-20261001/browser';
let browser,capture=0;
before(async()=>{await mkdir(out,{recursive:true});browser=await chromium.launch({headless:true,args:['--no-sandbox']});});
after(async()=>browser?.close());
const notice=(method='vendor_pickup',id=17)=>({requestId:id,requestRef:'SPREQ-0000'+id,displayRef:'POB03976 / SN1401857',
  fulfillmentMethod:method,audience:method==='vendor_pickup'?'sales':'dispatch',noticeKey:String(id).padStart(64,'0')});
async function fixture({role='sales',publicSales=false,width=1440,existingDialog=false,fullSales=false}={}){
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
  await context.addInitScript(()=>{localStorage.setItem('mbbs.staff.token','first-user');window.EventSource=class extends EventTarget{
    constructor(){super();window.poRefEvents=this;this.listeners={};}
    addEventListener(type,fn,options){super.addEventListener(type,fn,options);this.listeners[type]=(event={})=>this.dispatchEvent(new MessageEvent(type,event));}
    close(){} };
  });
  const page=await context.newPage();page.setDefaultTimeout(5000);await page.coverage.startJSCoverage({resetOnNavigation:false});
  const state={role,publicSales,calls:0,acks:[],status:200,ackStatus:200,alerts:[notice(role==='dispatcher'?'yard_pickup':'vendor_pickup')],hold:null,errors:[]};
  const record={id:17,requestRef:'SPREQ-000017',revision:32,status:'active',stage:'dispatch_arrangement',closeStatus:'active',
    storeLocationId:1,storeName:'3445',customerName:'TEST Customer',vendorName:'TEST Vendor',fulfillmentMethod:'yard_pickup',
    inquiryDate:'2099-01-01',expiresOn:'2099-03-01',purchaseOrderId:1030348,purchaseOrderRef:'POB03976',purchaseOrderReference:'SN1401857',
    salesOrderId:1030100,salesOrderRef:'SOB121819',salesOrderApproved:true,purchaseOrderApproved:true,palletTotal:1,palletRate:40,
    lines:[{id:10,productName:'Stone',quantity:2,uom:'PLT',originalRate:100,discountPercent:0,supplyStatus:'in_stock',salesDecision:'accepted',vendorYard:'West'}],
    salesOrderLines:[],purchaseOrderLines:[],media:[],events:[],readinessAlerts:[]};
  page.on('pageerror',error=>state.errors.push(error.message));
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    if(url.hostname!=='localhost')return route.abort();
    if(path==='/api/auth/me' && state.authAbort)return route.abort();
    if(path==='/api/auth/me')return route.fulfill({status:state.authStatus||200,json:{operator:{id:'test',role:state.role,roles:[state.role],publicSales:state.publicSales,yardLocationIds:[1]}}});
    if(path.includes('/po-reference-alerts')){
      if(request.method()==='POST'){
        state.acks.push({path,body:request.postDataJSON(),token:request.headers().authorization});
        if(state.ackAbort)return route.abort();
        if(state.ackStatus===200)state.alerts=state.alerts.filter(a=>a.noticeKey!==request.postDataJSON().noticeKey);
        return route.fulfill({status:state.ackStatus,json:state.ackStatus===200?{acknowledged:true}:{error:'Reference changed. Refresh and review the latest reference.'}});
      }
      state.calls++;if(state.listAbort)return route.abort();const payload={alerts:structuredClone(state.alerts)},status=state.status;
      if(state.hold)await state.hold;return route.fulfill({status,json:payload}).catch(()=>{});
    }
    if(path.startsWith('/api/')){
      if(path.endsWith('/policy'))return route.fulfill({json:{enabled:true}});
      if(path.endsWith('/special-stock-requests'))return route.fulfill({json:{yards:[{locationId:1,yardCode:'3445'}],vendors:['TEST Vendor'],requests:[record]}});
      if(path.endsWith('/special-stock-requests/17'))return route.fulfill({json:record});
      if(path.endsWith('/alerts'))return route.fulfill({json:{awaitCustomerConfirmation:0,dispatchArrangement:0,waitForProduction:0,total:0}});
      return route.fulfill({json:{requests:[],yards:[],total:0,salesReps:[]}});
    }
    if(path==='/preview')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="UTF-8"></head><body><header class="topbar"><div class="topbar-actions"><button id="prior">Previous focus</button></div></header>${existingDialog?'<dialog open id="existing">Editing items</dialog>':''}<script type="module" src="/special-po-reference-alert.js"></script></body></html>`});
    const file=path==='/sales/stock-requests'?'/sales-stock-requests.html':path;
    try{return route.fulfill({body:await readFile('public'+file),contentType:({js:'application/javascript',css:'text/css',html:'text/html'})[file.split('.').at(-1)]||'application/octet-stream'});}
    catch{return route.fulfill({status:404,body:''});}
  });
  if(fullSales)state.alerts=[];
  await page.goto('http://localhost/'+(fullSales?'sales/stock-requests?tab=special&search=SPREQ-000017':'preview'));
  return {page,state,record,close:async()=>{assert.deepEqual(state.errors,[]);await writeFile(`${out}/coverage-${++capture}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}};
}
const refresh=page=>page.evaluate(()=>window.MBBSPoReferenceAlert.refresh());
for(const [method,instruction] of [['mbt_delivery','Your special order is queued for delivery.'],['yard_pickup','Your special order is queued for customer pickup at our yard.']]) {
  test(`Sales delivery alert: ${method} shows the reference and correct Dispatch instruction across pages`,async()=>{
    const {page,state,close}=await fixture({width:390});
    try {
      const dialog=page.getByRole('dialog',{name:'PO Ref received'});
      await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'Acknowledge'}).click();
      state.alerts=[{...notice(method,43),requestRef:'SPREQ-000043',displayRef:'POB03993 / LOINC-037994',audience:'sales'}];
      await refresh(page);await expect(dialog).toContainText('SPREQ-000043 · POB03993 / LOINC-037994');
      await expect(dialog).toContainText(instruction);
      await expect(dialog).not.toContainText('pickup at vendor yard');
      await expect(dialog.getByRole('link',{name:'Open request'})).toHaveAttribute('href','/sales/stock-requests?tab=special&search=SPREQ-000043');
      await page.reload();await expect(dialog).toContainText(instruction);
      await dialog.screenshot({path:`${out}/sales-${method}.png`});
      await dialog.getByRole('button',{name:'Acknowledge'}).click();await expect(dialog).toHaveCount(0);
      assert.equal(state.acks.at(-1).path,'/api/sales/special-stock-requests/po-reference-alerts/43/ack');
    }finally{await close();}
  });
}
test('Sales center popup shows the combined PO ref and vendor pickup instruction; acknowledgement persists on refresh',async()=>{
  const {page,state,close}=await fixture();try{
    const dialog=page.getByRole('dialog',{name:'PO Ref received'});await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('POB03976 / SN1401857');await expect(dialog).toContainText('pickup at vendor yard');
    await expect(dialog.getByRole('link',{name:'Open request'})).toHaveAttribute('href','/sales/stock-requests?tab=special&search=SPREQ-000017');
    await dialog.screenshot({path:out+'/sales-popup.png'});
    await dialog.getByRole('button',{name:'Acknowledge'}).click();await expect(dialog).toHaveCount(0);
    assert.equal(state.acks.length,1);assert.equal(state.acks[0].body.noticeKey,notice().noticeKey);
    await refresh(page);await expect(dialog).toHaveCount(0);
    state.alerts=[{...notice(),noticeKey:'f'.repeat(64),displayRef:'POB03976 / NEW'}];
    await page.evaluate(()=>window.poRefEvents.listeners['app-event']({data:JSON.stringify({type:'scm.schedule.updated'})}));
    await expect(dialog).toContainText('POB03976 / NEW');await dialog.getByRole('button',{name:'Acknowledge'}).click();
  }finally{await close();}
});
test('Dispatch popup handles delivery and our-yard pickup in one queue on a phone without acknowledging on Escape',async()=>{
  const {page,state,close}=await fixture({role:'dispatcher',width:390});try{
    const dialog=page.getByRole('dialog',{name:'PO Ref received'});await expect(dialog).toContainText('pickup at our yard');
    await expect(dialog).toContainText('Dispatch');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await dialog.screenshot({path:out+'/dispatch-phone.png'});await page.keyboard.press('Escape');await expect(dialog).toBeVisible();assert.equal(state.acks.length,0);
    state.alerts.push(notice('mbt_delivery',20));await refresh(page);
    await dialog.getByRole('button',{name:'Acknowledge'}).click();await expect(dialog).toContainText('delivery');
    await dialog.getByRole('button',{name:'Acknowledge'}).click();await expect(dialog).toHaveCount(0);
    assert.ok(state.acks.every(a=>a.path.startsWith('/api/dispatch/')));
  }finally{await close();}
});
test('failed acknowledgement retains popup and retries, temporary fetch failure retains alerts, invalid payload and disabled workflow clear no business data',async()=>{
  const {page,state,close}=await fixture();try{
    const dialog=page.getByRole('dialog',{name:'PO Ref received'});await expect(dialog).toBeVisible();
    state.ackStatus=500;await dialog.getByRole('button',{name:'Acknowledge'}).click();await expect(dialog.getByRole('status')).toContainText('Reference changed');await expect(dialog.getByRole('button',{name:'Acknowledge'})).toBeEnabled();
    state.status=500;await refresh(page);await expect(dialog).toBeVisible();
    state.status=200;const original=state.alerts;state.alerts=[{requestId:0}];await refresh(page);await expect(dialog).toBeVisible();state.alerts=original;
    state.ackStatus=409;await dialog.getByRole('button',{name:'Acknowledge'}).click();await expect(dialog).toBeVisible();
    state.ackStatus=200;await dialog.getByRole('button',{name:'Acknowledge'}).click();await expect(dialog).toHaveCount(0);
    state.status=404;await refresh(page);await expect(dialog).toHaveCount(0);
  }finally{await close();}
});
test('session switch or denied authority clears popup and drops a late old-session response',async()=>{
  const {page,state,close}=await fixture();let release;try{
    const dialog=page.getByRole('dialog',{name:'PO Ref received'});await expect(dialog).toBeVisible();
    state.hold=new Promise(resolve=>{release=resolve;});const before=state.calls;await page.evaluate(()=>void window.MBBSPoReferenceAlert.refresh());await expect.poll(()=>state.calls).toBe(before+1);
    state.role='scm';await page.evaluate(()=>{localStorage.setItem('mbbs.staff.token','second-user');window.dispatchEvent(new StorageEvent('storage',{key:'mbbs.staff.token'}));});
    release();state.hold=null;await expect(dialog).toHaveCount(0);await refresh(page);await expect(dialog).toHaveCount(0);
    state.role='sales';await page.evaluate(()=>window.dispatchEvent(new Event('mbbs-auth-operator-changed')));await expect(dialog).toBeVisible();
    state.status=403;await refresh(page);await expect(dialog).toHaveCount(0);
  }finally{release?.();await close();}
});
test('notice text is safe and an existing editor dialog delays popup until it closes',async()=>{
  const {page,state,close}=await fixture({existingDialog:true});try{
    await expect.poll(()=>state.calls).toBeGreaterThan(0);await expect(page.locator('.special-po-reference-dialog')).toHaveCount(0);
    state.alerts=[{...notice(),displayRef:'POB03976 / <img src=x onerror="window.injected=true">'}];await refresh(page);
    await page.evaluate(()=>document.getElementById('existing').remove());await refresh(page);
    const dialog=page.getByRole('dialog',{name:'PO Ref received'});await expect(dialog).toBeVisible();await expect(dialog.locator('img')).toHaveCount(0);
    assert.equal(await page.evaluate(()=>window.injected),undefined);
    await dialog.getByRole('button',{name:'Acknowledge'}).click();
  }finally{await close();}
});
for(const [role,publicSales] of [['scm',false],['sales',true]])test(`${role}${publicSales?' public':''} cannot fetch PO reference alerts`,async()=>{
  const {page,state,close}=await fixture({role,publicSales});try{await page.waitForTimeout(100);assert.equal(state.calls,0);await expect(page.locator('.special-po-reference-dialog')).toHaveCount(0);}finally{await close();}
});
test('real Sales request UI renders POB03976 / SN1401857 and the alert loader is installed by the shared header',async()=>{
  const {page,record,close}=await fixture({fullSales:true});try{
    await expect(page.locator('.special-sales-order-documents')).toContainText('POB03976 / SN1401857');
    assert.equal(await page.evaluate(()=>typeof window.MBBSPoReferenceAlert.refresh),'function');assert.equal(record.purchaseOrderReference,'SN1401857');
    await page.locator('.special-sales-order-documents').screenshot({path:out+'/sales-po-reference.png'});
  }finally{await close();}
});

test('network errors keep the notice retryable and logout clears the pending popup',async()=>{
  const {page,state,close}=await fixture();try{
    const dialog=page.getByRole('dialog',{name:'PO Ref received'});await expect(dialog).toBeVisible();
    state.ackAbort=true;await dialog.getByRole('button',{name:'Acknowledge'}).click();await expect(dialog.getByRole('status')).toContainText('Please retry');
    state.listAbort=true;await refresh(page);await expect(dialog).toBeVisible();state.listAbort=false;state.ackAbort=false;
    await page.evaluate(()=>window.poRefEvents.listeners['app-event']({data:'invalid json'}));
    await page.evaluate(()=>window.poRefEvents.listeners.open());await expect(dialog).toBeVisible();
    await page.evaluate(()=>{localStorage.removeItem('mbbs.staff.token');window.dispatchEvent(new StorageEvent('storage',{key:null}));});await expect(dialog).toHaveCount(0);
    state.authAbort=true;await page.evaluate(()=>{localStorage.setItem('mbbs.staff.token','third-user');window.dispatchEvent(new Event('mbbs-auth-operator-changed'));});
    await page.waitForTimeout(100);await expect(dialog).toHaveCount(0);
    state.authAbort=false;state.authStatus=401;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(100);await expect(dialog).toHaveCount(0);
  }finally{await close();}
});
