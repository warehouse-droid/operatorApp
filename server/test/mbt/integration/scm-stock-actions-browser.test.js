/* global window, document, localStorage, EventTarget, MessageEvent, MutationObserver */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
let browser;const measured=[];
before(async()=>{browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});});
after(async()=>{await browser?.close();await mkdir('test-artifacts/scm-stock-actions-20261006',{recursive:true});await writeFile('test-artifacts/scm-stock-actions-20261006/browser-coverage.json',JSON.stringify(measured));});
const yards=[{locationId:1,yardCode:'3445'},{locationId:28,yardCode:'2967'},{locationId:15,yardCode:'12441'},{locationId:26,yardCode:'150'}];
async function publicFile(file){
  if(process.env.SCM_STOCK_ACTIONS_BASELINE_UI==='1')try{return await readFile('/app/stock-view-before/public'+file);}catch{ /* Unchanged dependencies use current files. */ }
  return readFile('public'+file);
}
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
      if(path==='/api/scm/waitlist/customers')return route.fulfill({json:{customers:[{id:99,displayName:'Existing customer',entityNumber:'C-99'}]}});
      if(path==='/api/scm/waitlist/pools')return route.fulfill({json:{pools:[]}});
      if(path==='/api/scm/waitlist/requests')return route.fulfill({json:{requests:[{id:2,requestRef:'STREQ-2',revision:1,createdAt:'2026-10-06T00:00:00Z',customerId:99,customerName:'Existing customer',sellingYardId:1,sellingYard:'3445',destinationLocationId:1,itemId:101,itemCode:'Item A',itemDisplayName:'Item A',salesUom:'EA',requestedQty:20,waitingQty:20,heldQty:0,vendorKey:'none',vendorName:'',waitlist:{waitingQty:20}}]}});
      if(path==='/api/scm/waitlist/stocking-requests/1/lines/10'){
        const body=route.request().postDataJSON();state.r.revision++;
        state.r.events.unshift({id:50,eventType:'stocking_line_waitlisted',actorName:'SCM',details:{lineId:10,waitlistRequestId:2,waitlistRequestRef:'STREQ-2'}});
        state.r.lines[0].status='cancelled';state.r.status='completed';state.r.bucket='completed';state.r.displayStatus='completed';
        return route.fulfill({status:201,json:{request:state.r,waitlistRequest:{id:2,requestRef:'STREQ-2',regular:{customerId:body.customerId,deliveryMethod:'waitlist'}}}});
      }
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
    try{return route.fulfill({body:await publicFile(file),contentType:({js:'application/javascript',css:'text/css',html:'text/html',svg:'image/svg+xml'})[file.split('.').at(-1)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
  });
  await page.goto(`http://localhost/${audience}/stock-requests?tab=regular`);await expect(page.locator('.stock-request-detail h2')).toHaveText(pendingTo?'REQ-1 · SRTO-1':'REQ-1');await page.waitForLoadState('networkidle');
  return {page,state,close:async()=>{measured.push(...await page.coverage.stopJSCoverage());await context.close();}};
}
async function update(page){await page.evaluate(()=>{for(const stream of window.replyEvents.filter(s=>!s.closed))stream.dispatchEvent(new MessageEvent('app-event',{data:JSON.stringify({type:'stock-request.updated',payload:{requestId:1}})}));});}

for(const purchase of [false,true])test(`SCM ${purchase?'Purchase':'Transfer'} puts Reply in the existing action row and converts one line through customer selection`,async()=>{
  const f=await fixture('scm',{purchase});try{
    const reply=f.page.locator('[data-scm-stock-action="reply"]');await expect(reply).toHaveCount(1);
    assert.equal(await reply.evaluate(button=>button.parentElement===document.querySelector('[data-scm-stock-action="refresh-evidence"]').parentElement),true);
    await f.page.locator('[data-scm-stock-action="waitlist-line"]').click();
    const dialog=f.page.locator('dialog[data-stocking-waitlist-dialog]'),query=dialog.locator('[data-stocking-waitlist-customer-query]');await expect(dialog).toBeVisible();await query.fill('Existing');
    await update(f.page);await expect(query).toHaveValue('Existing');await dialog.locator('[data-stocking-waitlist-customer="99"]').click();
    await dialog.getByRole('button',{name:'Convert to waitlist',exact:true}).click();await expect(dialog).toHaveCount(0);
    await expect(f.page.locator('.stock-request-detail')).toContainText('Moved to waitlist');
    await expect(f.page.locator('.stock-request-detail a[href="/scm/stock-requests?tab=waitlist&requestId=2"]')).toHaveText('STREQ-2');
    const sent=f.state.calls.find(call=>call.path==='/api/scm/waitlist/stocking-requests/1/lines/10');assert.equal(sent.body.customerId,99);assert.equal(sent.body.expectedRevision,1);assert.ok(sent.body.operationKey);assert.deepEqual(f.state.errors,[]);
    measured.push(...await f.page.coverage.stopJSCoverage());await f.page.coverage.startJSCoverage({resetOnNavigation:false});
    await f.page.locator('.stock-request-detail a[href="/scm/stock-requests?tab=waitlist&requestId=2"]').click();await expect(f.page.locator('[data-waitlist-request-row="2"]')).toBeVisible();assert.deepEqual(f.state.errors,[]);
  }finally{await f.close();}
});
test('SCM Pending TO keeps Reply in the TO action row and exposes no waitlist conversion for committed lines',async()=>{
  const f=await fixture('scm',{reply:true,pendingTo:true});try{
    const reply=f.page.locator('[data-scm-stock-action="reply"]');assert.equal(await reply.evaluate(button=>button.parentElement===document.querySelector('[data-scm-stock-action="save-transfer"]').parentElement),true);
    await expect(f.page.locator('[data-scm-stock-action="waitlist-line"]')).toHaveCount(0);
  }finally{await f.close();}
});

async function smartFixture(){
  const context=await browser.newContext({viewport:{width:1920,height:1000},serviceWorkers:'block'});
  await context.addInitScript(()=>{localStorage.setItem('mbbs.staff.token','font-test');window.EventSource=class extends EventTarget{close(){}};});
  const page=await context.newPage(),errors=[];page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));await page.coverage.startJSCoverage({resetOnNavigation:false});
  await page.route('**/*',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.startsWith('/api/')){
      assert.equal(route.request().method(),'GET','Font controls must not save operational data');
      if(path==='/api/auth/me')return route.fulfill({json:{operator:{id:'font-viewer',display_name:'SCM',role:'scm',roles:['scm'],yardLocationIds:[1]}}});
      if(path==='/api/scm/smart/bootstrap')return route.fulfill({json:{settings:{executionMode:'shadow'},yards:[],vendorYards:[],syncStatus:{inventoryStatus:'ready'},planningRuns:[],latestForecasts:[],vendorReplyLoads:[]}});
      if(path==='/api/navigation/menu-order')return route.fulfill({json:{revision:4,orders:{}}});
      return route.fulfill({json:{requests:[],count:0,total:0,unread:0,orders:[],enabled:true}});
    }
    const file=path==='/scm/smart'?'/scm-smart.html':path;
    try{return route.fulfill({body:await publicFile(file),contentType:({js:'application/javascript',css:'text/css',html:'text/html',svg:'image/svg+xml'})[file.split('.').at(-1)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
  });
  await page.goto('http://localhost/scm/smart');await expect(page.locator('.smart-section-head h2').first()).toHaveText('Controlled planning cycle');await page.waitForLoadState('networkidle');
  return {page,errors,close:async()=>{measured.push(...await page.coverage.stopJSCoverage());await context.close();}};
}
test('Smart font controls scale text, preserve the current field and full width, remember size and stop at bounds',async()=>{
  const f=await smartFixture();try{
    const plus=f.page.getByRole('button',{name:'Increase font size'}),minus=f.page.getByRole('button',{name:'Decrease font size'});
    await expect(f.page.locator('[data-smart-font-value]')).toHaveText('100%');
    await f.page.locator('[data-smart-tab="plans"]').click();const field=f.page.locator('#smartPlanSearch');await field.fill('Unsaved filter');
    const original=await field.evaluate(el=>{window.fontField=el;return parseFloat(getComputedStyle(el).fontSize);});
    await plus.click();await expect(f.page.locator('[data-smart-font-value]')).toHaveText('110%');await expect(field).toHaveValue('Unsaved filter');
    assert.equal(await field.evaluate(el=>el===window.fontField),true);assert.ok(Math.abs(await field.evaluate(el=>parseFloat(getComputedStyle(el).fontSize))-original*1.1)<0.02);
    const geometry=await f.page.locator('.smart-main').evaluate(el=>({width:el.getBoundingClientRect().width,expected:innerWidth-parseFloat(getComputedStyle(document.body).paddingLeft)-30}));assert.ok(Math.abs(geometry.width-geometry.expected)<1);
    await f.page.locator('[data-smart-tab="settings"]').click();await expect(f.page.locator('[data-smart-font-value]')).toHaveText('110%');
    await f.page.reload();await expect(f.page.locator('[data-smart-font-value]')).toHaveText('110%');
    for(let i=0;i<5;i++)await plus.click();await expect(plus).toBeDisabled();await expect(f.page.locator('[data-smart-font-value]')).toHaveText('160%');
    for(let i=0;i<8;i++)await minus.click();await expect(minus).toBeDisabled();await expect(f.page.locator('[data-smart-font-value]')).toHaveText('80%');
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
