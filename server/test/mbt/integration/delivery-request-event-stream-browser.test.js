/* global window,document,localStorage,CustomEvent,Event */
import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
let server,browser,base,alerts,actor,alertPaths;
const streams=new Set();
before(async()=>{
  server=http.createServer(async(req,res)=>{
    const path=new URL(req.url,'http://test').pathname;
    if(path==='/api/events') {
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
      res.write(': connected\n\n');streams.add(res);res.on('close',()=>streams.delete(res));return;
    }
    if(path==='/api/auth/me') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({operator:actor}));return;}
    if(/^\/api\/(sales|dispatch)\/delivery-requests\/alerts$/.test(path)) {alertPaths.push(path);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({count:alerts.length,requests:alerts}));return;}
    if(path.startsWith('/api/')) {res.setHeader('Content-Type','application/json');res.end('{}');return;}
    if(path==='/metadata') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ready:true}));return;}
    if(path==='/') {res.setHeader('Content-Type','text/html');res.end('<header class="topbar"><div class="actions"></div></header><script src="/app-event-stream.js"></script>');return;}
    if(['/dispatch','/dispatch/planning','/dispatch/monitor','/scm/schedule','/sales/planning'].includes(path)) {
      res.setHeader('Content-Type','text/html');res.end(`<html><head></head><body>${path==='/scm/schedule'?'':'<header class="dispatch-topbar"><div class="topbar-actions"></div></header>'}<main>Working page</main><script src="/app-sidebar.js"></script></body></html>`);return;
    }
    const name=path.slice(1);
    if(!/^[a-z0-9.-]+\.js$/.test(name)) {res.writeHead(404);res.end();return;}
    try {res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(await fs.readFile(new URL(`../../../public/${name}`,import.meta.url)));}
    catch {res.writeHead(404);res.end();}
  });
  server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
});
beforeEach(()=>{alerts=[];alertPaths=[];actor={id:'test-sales',role:'sales',yardLocationIds:[1]};});
after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
async function open() {
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
  await page.goto(base);return {page,context};
}
function notify(type) {for(const stream of streams) {stream.write(`event: app-event\ndata: ${JSON.stringify({type})}\n\n`);}}
test('restore: unclosed Dispatch popup survives focus and visibility rechecks including transient auth failure',async()=>{
  actor={id:'test-dispatch',role:'dispatcher',yardLocationIds:[]};
  alerts=[{id:1,requestRef:'DR-000001',revision:1,action:'submit',status:'submitted'}];
  const {page,context}=await open();
  if(process.env.DELIVERY_UI_COVERAGE==='1') {await page.coverage.startJSCoverage();}
  try {
    await page.evaluate(()=>localStorage.setItem('mbbs.staff.token','dispatch-token'));
    await page.addScriptTag({url:base+'/delivery-request-alert.js'});
    await expect(page.locator('.delivery-request-dialog')).toBeVisible();
    await page.route('**/api/auth/me',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
    const remained=await page.evaluate(()=>{
      const modal=document.querySelector('.delivery-request-dialog');
      Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      return modal.isConnected && modal.open;
    });
    assert.equal(remained,true,'Restoring the browser must not remove an unclosed popup while auth refreshes');
    await expect(page.locator('.delivery-request-dialog')).toBeVisible();
    await page.unroute('**/api/auth/me');
    await page.evaluate(()=>window.MBBSDeliveryRequestAlerts.checkSession(true));
    await expect(page.locator('.delivery-request-dialog')).toHaveCount(1);
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await page.evaluate(()=>window.MBBSDeliveryRequestAlerts.checkSession(true));
    await expect(page.locator('.delivery-request-dialog')).toHaveCount(0);
    await expect(page.locator('.delivery-request-alert')).toContainText('1');
    alerts=[{...alerts[0],revision:2}];await page.evaluate(()=>window.MBBSDeliveryRequestAlerts.refresh());
    await expect(page.locator('.delivery-request-dialog')).toBeVisible();
    actor={...actor,id:'second-dispatcher'};alerts=[];
    await page.evaluate(()=>window.MBBSDeliveryRequestAlerts.checkSession(true));
    await expect(page.locator('.delivery-request-dialog')).toHaveCount(0);
    alerts=[{id:2,requestRef:'DR-000002',revision:1,action:'relink',status:'confirmed'}];
    await page.evaluate(()=>window.MBBSDeliveryRequestAlerts.refresh());
    await expect(page.locator('.delivery-request-dialog')).toContainText('Sales changed the linked orders. The approved delivery time is unchanged.');
    await page.route('**/api/auth/me',route=>route.fulfill({status:401,contentType:'application/json',body:'{}'}));
    await page.evaluate(()=>window.MBBSDeliveryRequestAlerts.checkSession(true));
    await expect(page.locator('.delivery-request-dialog')).toHaveCount(0);
  } finally {
    try {if(process.env.DELIVERY_UI_COVERAGE==='1') {await fs.writeFile('test-artifacts/delivery-requests-ui/browser-coverage-restore.json',JSON.stringify(await page.coverage.stopJSCoverage()));}}
    finally {await context.close();}
  }
});
test('five global subscriptions share one connection, keep normal HTTP usable and deliver independently',async()=>{
  const {page,context}=await open();
  try {
    await page.evaluate(()=>{
      window.seen=[0,0,0,0,0];
      window.channels=window.seen.map((_value,index)=>{
        const channel=window.MBBSAppEventStream.connect(`/api/events?client=widget-${index}`);
        channel.addEventListener('app-event',()=>{window.seen[index]++;});return channel;
      });
    });
    await expect.poll(()=>streams.size).toBe(1);
    assert.deepEqual(await page.evaluate(async()=>await(await fetch('/metadata')).json()),{ready:true});
    notify('delivery.requests.updated');await expect.poll(()=>page.evaluate(()=>window.seen)).toEqual([1,1,1,1,1]);
    await page.evaluate(()=>window.channels[0].close());notify('delivery.requests.updated');
    await expect.poll(()=>page.evaluate(()=>window.seen)).toEqual([1,2,2,2,2]);
    await page.evaluate(()=>window.channels.forEach(channel=>channel.close()));await expect.poll(()=>streams.size).toBe(0);
  } finally {await context.close();}
});
test('authenticated event streams share only within the same token and never mix with anonymous subscribers',async()=>{
  const {page,context}=await open();
  try {
    await page.evaluate(()=>{window.channels=['?token=first','?token=first','?token=second','?client=anonymous'].map(query=>window.MBBSAppEventStream.connect('/api/events'+query));});
    await expect.poll(()=>streams.size).toBe(3);
    await page.evaluate(()=>window.channels[0].close());assert.equal(streams.size,3);
    await page.evaluate(()=>window.channels[1].close());await expect.poll(()=>streams.size).toBe(2);
    await page.evaluate(()=>window.channels.forEach(channel=>channel.close()));await expect.poll(()=>streams.size).toBe(0);
  } finally {await context.close();}
});
test('delivery alerts receive an update beside existing subscriptions without another persistent connection',async()=>{
  const {page,context}=await open();
  try {
    await page.evaluate(()=>{
      window.channels=Array.from({length:5},(_value,index)=>window.MBBSAppEventStream.connect(`/api/events?client=widget-${index}`));
      localStorage.setItem('mbbs.staff.token','fixture-token');
    });
    await page.addScriptTag({url:base+'/delivery-request-alert.js'});
    await expect.poll(()=>streams.size).toBe(1);
    alerts=[{id:1,requestRef:'DR-000001',revision:2,action:'confirm',status:'preapproved'}];notify('delivery.requests.updated');
    await expect(page.locator('.delivery-request-alert')).toContainText('1');await expect(page.locator('.delivery-request-dialog')).toBeVisible();
    assert.equal(streams.size,1);
    await page.getByRole('button',{name:'Close',exact:true}).click();await expect(page.locator('.delivery-request-alert')).toContainText('1');
    await page.evaluate(()=>{window.channels.forEach(channel=>channel.close());localStorage.removeItem('mbbs.staff.token');window.dispatchEvent(new CustomEvent('mbbs-auth-operator-changed',{detail:{operator:null}}));});
    await expect.poll(()=>streams.size).toBe(0);
  } finally {await context.close();}
});
test('closing one subscription cannot remove the same callback from another subscription',async()=>{
  const {page,context}=await open();
  try {
    await page.evaluate(()=>{
      window.calls=0;const callback=()=>{window.calls++;};
      window.channels=[window.MBBSAppEventStream.connect('/api/events?client=one'),window.MBBSAppEventStream.connect('/api/events?client=two')];
      window.channels.forEach(channel=>channel.addEventListener('app-event',callback));
      window.channels[1].addEventListener('app-event',callback);
    });
    await expect.poll(()=>streams.size).toBe(1);notify('delivery.requests.updated');
    await expect.poll(()=>page.evaluate(()=>window.calls)).toBe(2);
    await page.evaluate(()=>window.channels[0].close());notify('delivery.requests.updated');
    await expect.poll(()=>page.evaluate(()=>window.calls)).toBe(3);
    await page.evaluate(()=>window.channels[1].close());await expect.poll(()=>streams.size).toBe(0);
  } finally {await context.close();}
});
test('UI: proposed times and preapprovals alert an already open request at a newer revision',async()=>{
  const {page,context}=await open();
  if(process.env.DELIVERY_UI_COVERAGE==='1') {await page.coverage.startJSCoverage();}
  try {
    await page.evaluate(()=>{
      localStorage.setItem('mbbs.staff.token','fixture-token');
      window.MBBSDeliveryRequestPage={currentRequestId:1,currentRequestRevision:1};
    });
    await page.addScriptTag({url:base+'/delivery-request-alert.js'});
    await expect.poll(()=>streams.size).toBe(1);
    for(const [revision,action,status,message] of [[2,'propose','proposed','proposed another timeslot'],[3,'confirm','preapproved','pre-approved delivery']]) {
      alerts=[{id:1,requestRef:'DR-000001',revision,action,status}];notify('delivery.requests.updated');
      await expect(page.locator('.delivery-request-alert')).toContainText('1');
      await expect(page.locator('.delivery-request-dialog')).toBeVisible();
      await expect(page.locator('.delivery-request-dialog')).toContainText(message);
      await page.getByRole('button',{name:'Close',exact:true}).click();
      await expect(page.locator('.delivery-request-alert')).toContainText('1');
      await expect(page.locator('.delivery-request-dialog')).toHaveCount(0);
    }
    await page.evaluate(()=>{window.MBBSDeliveryRequestPage.currentRequestRevision=5;});
    alerts=[{id:1,requestRef:'DR-000001',revision:4,action:'propose',status:'proposed'}];notify('delivery.requests.updated');
    await page.evaluate(()=>window.MBBSDeliveryRequestAlerts.refresh());
    await expect(page.locator('.delivery-request-dialog')).toHaveCount(0);
    alerts=[{...alerts[0],revision:5}];notify('delivery.requests.updated');
    await page.evaluate(()=>window.MBBSDeliveryRequestAlerts.refresh());
    await expect(page.locator('.delivery-request-dialog')).toHaveCount(0);
  } finally {
    try {
      if(process.env.DELIVERY_UI_COVERAGE==='1') {await fs.writeFile('test-artifacts/delivery-requests-ui/browser-coverage-alert-events.json',JSON.stringify(await page.coverage.stopJSCoverage()));}
    } finally {await context.close();}
  }
});

test('updates: Dispatch receives new requests across pages through the shared sidebar',async()=>{
  actor={id:'test-dispatch',role:'dispatcher',roles:['dispatcher','sales'],yardLocationIds:[1]};
  const {page,context}=await open();
  try {
    await page.evaluate(()=>localStorage.setItem('mbbs.staff.token','dispatch-token'));
    for(const [index,path] of ['/dispatch','/dispatch/planning','/dispatch/monitor','/scm/schedule','/sales/planning'].entries()) {
      alerts=[];alertPaths=[];await page.goto(base+path);
      await expect.poll(()=>alertPaths.length).toBeGreaterThan(0);
      assert.ok(alertPaths.every(url=>url.startsWith('/api/dispatch/')),'Dispatch alerts stay active on other departments’ pages');
      alerts=[{id:index+1,requestRef:`DR-${index+1}`,revision:1,action:'submit',status:'submitted'}];notify('delivery.requests.updated');
      await expect(page.locator('.delivery-request-dialog')).toContainText('A new delivery request is awaiting Dispatch.');
      await expect(page.locator('.delivery-request-dialog a')).toHaveAttribute('href',`/dispatch/delivery-requests?request=${index+1}`);
      await page.getByRole('button',{name:'Close',exact:true}).click();
      await expect(page.locator('.delivery-request-alert')).toBeVisible();
      await expect(page.locator('.delivery-request-alert')).toContainText('1');
    }
  } finally {await context.close();}
});
test('updates: navigating without dismissing keeps a Dispatch popup pending',async()=>{
  actor={id:'test-dispatch',role:'dispatcher'};
  alerts=[{id:1,requestRef:'DR-000001',revision:1,action:'submit',status:'submitted'}];
  const {page,context}=await open();
  try {
    await page.evaluate(()=>localStorage.setItem('mbbs.staff.token','dispatch-token'));
    await page.goto(base+'/dispatch');
    await expect(page.locator('.delivery-request-dialog')).toBeVisible();
    await page.goto(base+'/dispatch/planning');
    await expect(page.locator('.delivery-request-dialog')).toBeVisible();
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await page.goto(base+'/dispatch/monitor');
    await expect(page.locator('.delivery-request-alert')).toBeVisible();
    await expect(page.locator('.delivery-request-dialog')).toHaveCount(0);
  } finally {await context.close();}
});
test('updates: hidden dialogs do not suppress alerts and closing visible dialogs releases them',async()=>{
  const {page,context}=await open();
  try {
    await page.evaluate(()=>{
      localStorage.setItem('mbbs.staff.token','fixture-token');
      const wrapper=document.createElement('div');wrapper.hidden=true;wrapper.id='other-dialog';
      wrapper.innerHTML='<div role="dialog" aria-modal="true">Other form</div>';document.body.append(wrapper);
    });
    await page.addScriptTag({url:base+'/delivery-request-alert.js'});
    alerts=[{id:1,requestRef:'DR-000001',revision:1,action:'submit',status:'submitted'}];
    await page.evaluate(()=>window.MBBSDeliveryRequestAlerts.refresh());
    await expect(page.locator('.delivery-request-dialog')).toBeVisible();
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await page.evaluate(()=>{document.querySelector('#other-dialog').hidden=false;});
    alerts=[{...alerts[0],revision:2}];await page.evaluate(()=>window.MBBSDeliveryRequestAlerts.refresh());
    await expect(page.locator('.delivery-request-dialog')).toHaveCount(0);
    await page.evaluate(()=>{document.querySelector('#other-dialog').hidden=true;});
    await expect(page.locator('.delivery-request-dialog')).toBeVisible();
  } finally {await context.close();}
});
