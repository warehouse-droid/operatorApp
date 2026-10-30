import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {fixture} from './fixture.js';
import {closeDb} from '../../src/db.js';
after(closeDb);

async function setup(t,width){
 const f=await fixture(),browser=await chromium.launch({args:['--no-sandbox']});
 t.after(async()=>{await browser.close();await f.close();});
 const context=await browser.newContext({viewport:{width,height:1050},serviceWorkers:'block'}),page=await context.newPage();
 page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[]));
 await context.addInitScript(()=>{
  localStorage.setItem('mbbs.staff.token','admin');localStorage.setItem('mbbs.staff.role','admin');localStorage.setItem('mbbs.staff.roles','["admin"]');
  window.EventSource=class extends window.EventTarget{close(){}};
  Object.defineProperty(window.Notification,'permission',{configurable:true,get:()=>'granted'});
  for(const role of ['sales','dispatch','scm'])localStorage.setItem(`mbbs.alert-role.muted.admin.${role}`,'true');
 });
 const alerts={count:2};
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.startsWith('/api/repair/'))return route.continue();
  if(path==='/api/auth/me')return route.fulfill({json:{operator:f.actors.admin,mbrContractsEnabled:true}});
  if(path==='/api/navigation/menu-order')return route.fulfill({json:{revision:1,orders:{}}});
  if(path==='/api/scm/aggregate-requests')return route.fulfill({json:{requests:Array.from({length:alerts.count},()=>({status:'submitted'}))}});
  if(path.endsWith('/stock-requests/alerts'))return route.fulfill({json:{total:alerts.count,requests:[]}});
  if(path.endsWith('/special-stock-requests/alerts'))return route.fulfill({json:{total:alerts.count,newRequests:alerts.count,confirmedOrders:0,pendingUpdate:alerts.count,awaitCustomerConfirmation:0,dispatchArrangement:0,waitForProduction:0}});
  if(path.endsWith('/delivery-method-alerts'))return route.fulfill({json:{alerts:alerts.count?[{id:1,requestId:1,audience:path.split('/')[2],beforeMethod:'yard_pickup',fulfillmentMethod:'mbt_delivery',requestRef:'SPREQ-1',yardName:'Yard',salesOrderRef:'SO-1',purchaseOrderRef:'PO-1',purchaseOrderReference:'PO-1'}]:[]}});
  if(path.endsWith('/delivery-requests/alerts')||path.endsWith('/stock-request-conversation-alerts'))return route.fulfill({json:{count:alerts.count,requests:[]}});
  return route.fulfill({json:{requests:[],alerts:[],count:0,total:0}});
 });
 return {...f,page,context,alerts};
}
const selectors=['.repair-updates','.app-notification-indicator'];

for(const width of [1440,820,390])test(`merged office notifications stay together across views and refresh at ${width}px`,async t=>{
 const f=await setup(t,width);await f.page.goto(f.base+'/repair/');
 const host=f.page.getByRole('group',{name:'Notifications',exact:true});
 for(const selector of selectors){try{await expect(host.locator(selector)).toBeVisible();}catch(error){error.message+=' '+JSON.stringify(await f.page.evaluate(()=>({secure:window.isSecureContext,permission:window.Notification?.permission,notificationsLoaded:Boolean(window.MBBSOSNotifications),indicators:document.querySelectorAll('.app-notification-indicator').length,preferences:document.querySelectorAll('.app-personal-preferences').length})));throw error;}}
 await f.page.evaluate(()=>{window.repairHeader=document.querySelector('.repair-topbar');window.repairAlertNodes=[...document.querySelector('.topbar-actions').children];});
 const check=async()=>{
  assert.equal(await f.page.evaluate(()=>document.querySelector('.repair-topbar')===window.repairHeader&&window.repairAlertNodes.every(node=>node.parentElement===document.querySelector('.topbar-actions'))),true);
  const bounds=await host.boundingBox();assert.ok(bounds);
  for(const selector of selectors){
   const node=host.locator(selector),box=await node.boundingBox();assert.ok(box,selector);
   assert.ok(box.x>=bounds.x-1&&box.x+box.width<=bounds.x+bounds.width+1&&box.y>=bounds.y-1&&box.y+box.height<=bounds.y+bounds.height+1,selector);
   assert.equal(await node.evaluate(el=>window.getComputedStyle(el).position),'static');
  }
  assert.equal(await f.page.locator('body').evaluate(el=>el.scrollWidth<=window.innerWidth),true);
  await expect(f.page.locator('link[rel="manifest"],meta[name="apple-mobile-web-app-capable"]')).toHaveCount(0);
 };
 await check();
 if(process.env.REPAIR_OFFICE_PREVIEW==='1'&&width===1440){await f.page.screenshot({path:'/app/test-artifacts/repair-office-1440.png'});console.log('Repair office preview ready');await new Promise(resolve=>setTimeout(resolve,45000));}
 await f.page.getByRole('button',{name:'Parts & stock',exact:true}).click();await check();
 await f.page.getByRole('button',{name:'Search records',exact:true}).click();await check();
 await f.page.getByRole('button',{name:'All requests',exact:true}).click();await f.page.getByRole('button',{name:'Refresh',exact:true}).click();await check();
 await f.page.getByRole('button',{name:/^Repair updates/}).click();await expect(f.page.getByRole('heading',{name:'Repair updates',exact:true})).toBeVisible();
 await f.page.evaluate(async()=>{const portal=await import('/repair/app.js?v=20261029-quote-policy');await portal.refresh();});
 await expect(f.page.getByRole('heading',{name:'Repair updates',exact:true})).toBeVisible();await check();
 await f.page.locator('.app-notification-indicator').click();await expect(f.page.getByRole('dialog',{name:'Personal preferences'})).toBeVisible();await f.page.getByRole('button',{name:'Close personal preferences',exact:true}).click();
 await expect(f.page.locator('.stock-conversation-alert,.delivery-request-alert,.regular-stock-alert,.scm-aggregate-alert,.scm-special-alert,.sales-special-alert,.special-delivery-method-alert')).toHaveCount(0);
 assert.equal(await f.page.locator('script[src*="stock-alert"],script[src*="conversation-alert"],script[src*="delivery-request-alert"]').count(),0);
 f.alerts.count=0;await f.page.evaluate(()=>document.dispatchEvent(new window.Event('visibilitychange')));
 await expect(f.page.locator('.stock-conversation-alert')).toBeHidden();await expect(f.page.locator('.delivery-request-alert')).toBeHidden();
 assert.equal(await f.page.evaluate(()=>document.querySelector('.repair-topbar')===window.repairHeader),true);
});

test('old office links keep the selected job in the merged browser portal with one sidebar destination',async t=>{
 const f=await setup(t,1280),job=await f.repo.create(f.actors.driver,{commandId:randomUUID(),vehicleId:f.vehicle,meter:'1',meterUnit:'km',defect:'Office alias job',condition:'can_operate'});
 await f.page.goto(f.base+'/repair/office?source=saved#'+job.id);
 await expect(f.page.getByRole('heading',{name:'Repair department',exact:true})).toBeVisible();
 assert.equal(new URL(f.page.url()).pathname,'/repair');assert.equal(new URL(f.page.url()).search,'?source=saved');assert.equal(new URL(f.page.url()).hash,'#'+job.id);
 await expect(f.page.locator('#content .brand').filter({hasText:job.number})).toContainText(job.number);
 await expect(f.page.locator('#appSidebar [href="/repair/office"]')).toHaveCount(0);await expect(f.page.locator('#appSidebar [aria-label="Repair pages"] [href="/repair"]')).toHaveCount(1);
 await expect(f.page.getByRole('button',{name:'Office',exact:true})).toHaveCount(0);
 await expect(f.page.getByRole('button',{name:'Purchases',exact:true})).toBeVisible();await expect(f.page.getByRole('button',{name:'Equipment',exact:true})).toBeVisible();
 await expect(f.page.locator('link[rel="manifest"]')).toHaveCount(0);
});
