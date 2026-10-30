import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';

let server,browser,base;
const fixtures=new Map();
before(async()=>{
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://test'),state=fixtures.get(req.headers.authorization?.replace('Bearer ',''));
    if(url.pathname.startsWith('/api/')) {
      if(!state){res.writeHead(401,{'content-type':'application/json'});res.end('{}');return;}
      state.calls.push({method:req.method,path:url.pathname,all:url.searchParams.get('includeRequests')});
      let data=url.pathname==='/api/auth/me'?{operator:{id:state.id,role:state.role,roles:[state.role],publicSales:false}}:state.data[url.pathname]||{total:0,count:0,requests:[],alerts:[]};
      if(url.searchParams.get('includeRequests')==='1'&&state.hold)await state.hold;
      const status=url.searchParams.get('includeRequests')==='1'?state.status:200;
      res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));return;
    }
    if (/^\/(sales|scm)\/stock-requests$/.test(url.pathname)) {res.writeHead(200,{'content-type':'text/html'});res.end('<html><body>Request page</body></html>');return;}
    if(url.pathname==='/preview'){
      res.writeHead(200,{'content-type':'text/html'});
      res.end(`<html><head></head><body><header class="topbar"><div class="topbar-actions"></div></header><button id="focus-before">Before alerts</button>${url.searchParams.get('scripts').split(',').map(name=>`<script ${['special-po-reference-alert','special-delivery-method-alert'].includes(name)?'type="module"':''} src="/${name}.js"></script>`).join('')}</body></html>`);return;
    }
    try {const name=url.pathname.slice(1);if(!/^[a-z0-9-]+\.js$/.test(name))throw Error();res.writeHead(200,{'content-type':'application/javascript'});res.end(await readFile(new URL('../../../public/'+name,import.meta.url)));}
    catch{res.writeHead(404);res.end('');}
  });
  server.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(done=>server.close(done));});
async function fixture(scripts,{role='sales',popups=false,data={}}={}){
  const id=randomUUID(),state={id,role,data,status:200,hold:null,calls:[]};fixtures.set(id,state);
  const context=await browser.newContext({viewport:{width:1100,height:900},serviceWorkers:'block'});
  await context.addInitScript(({id,popups})=>{
    localStorage.setItem('mbbs.staff.token',id);
    window.MBBSOSNotifications={allowsRole:()=>popups,notify:async()=>false};
    window.EventSource=class {addEventListener(){} close(){}};
  },{id,popups});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/preview?scripts='+scripts.join(','));
  return {page,state,errors,async close(){await context.close();fixtures.delete(id);}};
}
const panel=page=>page.locator('[data-stock-request-alert-list]');
const regularData={total:3,requests:[{id:11,requestRef:'STREQ-11',eventId:101,action:'reply',message:'First update'},
  {id:12,requestRef:'STREQ-12',eventId:102,action:'input_required',reason:'sales_confirmation',message:'Confirm quantities'},
  {id:11,requestRef:'STREQ-11',eventId:103,action:'arrival',arrivalKey:'receipt',message:'Stock has arrived'}]};
test('Regular badge and View all updates navigate directly to the request page',async()=>{
  for (const popups of [false,true]) {
    const f=await fixture(['regular-stock-alert'],{popups,data:{'/api/sales/stock-requests/alerts':regularData}});
    try {
      await f.page.locator(popups?'[data-regular-alert-all]':'.regular-stock-alert').click();
      await expect(f.page).toHaveURL(/\/sales\/stock-requests\?tab=regular&alerts=1$/);
      await expect(panel(f.page)).toHaveCount(0);
      assert.equal(f.state.calls.filter(call=>call.method!=='GET').length,0);assert.deepEqual(f.errors,[]);
    } finally {await f.close();}
  }
});
for(const audience of ['sales','scm'])test(`${audience} Special badge links directly to an editable alert search`,async()=>{
  const data=audience==='sales'?{awaitCustomerConfirmation:0,dispatchArrangement:0,waitForProduction:0,pendingUpdate:65,total:65}:{newRequests:65,confirmedOrders:0,total:65};
  const f=await fixture([audience+'-special-alert'],{role:audience,data:{[`/api/${audience}/special-stock-requests/alerts`]:data}});
  try {
    const link=f.page.locator(`.${audience}-special-alert`);
    await expect(link).toHaveAttribute('href',`/${audience}/stock-requests?tab=special&alerts=1`);
    await link.click();await expect(f.page).toHaveURL(new RegExp(`/${audience}/stock-requests\\?tab=special&alerts=1$`));
    await expect(panel(f.page)).toHaveCount(0);assert.deepEqual(f.errors,[]);
  } finally {await f.close();}
});
test('Message badge lists both Special and Regular conversations with their unread counts',async()=>{
  const data={count:7,requests:[{id:61,requestRef:'SPREQ-61',tab:'special',latestEventId:20,actorName:'SCM A',message:'Special update',unreadCount:5},{id:62,requestRef:'STREQ-62',tab:'regular',latestEventId:21,actorName:'SCM B',message:'Regular update',unreadCount:2}]};
  const f=await fixture(['stock-request-conversation-alert'],{data:{'/api/sales/stock-request-conversation-alerts':data}});
  try{await f.page.locator('[data-stock-conversation-alert]').click();await expect(panel(f.page).locator('[data-alert-list-request]')).toHaveCount(2);await expect(panel(f.page)).toContainText('5 unread messages');await expect(panel(f.page).getByRole('link').first()).toHaveAttribute('href',/tab=special/);assert.equal(f.state.calls.filter(call=>call.method==='POST').length,0);assert.deepEqual(f.errors,[]);}finally{await f.close();}
});
test('Special PO reference popup exposes every pending reference without acknowledging them',async()=>{
  const alerts=[1,2].map(id=>({requestId:id,requestRef:'SPREQ-'+id,displayRef:'PO-REF-'+id,noticeKey:String(id).repeat(64),fulfillmentMethod:'yard_pickup',audience:'sales'}));
  const f=await fixture(['special-po-reference-alert'],{popups:true,data:{'/api/sales/special-stock-requests/po-reference-alerts':{alerts}}});
  try{await f.page.locator('.special-po-reference-dialog').getByRole('button',{name:'View all updates'}).click();await expect(panel(f.page).locator('[data-alert-list-request]')).toHaveCount(2);await expect(panel(f.page)).toContainText('PO-REF-2');assert.equal(f.state.calls.filter(call=>call.method==='POST').length,0);assert.deepEqual(f.errors,[]);}finally{await f.close();}
});
test('Special delivery popup exposes every changed request without acknowledging them',async()=>{
  const alerts=[1,2].map(id=>({id,requestId:id,requestRef:'SPREQ-'+id,audience:'scm',beforeMethod:'yard_pickup',fulfillmentMethod:'mbt_delivery',yardName:'3445',salesOrderRef:'SO-'+id,purchaseOrderRef:'PO-'+id,purchaseOrderReference:'REF-'+id}));
  const f=await fixture(['special-delivery-method-alert'],{role:'scm',popups:true,data:{'/api/scm/special-stock-requests/delivery-method-alerts':{alerts}}});
  try{await f.page.locator('.special-delivery-method-dialog').getByRole('button',{name:'View all updates'}).click();await expect(panel(f.page).locator('[data-alert-list-request]')).toHaveCount(2);await expect(panel(f.page)).toContainText('SPREQ-2');assert.equal(f.state.calls.filter(call=>call.method==='POST').length,0);assert.deepEqual(f.errors,[]);}finally{await f.close();}
});
test('Alert list handles refresh errors, mobile layout, text escaping and keyboard close',async()=>{
  const f=await fixture(['stock-request-conversation-alert'],{data:{'/api/sales/stock-request-conversation-alerts':{count:3,requests:regularData.requests.map(row=>({...row,tab:'regular',unreadCount:1,latestEventId:row.eventId}))}}});
  try{
    await f.page.locator('[data-stock-conversation-alert]').click();await expect(panel(f.page).locator('[data-alert-list-request]')).toHaveCount(2);
    f.state.status=503;await panel(f.page).getByRole('button',{name:'Refresh updates'}).click();await expect(panel(f.page).locator('[role=status]')).toContainText('Could not load updates');await expect(panel(f.page).locator('[data-alert-list-request]')).toHaveCount(2);
    f.state.status=200;f.state.data['/api/sales/stock-request-conversation-alerts']={count:1,requests:[{tab:'regular',unreadCount:1,latestEventId:1,id:91,requestRef:'<img src=x onerror=alert(1)>',message:'<script>unsafe</script>'}]};
    await panel(f.page).getByRole('button',{name:'Refresh updates'}).click();await expect(panel(f.page).locator('[data-alert-list-request]')).toHaveCount(1);await expect(panel(f.page).locator('img,script')).toHaveCount(0);await expect(panel(f.page)).toContainText('<script>unsafe</script>');
    await f.page.setViewportSize({width:360,height:700});assert.ok(await panel(f.page).evaluate(el=>el.getBoundingClientRect().right<=window.innerWidth));
    await f.page.keyboard.press('Escape');await expect(panel(f.page)).toHaveCount(0);await expect(f.page.locator('[data-stock-conversation-alert]')).toBeFocused();assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
test('Late data after a session change cannot reopen the list or expose the prior user’s requests',async()=>{
  const f=await fixture(['stock-request-conversation-alert'],{data:{'/api/sales/stock-request-conversation-alerts':{count:3,requests:regularData.requests.map(row=>({...row,tab:'regular',unreadCount:1,latestEventId:row.eventId}))}}});let release;
  try{
    f.state.hold=new Promise(done=>release=done);await f.page.locator('[data-stock-conversation-alert]').click();await expect(panel(f.page)).toBeVisible();
    await f.page.evaluate(()=>{localStorage.removeItem('mbbs.staff.token');window.dispatchEvent(new Event('mbbs-auth-operator-changed'));});
    release();await expect(panel(f.page)).toHaveCount(0);assert.deepEqual(f.errors,[]);
  }finally{release?.();await f.close();}
});
test('Revoked access removes cached request entries from an open alert list',async()=>{
  const f=await fixture(['stock-request-conversation-alert'],{data:{'/api/sales/stock-request-conversation-alerts':{count:3,requests:regularData.requests.map(row=>({...row,tab:'regular',unreadCount:1,latestEventId:row.eventId}))}}});
  try{
    await f.page.locator('[data-stock-conversation-alert]').click();await expect(panel(f.page).locator('[data-alert-list-request]')).toHaveCount(2);
    f.state.status=403;await panel(f.page).getByRole('button',{name:'Refresh updates'}).click();
    await expect(panel(f.page).locator('[data-alert-list-request]')).toHaveCount(0);await expect(panel(f.page)).toContainText('Sign in again');assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
