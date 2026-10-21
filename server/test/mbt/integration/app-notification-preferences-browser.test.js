/* global window,document,localStorage,Notification,CustomEvent,Event */
import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';

let server,browser,base,operator;
const runtime=new Set(['app-sidebar.js','app-notifications.js','app-alert-sound.js']);
before(async()=>{
  server=http.createServer(async(req,res)=>{
    const path=new URL(req.url,'http://test').pathname;
    if(path==='/api/auth/me') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({operator}));return;}
    if(path==='/dispatch/preferences-test') {
      res.setHeader('Content-Type','text/html');
      res.end('<title>MBBS Dispatch</title><header class="topbar"><div class="actions"></div></header><main>Delivery requests</main><script src="/app-sidebar.js"></script>');return;
    }
    if(path.startsWith('/api/')) {res.setHeader('Content-Type','application/json');res.end('{}');return;}
    res.setHeader('Content-Type','text/javascript');
    if(!runtime.has(path.slice(1))) {res.end('');return;}
    res.end(await fs.readFile(new URL(`../../../public/${path.slice(1)}`,import.meta.url)));
  });
  server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}/dispatch/preferences-test`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
});
beforeEach(()=>{operator={id:'personal-dispatch',role:'dispatcher',roles:['dispatcher']};});
after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
async function open(permission='granted') {
  const context=await browser.newContext(),page=await context.newPage();context.setDefaultTimeout(5000);
  await context.addInitScript(initial=>{
    if(!localStorage.getItem('test.initialized')) {
      localStorage.setItem('test.initialized','true');localStorage.setItem('mbbs.staff.token','personal-token');
      localStorage.setItem('test.permission',initial);
    }
    window.permissionRequests=0;
    Object.defineProperty(Notification,'permission',{configurable:true,get:()=>localStorage.getItem('test.permission')});
    Notification.requestPermission=async()=>{window.permissionRequests++;localStorage.setItem('test.permission','granted');return 'granted';};
  },permission);
  await page.goto(base);await expect(page.locator('#appSidebar [data-personal-preferences]')).toBeVisible();
  return {page,context};
}
const entry=page=>page.getByRole('button',{name:'Personal preferences',exact:true});
const panel=page=>page.getByRole('dialog',{name:'Personal preferences',exact:true});

test('off notifications hide their top-bar button and remain manageable from personal preferences across tabs and reloads',async()=>{
  const {page,context}=await open('default');
  try {
    await expect(page.locator('.topbar button')).toHaveCount(0);
    assert.equal(await page.evaluate(()=>window.permissionRequests),0);
    await entry(page).click();await expect(panel(page)).toBeVisible();
    assert.equal(await page.evaluate(()=>window.permissionRequests),0);
    await panel(page).getByRole('button',{name:'Enable OS notifications',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.permissionRequests),1);
    await expect(page.locator('.app-notification-indicator')).toHaveCount(1);
    await panel(page).getByRole('button',{name:'OS notifications on',exact:true}).click();
    await expect(page.locator('.app-notification-indicator')).toHaveCount(0);
    await page.getByRole('button',{name:'Close personal preferences'}).click();await expect(entry(page)).toBeFocused();
    await page.reload();await expect(entry(page)).toBeVisible();await expect(page.locator('.topbar button')).toHaveCount(0);
    const other=await context.newPage();await other.goto(base);await entry(other).click();
    await panel(other).getByRole('button',{name:'Enable OS notifications',exact:true}).click();
    await expect(page.locator('.app-notification-indicator')).toBeVisible();
    await panel(other).getByRole('button',{name:'OS notifications on',exact:true}).click();
    await expect(page.locator('.app-notification-indicator')).toHaveCount(0);
    assert.equal(await page.evaluate(()=>localStorage.getItem('mbbs.os-notifications.enabled.personal-dispatch')),'false');
  } finally {await context.close();}
});

test('personal preferences stay beside the sidebar brand while menus scroll and remain accessible in compact layouts',async()=>{
  const {page,context}=await open();
  try {
    await page.setViewportSize({width:1280,height:400});
    const brand=await page.locator('.app-sidebar-brand').boundingBox(),gear=await entry(page).boundingBox();
    assert.ok(gear.x>=brand.x+brand.width && Math.abs(gear.y+gear.height/2-brand.y-brand.height/2)<1);
    await page.locator('.app-sidebar-scroll').evaluate(element=>{element.scrollTop=element.scrollHeight;});
    assert.ok(await page.locator('.app-sidebar-scroll').evaluate(element=>element.scrollTop)>0);
    assert.deepEqual(await entry(page).boundingBox(),gear);
    if(process.env.MBBS_PREFERENCES_SCREENSHOT) {
      await page.screenshot({path:process.env.MBBS_PREFERENCES_SCREENSHOT.replace('preferences-mobile','preferences-sidebar-desktop')});
    }
    await page.setViewportSize({width:390,height:700});
    await page.locator('[data-sidebar-toggle]').click();
    await expect(page.locator('body')).toHaveClass(/app-sidebar-collapsed/);
    await entry(page).focus();await page.keyboard.press('Enter');await expect(panel(page)).toBeVisible();
    await page.evaluate(()=>window.dispatchEvent(new Event('mbbs-language-changed')));
    await expect(panel(page)).toBeVisible();
    await panel(page).getByRole('button',{name:'OS notifications on',exact:true}).click();
    await page.keyboard.press('Escape');await expect(panel(page)).not.toBeVisible();
    await entry(page).focus();await page.keyboard.press('Enter');await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole('button',{name:'Enable OS notifications',exact:true})).toBeVisible();
    const bounds=await panel(page).boundingBox();assert.ok(bounds.x>=0 && bounds.x+bounds.width<=390);
    if(process.env.MBBS_PREFERENCES_SCREENSHOT) {await page.screenshot({path:process.env.MBBS_PREFERENCES_SCREENSHOT});}
    await page.keyboard.press('Escape');await expect(entry(page)).toBeFocused();
    for(const compactPage of ['admin-sync-page','scm-transfer-dependencies-page']) {
      await page.evaluate(value=>document.body.classList.add(value),compactPage);
      await expect(entry(page)).toBeVisible();
      const compactGear=await entry(page).boundingBox();
      assert.ok(compactGear.x>=0 && compactGear.x+compactGear.width<=390 && compactGear.y>=600 && compactGear.y+compactGear.height<=700);
      await page.locator('.app-sidebar-scroll').evaluate(element=>{element.scrollLeft=element.scrollWidth;});
      assert.deepEqual(await entry(page).boundingBox(),compactGear);
      await entry(page).click();await expect(panel(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await page.evaluate(value=>document.body.classList.remove(value),compactPage);
    }
  } finally {await context.close();}
});

test('personal sound preferences persist per account and an open preferences panel closes on logout',async()=>{
  const {page,context}=await open();
  try {
    await entry(page).click();
    await panel(page).getByRole('button',{name:'Enable alert sound',exact:true}).click();
    await expect(panel(page).getByRole('button',{name:'Alert sound on',exact:true})).toBeVisible();
    await panel(page).getByRole('button',{name:'Alert sound on',exact:true}).click();
    await page.reload();await entry(page).click();
    await expect(panel(page).getByRole('button',{name:'Alert sound off',exact:true})).toBeVisible();
    await page.evaluate(()=>{localStorage.removeItem('mbbs.staff.token');window.dispatchEvent(new CustomEvent('mbbs-auth-operator-changed'));});
    await expect(page.locator('.app-personal-preferences')).toHaveCount(0);
    await expect(page.locator('.app-notification-indicator')).toHaveCount(0);
    await expect(entry(page)).not.toBeVisible();
    operator={id:'another-staff',role:'sales',roles:['sales']};
    await page.evaluate(()=>{localStorage.setItem('mbbs.staff.token','another-token');window.dispatchEvent(new CustomEvent('mbbs-auth-operator-changed'));});
    await entry(page).click();await expect(panel(page).getByRole('button',{name:'Enable alert sound',exact:true})).toBeVisible();
    assert.equal(await page.evaluate(()=>localStorage.getItem('mbbs.alert-sound.enabled.personal-dispatch')),'false');
    operator={id:'public-sales',publicSales:true,role:'sales'};
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(page.locator('.app-personal-preferences')).toHaveCount(0);await expect(entry(page)).not.toBeVisible();
  } finally {await context.close();}
});
