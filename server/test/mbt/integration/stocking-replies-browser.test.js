/* global window, document, localStorage, EventTarget, MessageEvent, MutationObserver */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
let browser;const measured=[];
before(async()=>{browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});});
after(async()=>{await browser?.close();await mkdir('test-artifacts/stocking-replies-20261006',{recursive:true});await writeFile('test-artifacts/stocking-replies-20261006/browser-coverage.json',JSON.stringify(measured));});
const yards=[{locationId:1,yardCode:'3445'},{locationId:28,yardCode:'2967'},{locationId:15,yardCode:'12441'},{locationId:26,yardCode:'150'}];
const record=(purchase=false)=>({id:1,requestRef:'REQ-1',revision:1,requestType:'regular',workflowVersion:2,requestedBy:'viewer',requestedByName:'Sales at 150',destinationLocationId:1,destinationName:'3445',bucket:'pending',status:'submitted',displayStatus:'pending',
  regular:{deliveryMethod:'stocking',stockingType:purchase?'purchase':'transfer',requestingLocationId:26,approval:{automatic:false,lines:[]}},
  lines:[{id:10,itemId:101,itemName:'Item A',salesQty:20,salesUom:'EA',toPcs:1,toPlt:100,pieces:20,sourceLocationId:28,sourceName:'2967',destinationLocationId:1,destinationName:'3445',status:'submitted'}],transfers:[],events:[],availability:[]});
async function fixture(audience,{purchase=false,reply=false,pendingTo=false}={}){
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await context.addInitScript(pending=>{
    localStorage.setItem('mbbs.staff.token','reply-test');localStorage.setItem('mbbs.sales.stockRequests.bucket','pending');localStorage.setItem('mbbs.scm.stockRequests.queue',pending?'pending_to':'request');
    window.replyEvents=[];window.EventSource=class extends EventTarget{constructor(){super();window.replyEvents.push(this);}close(){this.closed=true;}};
  },pendingTo);
  const page=await context.newPage();page.setDefaultTimeout(5000);
  await page.coverage.startJSCoverage({resetOnNavigation:false});
  const state={r:record(purchase),calls:[],errors:[],alerts:{requests:[],total:0,unread:0}};
  if(reply){state.r.displayStatus='pending_update';state.r.regular.replyStatus='pending_update';state.r.regular.reply={audience:'scm',message:'Use the next load.',eta:null};state.r.events=[{id:2,eventType:'regular_scm_reply',actorName:'SCM',createdAt:'2026-10-06T00:00:00Z',details:state.r.regular.reply}];}
  if(pendingTo){
    state.r.status='active';state.r.bucket='accepted';state.r.regular.pickupTransfer={status:'complete',plan:{action:{mode:'pickup',requestRef:'REQ-1',destinationName:'3445',routes:[]}}};
    state.r.transfers=[{id:1,transferRef:'SRTO-1',revision:1,status:'pending_receipt',sourceLocationId:28,sourceName:'2967',destinationLocationId:1,destinationName:'3445',netsuiteTransferOrderRef:'TO-1',lines:state.r.lines}];
  }
  page.on('pageerror',e=>state.errors.push(e.message));
  await page.route('**/*',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.startsWith('/api/')){
      const method=route.request().method();state.calls.push({path,method,body:route.request().postDataJSON()});
      if(path==='/api/auth/me')return route.fulfill({json:{operator:{id:'viewer',display_name:'Viewer',role:audience,roles:[audience],yardLocationIds:[26]}}});
      if(path==='/api/navigation/menu-order')return route.fulfill({json:{revision:1,orders:{}}});
      if(path.endsWith('/alerts'))return route.fulfill({json:state.alerts});
      if(path===`/api/${audience}/stock-requests`){
        if(method==='POST'){state.r={...state.r,...route.request().postDataJSON()};return route.fulfill({status:201,json:state.r});}
        return route.fulfill({json:{requests:[state.r],yards:[yards[3]],stockingYards:yards,filterOptions:{vendors:[],sourceYards:[],destinationYards:[]}}});
      }
      if(path.endsWith('/1/reply')){
        const body=route.request().postDataJSON();state.r.revision++;
        state.r.regular.reply={...body,audience,eta:body.eta||null,salesOrderRef:body.salesOrderRef||null};state.r.regular.replyStatus=audience==='scm'?'pending_update':'pending_scm';state.r.displayStatus=state.r.regular.replyStatus;
        state.r.events.unshift({id:state.r.revision+1,eventType:`regular_${audience}_reply`,actorName:'Viewer',createdAt:'2026-10-06T01:00:00Z',details:state.r.regular.reply});
        return route.fulfill({json:state.r});
      }
      if(path===`/api/${audience}/stock-requests/1`)return route.fulfill({json:state.r});
      if(path.endsWith('/stock-request-items'))return route.fulfill({json:{items:[{itemId:101,itemCode:'Item A',stockUnit:'EA',toPcs:1,toPlt:100}]}});
      if(path.endsWith('/availability/refresh'))return route.fulfill({json:{item:{itemId:101,itemCode:'Item A',stockUnit:'EA',toPcs:1,toPlt:100},yards:yards.map(y=>({...y,requestableAvailable:1000,liveAvailable:1000}))}});
      return route.fulfill({json:{requests:[],count:0,total:0,orders:[],enabled:true,revision:1}});
    }
    const file=({'/sales/stock-requests':'/sales-stock-requests.html','/scm/stock-requests':'/scm-stock-requests.html'})[path]||path;
    try{return route.fulfill({body:await readFile('public'+file),contentType:({js:'application/javascript',css:'text/css',html:'text/html',svg:'image/svg+xml'})[file.split('.').at(-1)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
  });
  await page.goto(`http://localhost/${audience}/stock-requests?tab=regular`);await expect(page.locator('.stock-request-detail h2')).toHaveText(pendingTo?'REQ-1 · SRTO-1':'REQ-1');await page.waitForLoadState('networkidle');
  return {page,state,close:async()=>{measured.push(...await page.coverage.stopJSCoverage());await context.close();}};
}
async function update(page){await page.evaluate(()=>{for(const stream of window.replyEvents.filter(s=>!s.closed))stream.dispatchEvent(new MessageEvent('app-event',{data:JSON.stringify({type:'stock-request.updated',payload:{requestId:1}})}));});}

test('Stocking enables all supported destination yards for 150 while Pickup keeps its assigned yard',async()=>{
  const f=await fixture('sales');try{
    await f.page.locator('[data-sales-stock-action="new"]').click();await f.page.locator('[data-regular-field="deliveryMethod"]').selectOption('stocking');
    const yard=f.page.locator('[data-sales-stock-destination]');await expect(yard).toBeEnabled();await expect(yard.locator('option')).toHaveCount(4);await yard.selectOption('1');await expect(yard).toHaveValue('1');
    await f.page.locator('[data-regular-field="stockingType"]').selectOption('purchase');await expect(yard).toHaveValue('1');
    await f.page.locator('[data-regular-field="deliveryMethod"]').selectOption('pickup');await expect(yard).toHaveValue('26');await expect(yard).toBeDisabled();assert.deepEqual(f.state.errors,[]);
  }finally{await f.close();}
});
for(const purchase of [false,true])test(`SCM ${purchase?'Purchase':'Transfer'} Reply saves free text with no ETA and survives background updates`,async()=>{
  const f=await fixture('scm',{purchase});try{
    await f.page.locator('[data-scm-stock-action="reply"]').click();const text=f.page.locator('[data-regular-reply-field="message"]');await text.fill('Call Sales first.\nNext load <script>alert(1)</script>');
    await f.page.evaluate(()=>{window.replyFrozen={pool:document.querySelector('.stock-request-list'),text:document.querySelector('[data-regular-reply-field="message"]')};});
    await update(f.page);await expect(f.page.locator('[data-stock-background-update]')).toBeVisible();assert.equal(await f.page.evaluate(()=>window.replyFrozen.pool===document.querySelector('.stock-request-list')&&window.replyFrozen.text===document.querySelector('[data-regular-reply-field="message"]')),true);await expect(text).toHaveValue('Call Sales first.\nNext load <script>alert(1)</script>');
    await f.page.locator('[data-regular-reply-form] button[type="submit"]').click();await expect(f.page.locator('[data-regular-reply-history]')).toContainText('Next load <script>alert(1)</script>');
    const sent=f.state.calls.find(call=>call.path.endsWith('/1/reply'));assert.equal(sent.body.eta,'');assert.equal(sent.body.expectedRevision,1);await expect(f.page.locator('.stock-request-detail .stock-request-heading')).toContainText('Pending update');assert.deepEqual(f.state.errors,[]);
  }finally{await f.close();}
});
test('Sales responds to SCM instructions with an optional SO and retained unsaved text',async()=>{
  const f=await fixture('sales',{reply:true,purchase:true});try{
    await f.page.locator('[data-sales-stock-action="reply"]').click();const text=f.page.locator('[data-regular-reply-field="message"]');await text.fill('Confirmed for the customer.');await f.page.locator('[data-regular-reply-field="salesOrderRef"]').fill('SO-123');
    await update(f.page);await expect(text).toHaveValue('Confirmed for the customer.');await f.page.locator('[data-regular-reply-form] button[type="submit"]').click();
    await expect(f.page.locator('[data-regular-reply-history]')).toContainText('SO-123');await expect(f.page.locator('.stock-request-detail .stock-request-heading')).toContainText('Pending SCM review');assert.deepEqual(f.state.errors,[]);
  }finally{await f.close();}
});
test('Sales top-bar and popup alert reply and Resolve once per event without changing the pool',async()=>{
  const f=await fixture('sales');try{
    await f.page.evaluate(()=>{window.poolBeforeAlert=document.querySelector('.stock-request-list');});
    f.state.alerts={total:1,unread:1,requests:[{id:1,requestRef:'REQ-1',eventId:5,action:'reply',message:'Next load.',eta:null}]};await update(f.page);
    const popup=f.page.locator('dialog.regular-stock-popup');await expect(popup).toBeVisible();await expect(popup).toContainText('Next load.');await expect(f.page.locator('.regular-stock-alert')).toContainText('1');
    await popup.locator('button').click();await update(f.page);await expect(popup).toHaveCount(0);await expect(f.page.locator('.regular-stock-alert')).toBeVisible();
    f.state.alerts.requests=[{id:1,requestRef:'REQ-1',eventId:6,action:'resolve',purchaseOrderRef:'PO-321',eta:'2026-10-20'}];await update(f.page);await expect(popup).toBeVisible();await expect(popup).toContainText('PO-321');await expect(popup).toContainText('2026-10-20');
    assert.equal(await f.page.evaluate(()=>window.poolBeforeAlert===document.querySelector('.stock-request-list')),true);assert.deepEqual(f.state.errors,[]);
  }finally{await f.close();}
});
test('Stocking instructions remain available for SCM in Pending TO without changing the Transfer Order',async()=>{
  const f=await fixture('scm',{reply:true,pendingTo:true});try{
    await expect(f.page.locator('[data-regular-reply-history]')).toContainText('Use the next load.');
    await f.page.locator('[data-scm-stock-action="reply"]').click();await f.page.locator('[data-regular-reply-field="message"]').fill('Call Sales before delivery.');
    await f.page.locator('[data-regular-reply-form] button[type="submit"]').click();await expect(f.page.locator('[data-regular-reply-history]')).toContainText('Call Sales before delivery.');
    await expect(f.page.locator('.stock-request-detail .stock-request-heading')).toContainText('Pending update');assert.equal(f.state.r.transfers[0].netsuiteTransferOrderRef,'TO-1');assert.equal(f.state.r.transfers[0].status,'pending_receipt');assert.deepEqual(f.state.errors,[]);
  }finally{await f.close();}
});
