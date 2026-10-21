/* global window,document,localStorage,Notification,navigator,CustomEvent,Event */
import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';

let server,browser,base,operator,deliveryAlerts,coverageIndex=0;
before(async()=>{
  server=http.createServer(async(req,res)=>{
    const path=new URL(req.url,'http://test').pathname;
    if(path==='/api/auth/me') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({operator}));return;}
    if(path==='/api/dispatch/delivery-requests/alerts') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({count:deliveryAlerts.length,requests:deliveryAlerts}));return;}
    if(path==='/api/events') {res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': connected\n\n');return;}
    if(path==='/') {res.setHeader('Content-Type','text/html');res.end('<aside><button data-personal-preferences hidden>Personal preferences</button></aside><header class="topbar"><div class="actions"></div></header><main>Working screen</main><script src="/app-notifications.js"></script>');return;}
    try {res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(new URL(`../../../public/${path.slice(1)}`,import.meta.url)));}
    catch {res.writeHead(404);res.end();}
  });
  server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
});
beforeEach(()=>{operator={id:'dispatch-notifications',role:'dispatcher',roles:['dispatcher']};deliveryAlerts=[];});
after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
async function open() {
  const context=await browser.newContext(),page=await context.newPage();
  await cover(context,page);
  await context.addInitScript(()=>{
    localStorage.setItem('mbbs.staff.token','dispatch-token');
    window.notifications=[];window.permission=localStorage.getItem('test.notification.permission') || 'default';window.permissionRequests=0;window.registrations=[];window.failNotification=false;
    Object.defineProperty(Notification,'permission',{get:()=>window.permission,configurable:true});
    Notification.requestPermission=async()=>{window.permissionRequests++;window.permission='granted';localStorage.setItem('test.notification.permission','granted');return window.permission;};
    Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{register:async(url,registerOptions)=>{
      window.registrations.push({url,options:registerOptions});
      return {active:{state:'activated'},showNotification:async(title,notificationOptions)=>{
        if(window.failNotification) {throw new Error('Notification delivery failed');}
        window.notifications.push({title,options:notificationOptions});
      }};
    }}});
  });
  await page.goto(base);await openPreferences(page);return {page,context};
}
async function openPreferences(page) {await page.getByRole('button',{name:'Personal preferences',exact:true}).click();}
async function closePreferences(page) {await page.getByRole('button',{name:'Close personal preferences',exact:true}).click();}
async function cover(context,page) {
  if(process.env.DELIVERY_UI_COVERAGE!=='1') {return;}
  await page.coverage.startJSCoverage({resetOnNavigation:false});const close=context.close.bind(context);
  context.close=async()=>{try {await fs.writeFile(`test-artifacts/delivery-requests-ui/os-notification-coverage-${++coverageIndex}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));}finally {await close();}};
}
const alert={id:'delivery:1:2',title:'Delivery request updated',body:'DR-000001 · Sales requested a new timeslot.',url:'/dispatch/delivery-requests?request=1'};
test('OS alerts require an explicit permission click and use a dedicated service worker',async()=>{
  const {page,context}=await open();
  try {
    await expect(page.getByRole('button',{name:'Enable OS notifications',exact:true})).toBeVisible();
    assert.equal(await page.evaluate(()=>window.permissionRequests),0);
    assert.equal(await page.evaluate(item=>window.MBBSOSNotifications.notify(item),alert),false);
    await page.getByRole('button',{name:'Enable OS notifications',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.permissionRequests),1);
    await page.evaluate(()=>{window.notifications=[];});
    assert.equal(await page.evaluate(item=>window.MBBSOSNotifications.notify(item),alert),true);
    const [notice]=await page.evaluate(()=>window.notifications);
    assert.equal(notice.title,alert.title);assert.equal(notice.options.body,alert.body);
    assert.equal(notice.options.data.url,alert.url);
    assert.equal((await page.evaluate(()=>window.registrations))[0].options.scope,'/staff-notifications/');
  } finally {await context.close();}
});
test('OS alerts deduplicate concurrent refreshes, page reloads and tabs by account and event',async()=>{
  const {page,context}=await open();
  try {
    await page.getByRole('button',{name:'Enable OS notifications',exact:true}).click();await page.evaluate(()=>{window.notifications=[];});
    await page.evaluate(item=>Promise.all(Array.from({length:5},()=>window.MBBSOSNotifications.notify(item))),alert);
    assert.equal(await page.evaluate(()=>window.notifications.length),1);
    await page.reload();await openPreferences(page);await expect(page.getByRole('button',{name:'OS notifications on',exact:true})).toBeVisible();
    assert.equal(await page.evaluate(item=>window.MBBSOSNotifications.notify(item),alert),false);
    const other=await context.newPage();await other.goto(base);await openPreferences(other);
    await expect(other.getByRole('button',{name:'OS notifications on',exact:true})).toBeVisible();
    assert.equal(await other.evaluate(item=>window.MBBSOSNotifications.notify(item),alert),false);
    assert.equal(await other.evaluate(item=>window.MBBSOSNotifications.notify({...item,id:'delivery:1:3'}),alert),true);
  } finally {await context.close();}
});
test('permission denial, notification failure and account changes do not leak or consume alerts',async()=>{
  const {page,context}=await open();
  try {
    await expect(page.getByRole('button',{name:'Enable OS notifications',exact:true})).toBeVisible();
    await page.evaluate(()=>{window.permission='denied';});
    assert.equal(await page.evaluate(item=>window.MBBSOSNotifications.notify(item),alert),false);
    await page.evaluate(()=>{window.permission='granted';window.failNotification=true;});
    assert.equal(await page.evaluate(item=>window.MBBSOSNotifications.notify(item),alert),false);
    await page.evaluate(()=>{window.failNotification=false;});
    assert.equal(await page.evaluate(item=>window.MBBSOSNotifications.notify(item),alert),true);
    await page.evaluate(()=>{localStorage.removeItem('mbbs.staff.token');window.dispatchEvent(new CustomEvent('mbbs-auth-operator-changed'));});
    assert.equal(await page.evaluate(item=>window.MBBSOSNotifications.notify({...item,id:'delivery:1:4'}),alert),false);
    await expect(page.getByRole('button',{name:'OS notifications on',exact:true})).toHaveCount(0);
  } finally {await context.close();}
});
test('notification links stay on this application and alert popups mirror their text',async()=>{
  const {page,context}=await open();
  try {
    await page.getByRole('button',{name:'Enable OS notifications',exact:true}).click();await page.evaluate(()=>{window.notifications=[];});
    await closePreferences(page);
    for(const url of ['https://other.invalid/private','javascript:alert(1)','data:text/html,hello']) {
      assert.equal(await page.evaluate(item=>window.MBBSOSNotifications.notify(item),{...alert,url}),false);
    }
    await page.evaluate(()=>{
      const dialog=document.createElement('dialog');dialog.className='regular-stock-popup';
      dialog.innerHTML='<h2>SCM replied to your Stocking material</h2><p>RS-0001</p><p>The order is ready.</p><div><a href="/sales/stock-requests?tab=regular&requestId=1">Open request</a><button>Close</button></div>';
      document.body.append(dialog);dialog.showModal();
    });
    await expect.poll(()=>page.evaluate(()=>window.notifications.length)).toBe(1);
    const [notice]=await page.evaluate(()=>window.notifications);assert.match(notice.options.body,/RS-0001.*The order is ready/);
    assert.equal(notice.options.data.url,'/sales/stock-requests?tab=regular&requestId=1');
    assert.equal(notice.title,'SCM replied to your Stocking material');
  } finally {await context.close();}
});
test('secured Sales time changes notify a background Dispatch tab and queue exactly one popup',async()=>{
  const {page,context}=await open();
  try {
    await page.getByRole('button',{name:'Enable OS notifications',exact:true}).click();
    await closePreferences(page);
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});});
    deliveryAlerts=[{id:1,requestRef:'DR-000001',revision:5,status:'confirmed',action:'request-time-change'}];
    await page.addScriptTag({url:base+'/delivery-request-alert.js'});
    await expect.poll(()=>page.evaluate(()=>window.notifications.length)).toBe(1);
    await expect(page.locator('.delivery-request-dialog')).toHaveCount(0);
    const [notice]=await page.evaluate(()=>window.notifications);assert.match(notice.options.body,/Sales requested a new timeslot/);
    assert.equal(notice.options.data.url,'/dispatch/delivery-requests?request=1');
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
    await expect(page.locator('.delivery-request-dialog')).toContainText('Sales requested a new timeslot');
    await page.evaluate(()=>window.MBBSDeliveryRequestAlerts.refresh());
    assert.equal(await page.evaluate(()=>window.notifications.length),1);
  } finally {await context.close();}
});
test('denied permission and opting out leave alert popups usable',async()=>{
  const {page,context}=await open();
  try {
    await expect(page.getByRole('button',{name:'Enable OS notifications',exact:true})).toBeVisible();
    await page.evaluate(()=>{Notification.requestPermission=async()=>{window.permission='denied';return 'denied';};});
    await page.getByRole('button',{name:'Enable OS notifications',exact:true}).click();
    await expect(page.locator('.app-os-notification-status')).toContainText('browser settings');
    await page.evaluate(()=>{window.permission='granted';window.dispatchEvent(new Event('focus'));});
    assert.equal(await page.evaluate(item=>window.MBBSOSNotifications.notify(item),alert),true);
    await page.getByRole('button',{name:'OS notifications on',exact:true}).click();
    assert.equal(await page.evaluate(item=>window.MBBSOSNotifications.notify({...item,id:'delivery:1:4'}),alert),false);
    await closePreferences(page);
    await page.evaluate(()=>{
      const modal=document.createElement('dialog');modal.className='delivery-request-dialog';modal.innerHTML='<h2>Delivery request updated</h2><p>DR-000001</p>';document.body.append(modal);modal.showModal();
    });
    await expect(page.locator('.delivery-request-dialog')).toBeVisible();assert.equal(await page.evaluate(()=>window.notifications.length),1);
  } finally {await context.close();}
});
test('delayed notification registration cannot deliver after a session change',async()=>{
  const {page,context}=await open();
  try {
    await page.getByRole('button',{name:'Enable OS notifications',exact:true}).click();
    await page.evaluate(()=>{
      navigator.serviceWorker.register=()=>new Promise(resolve=>{window.finishRegistration=()=>resolve({active:{state:'activated'},showNotification:async()=>window.notifications.push('stale')});});
      window.pendingNotice=window.MBBSOSNotifications.notify({id:'delayed',title:'Old account',body:'Private update',url:'/dispatch'});
    });
    await expect.poll(()=>page.evaluate(()=>typeof window.finishRegistration)).toBe('function');
    await page.evaluate(()=>{localStorage.removeItem('mbbs.staff.token');window.dispatchEvent(new CustomEvent('mbbs-auth-operator-changed'));window.finishRegistration();});
    assert.equal(await page.evaluate(()=>window.pendingNotice),false);assert.equal(await page.evaluate(()=>window.notifications.length),0);
  } finally {await context.close();}
});
test('real browser service worker displays a persistent notification with its request link',async()=>{
  const profile=await fs.mkdtemp('/tmp/mbbs-native-notifications-');let context;
  try {
    await fs.mkdir(`${profile}/config`);await fs.mkdir(`${profile}/cache`);
    context=await chromium.launchPersistentContext(profile,{headless:true,channel:'chromium',args:['--no-sandbox'],
      env:{...process.env,XDG_CONFIG_HOME:`${profile}/config`,XDG_CACHE_HOME:`${profile}/cache`}});
    const page=await context.newPage();await cover(context,page);
    await context.grantPermissions(['notifications'],{origin:base});
    await context.addInitScript(()=>localStorage.setItem('mbbs.staff.token','dispatch-token'));
    await page.goto(base);
    await openPreferences(page);
    await expect(page.getByRole('button',{name:'OS notifications on',exact:true})).toBeVisible();
    assert.equal(await page.evaluate(item=>window.MBBSOSNotifications.notify(item),{...alert,id:'real-browser'}),true);
    const notices=await page.evaluate(async()=>{
      const worker=await navigator.serviceWorker.getRegistration('/staff-notifications/');
      return (await worker.getNotifications()).map(item=>({title:item.title,data:item.data,body:item.body}));
    });
    assert.equal(notices.length,1);assert.equal(notices[0].title,alert.title);assert.equal(notices[0].data.url,alert.url);
  } finally {try {await context?.close();}finally {await fs.rm(profile,{recursive:true,force:true});}}
});
