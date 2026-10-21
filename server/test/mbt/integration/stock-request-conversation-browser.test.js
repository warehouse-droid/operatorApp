/* global window,localStorage,EventTarget,document,MessageEvent */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
let browser;const coverage=[],out=process.env.CONVERSATION_TEST_ARTIFACTS||'test-artifacts/stock-request-conversation-20261016';
before(async()=>{await mkdir(out,{recursive:true});browser=await chromium.launch({headless:true,channel:'chromium',args:['--no-sandbox']});});
after(async()=>{await browser?.close();await writeFile(`${out}/browser-coverage.json`,JSON.stringify(coverage));});
function record(kind) {
 const basic={id:1,requestRef:'REQ-1',revision:1,status:'submitted',bucket:'pending',requestedBy:'viewer',destinationLocationId:1,destinationName:'3445',events:[],transfers:[],availability:[]};
 if(['special','backorder'].includes(kind))return {...basic,requestType:kind==='special'?'special':'regular',workflowKind:kind,workflowVersion:2,
   stage:'new_enquiry',storeName:'3445',storeLocationId:1,customerName:'TEST Customer',vendorName:'TEST Vendor',inquiryDate:'2099-01-01',closeStatus:'active',fulfillmentMethod:'yard_pickup',regular:{deliveryMethod:kind},
   lines:[{id:10,itemId:101,productName:'Stone',itemName:'Stone',quantity:2,uom:'PCS',salesDecision:'pending',supplyStatus:null}],salesOrderLines:[],purchaseOrderLines:[],media:[],readinessAlerts:[]};
 return {...basic,requestType:'regular',workflowVersion:2,regular:{deliveryMethod:kind==='purchase'?'stocking':kind,stockingType:kind==='purchase'?'purchase':'transfer',requestingLocationId:1,approval:{automatic:false,lines:[]}},
   lines:[{id:10,itemId:101,itemName:'Stone',salesQty:20,salesUom:'EA',toPcs:1,toPlt:100,pieces:20,sourceLocationId:28,sourceName:'2967',destinationLocationId:1,destinationName:'3445',status:'submitted'}]};
}
async function fixture(audience,kind,{alert=false,empty=false,hold=false,multiple=false}={}) {
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
 await context.addInitScript(()=>{localStorage.setItem('mbbs.staff.token','conversation-test');localStorage.setItem('mbbs.sales.stockRequests.bucket','pending');localStorage.setItem('mbbs.scm.stockRequests.queue','request');
  window.streams=[];window.EventSource=class extends EventTarget{constructor(){super();window.streams.push(this);}close(){this.closed=true;}};});
 const page=await context.newPage();page.setDefaultTimeout(3500);await page.coverage.startJSCoverage({resetOnNavigation:false});
 const state={record:record(kind),messages:[{id:'stock:1',eventId:1,audience:audience==='sales'?'scm':'sales',actorName:'Other user',message:'Please confirm <blue>.',createdAt:'2026-10-16T12:00:00Z'}],calls:[],fail:false,errors:[],alert,queueGate:Promise.resolve(),queueFailure:false};
 if(empty)state.messages=[];
 state.requests=multiple?[state.record,{...record(kind),id:2,requestRef:'REQ-2',quantityReviewPending:true}]:[state.record];
 state.gate=hold?new Promise(resolve=>{state.release=resolve;}):Promise.resolve();
 page.on('pageerror',e=>state.errors.push(e.message));
 await page.route('**/*',async route=>{
  const path=new URL(route.request().url()).pathname,method=route.request().method();
  if(path.startsWith('/api/')) {
   const body=route.request().postDataJSON();state.calls.push({path,method,body,url:route.request().url()});
   if(path==='/api/auth/me')return route.fulfill({json:{operator:{id:'viewer',display_name:'Viewer',role:audience,roles:[audience],yardLocationIds:[1]}}});
   if(path.endsWith('/stock-request-conversation-alerts'))return route.fulfill({json:{count:state.alert?1:0,requests:state.alert?[{id:2,requestRef:'REQ-2',tab:kind==='special'?'special':'regular',unreadCount:1,latestEventId:11,message:'A new message <safe>',actorName:'Alex'}]:[]}});
   if(path.endsWith('/conversation/read'))return route.fulfill({json:{ok:true}});
   if(path.endsWith('/conversation')) {
    await state.gate;
    if(method==='POST') {
     if(state.fail)return route.fulfill({status:503,json:{error:'Try again later.'}});
     if(!state.messages.some(message=>message.operationId===body.operationId))state.messages.push({...body,id:'stock:20',eventId:20,audience,actorName:'Viewer',createdAt:'2026-10-16T13:00:00Z'});
    }
    return route.fulfill({json:{messages:state.messages,canSend:true,latestEventId:state.messages.at(-1)?.eventId||0}});
   }
   if(path.endsWith('/policy'))return route.fulfill({json:{enabled:true}});
   if(/\/(?:special-)?stock-requests\/\d+$/.test(path))return route.fulfill({json:state.requests.find(row=>row.id===Number(path.split('/').at(-1)))||state.record});
   if(path.endsWith(kind==='special'?'/special-stock-requests':'/stock-requests')) {
    const requests=state.requests;await state.queueGate;
    if(state.queueFailure)return route.fulfill({status:503,json:{error:'Queue temporarily unavailable'}});
    return route.fulfill({json:{requests,yards:[{locationId:1,yardCode:'3445'}],stockingYards:[{locationId:1,yardCode:'3445'}],filterOptions:{vendors:[],sourceYards:[],destinationYards:[]}}});
   }
   return route.fulfill({json:{requests:[],count:0,total:0,orders:[],vendors:[],revision:1,enabled:true}});
  }
  const file=({'/sales/stock-requests':'/sales-stock-requests.html','/scm/stock-requests':'/scm-stock-requests.html'})[path]||path;
  try{return route.fulfill({body:await readFile('public'+file),contentType:({js:'application/javascript',css:'text/css',html:'text/html'})[file.split('.').at(-1)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto(`http://localhost/${audience}/stock-requests?tab=${kind==='special'?'special':'regular'}`);
 return {page,state,close:async()=>{coverage.push(...await page.coverage.stopJSCoverage());await context.close();}};
}
for(const audience of ['sales','scm'])for(const kind of ['special','backorder','stocking','purchase','delivery'])test(`conversation panel ${audience} ${kind} replaces legacy editors and sends typed text`,async()=>{
 const f=await fixture(audience,kind);try{
  const panel=f.page.locator('[data-stock-conversation]');await expect(panel).toBeVisible();await expect(panel.locator('[data-conversation-messages]')).toContainText('Please confirm <blue>.');
  assert.equal(await f.page.locator('[data-special-information-request-form],[data-special-information-reply-form],[data-regular-reply-form],[data-regular-reply-history],[data-sales-stock-action="reply"],[data-scm-stock-action="reply"],[data-backorder-form="information/request"]').count(),0);
  const input=panel.getByLabel('Message',{exact:true});await input.fill('Yes <img src=x onerror="window.chatXss=1">');await panel.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(panel.locator('[data-conversation-messages]')).toContainText('Yes <img');await expect(input).toHaveValue('');assert.equal(await panel.locator('img').count(),0);
  assert.equal(await f.page.evaluate(()=>window.chatXss),undefined);assert.deepEqual(f.state.errors,[]);
  if(audience==='scm'&&kind==='special'){const count=f.state.calls.filter(call=>call.path.endsWith('/special-stock-requests')).length;await f.page.locator('[data-special-scm-action="refresh"]').click();await expect.poll(()=>f.state.calls.filter(call=>call.path.endsWith('/special-stock-requests')).length).toBeGreaterThan(count);}
  if(audience==='sales'&&kind==='special')await f.page.screenshot({path:`${out}/conversation.png`,fullPage:true});
 }finally{await f.close();}
});

test('empty conversation has no loading label and accepts its first message',async()=>{
 const f=await fixture('scm','special',{empty:true,hold:true});try{
  const panel=f.page.locator('[data-stock-conversation]');await expect(panel).toBeVisible();
  await expect(panel).not.toContainText('Loading conversation');f.state.release();
  await expect(panel.locator('[data-conversation-messages]')).toHaveText('No messages yet.');
  await panel.getByLabel('Message',{exact:true}).fill('First message');await panel.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(panel.locator('[data-conversation-messages]')).toContainText('First message');
  await expect(panel.locator('[data-conversation-messages]')).not.toContainText('No messages yet.');assert.deepEqual(f.state.errors,[]);
 }finally{f.state.release();await f.close();}
});

async function activity(page,id,eventId) {
 await page.evaluate(({id,eventId})=>{for(const stream of window.streams)if(!stream.closed)stream.dispatchEvent(new MessageEvent('app-event',{data:JSON.stringify({type:'stock-request.updated',payload:{source:'stock-conversation',requestId:id,conversationEventId:eventId}})}));},{id,eventId});
}
for(const audience of ['sales','scm'])for(const kind of ['special','backorder','stocking','purchase','delivery'])test(`new conversation message sorts ${audience} ${kind} without losing selected detail or drafts`,async()=>{
 const f=await fixture(audience,kind,{multiple:true});try{
  const panel=f.page.locator('[data-stock-conversation="1"]'),cards=f.page.locator('.stock-request-list .stock-request-card');
  await expect(panel).toBeVisible();const input=panel.getByLabel('Message',{exact:true});await input.fill('Keep this unsent draft');
  await activity(f.page,1,10);await expect(cards.first()).toHaveAttribute('data-id','1');
  await activity(f.page,2,11);await expect(cards.first()).toHaveAttribute('data-id','2');
  await activity(f.page,1,9);await expect(cards.first()).toHaveAttribute('data-id','2');
  await expect(input).toHaveValue('Keep this unsent draft');await expect(input).toBeFocused();await expect(panel).toBeVisible();
  await panel.getByRole('button',{name:'Send message',exact:true}).click();await expect(cards.first()).toHaveAttribute('data-id','1');
  f.state.requests=[{...record(kind),id:3,requestRef:'REQ-3',conversationEventId:30},...f.state.requests];
  await input.fill('Still editing');await activity(f.page,3,30);await expect(cards.first()).toHaveAttribute('data-id','3');await expect(input).toHaveValue('Still editing');await expect(input).toBeFocused();
  await activity(f.page,999,40);await expect(cards.first()).toHaveAttribute('data-id','3');assert.equal(await cards.filter({hasText:'REQ-999'}).count(),0);
  const queueCalls=f.state.calls.filter(call=>call.path.endsWith(kind==='special'?'/special-stock-requests':'/stock-requests'));
  assert.ok(queueCalls.every(call=>call.url===queueCalls[0].url));
  await f.page.reload();await expect(cards.first()).toHaveAttribute('data-id','3');
  assert.deepEqual(f.state.errors,[]);
 }finally{await f.close();}
});

test('conversation queue recovers from fetch failure and includes messages arriving during an in-flight refresh',async()=>{
 const f=await fixture('sales','stocking',{multiple:true});let release;try{
  const panel=f.page.locator('[data-stock-conversation="1"]'),input=panel.getByLabel('Message',{exact:true}),cards=f.page.locator('.stock-request-list .stock-request-card');
  await input.fill('Do not lose this draft');f.state.queueFailure=true;
  const failed=f.page.waitForResponse(response=>response.url().includes('/api/sales/stock-requests?')&&response.status()===503);
  await activity(f.page,98,98);await failed;await expect(cards).toHaveCount(2);await expect(input).toHaveValue('Do not lose this draft');
  f.state.queueFailure=false;
  f.state.requests=[{...record('stocking'),id:3,requestRef:'REQ-3',conversationEventId:30},...f.state.requests];
  f.state.queueGate=new Promise(resolve=>{release=resolve;});
  const queueCalls=()=>f.state.calls.filter(call=>call.path==='/api/sales/stock-requests').length,initial=queueCalls();
  await activity(f.page,3,30);await expect.poll(queueCalls).toBe(initial+1);
  f.state.requests=[{...record('stocking'),id:4,requestRef:'REQ-4',conversationEventId:40},...f.state.requests];
  await activity(f.page,4,40);assert.equal(queueCalls(),initial+1);release();
  await expect(cards.first()).toHaveAttribute('data-id','4');await expect(cards).toHaveCount(4);assert.equal(queueCalls(),initial+2);
  await expect(input).toHaveValue('Do not lose this draft');await expect(input).toBeFocused();assert.deepEqual(f.state.errors,[]);
 }finally{release?.();await f.close();}
});
test('conversation retains a draft across failed retry, live refresh, re-render and request switching',async()=>{
 const f=await fixture('sales','stocking');try{
  const panel=f.page.locator('[data-stock-conversation]');await expect(panel).toBeVisible();await panel.getByLabel('Message',{exact:true}).fill('Keep my reply');f.state.fail=true;
  await panel.getByRole('button',{name:'Send message',exact:true}).click();await expect(panel.getByRole('status')).toContainText('Try again later.');await expect(panel.getByLabel('Message',{exact:true})).toHaveValue('Keep my reply');
  await f.page.evaluate(()=>window.StockRequestConversation.refresh());await expect(panel.getByLabel('Message',{exact:true})).toHaveValue('Keep my reply');
  await f.page.evaluate(()=>{const mount=document.querySelector('#salesStockRequestApp');window.StockRequestConversation.render(mount,{id:2,requestType:'regular',regular:{deliveryMethod:'stocking'}},'sales');});
  await expect(panel.getByLabel('Message',{exact:true})).toHaveValue('');
  await f.page.evaluate(()=>{const mount=document.querySelector('#salesStockRequestApp');window.StockRequestConversation.render(mount,{id:1,requestType:'regular',regular:{deliveryMethod:'stocking'}},'sales');});
  await expect(panel.getByLabel('Message',{exact:true})).toHaveValue('Keep my reply');f.state.fail=false;
  await panel.getByRole('button',{name:'Send message',exact:true}).click();await expect(panel.getByLabel('Message',{exact:true})).toHaveValue('');
  const posts=f.state.calls.filter(call=>call.path.endsWith('/conversation')&&call.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].body.operationId,posts[1].body.operationId);
 }finally{await f.close();}
});
test('conversation notifications show unread badge and safe message link; visible history is acknowledged',async()=>{
 const f=await fixture('sales','special',{alert:true});try{
  await expect(f.page.locator('[data-stock-conversation-alert]')).toContainText('Messages 1');
  await expect(f.page.locator('[data-stock-conversation-notice]')).toContainText('A new message <safe>');
  await expect(f.page.locator('[data-stock-conversation-notice] a')).toHaveAttribute('href',/tab=special.*requestId=2/);
  await expect.poll(()=>f.state.calls.filter(call=>call.path.endsWith('/conversation/read')).length).toBeGreaterThan(0);
  assert.deepEqual(f.state.errors,[]);
 }finally{await f.close();}
});
