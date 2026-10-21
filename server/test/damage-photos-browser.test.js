/* global localStorage,window */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {app} from '../src/server.js';
import {closeDb} from '../src/db.js';
import {createOperator,loginOperator} from '../src/auth-repository.js';
const out='test-artifacts/damage-photos-20261001';
const picture=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=','base64');
let server,base,browser,token;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  const username=`photo-browser-${crypto.randomUUID()}`,password=crypto.randomUUID();
  await createOperator({username,password,displayName:'Photo Manager',role:'yard_manager',yardLocationIds:[1],operatorYardLocationIds:[]});
  token=(await loginOperator(username,password)).token;
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});await mkdir(out,{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server.close(resolve));await closeDb();});
async function open({empty=false,fail=false,expired=false}={}) {
  const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block',acceptDownloads:true});
  await context.addInitScript(value=>localStorage.setItem('mbbs.staff.token',value),token);
  const page=await context.newPage();page.setDefaultTimeout(6000);
  await page.coverage.startJSCoverage({resetOnNavigation:false});
  const originals=[],writes=[];
  await page.route('**/api/photo-upload/preview**',async route=>{
    const url=new URL(route.request().url()),original=!url.searchParams.has('variant');
    assert.equal(route.request().headers().authorization,`Bearer ${token}`);
    if(original) originals.push(url.searchParams.get('ref'));
    if(original && expired) return route.fulfill({status:401,json:{error:'Login required'}});
    if(original && fail && url.searchParams.get('ref')==='r2://photo-2') return route.fulfill({status:404,json:{error:'Missing original photo'}});
    await route.fulfill({contentType:'image/png',body:picture});
  });
  await page.route('**/api/control/damage/**',async route=>{
    const url=new URL(route.request().url());
    if(route.request().method()!=='GET') {writes.push(url.pathname);return route.fulfill({status:500,json:{error:'No stock writes allowed in photo test'}});}
    if(url.pathname.endsWith('/config')) return route.fulfill({json:{yards:[{id:1,name:'3445'}],month:'2026-10',reasons:[{id:5,label:'R1 - Color Variation'}]}});
    if(url.pathname.endsWith('/review')) return route.fulfill({json:{month:'2026-10',locationId:1,syncError:null,history:[],reports:empty?[]:[
      {id:'linked-report',status:'posted',photos:['r2://photo-1']},
      {id:'uncertain-report',status:'attention',safe_to_retry:false,transfer_ref:'IT00571',item_name:'Saved SKU',photos:['r2://photo-3']}],transfers:[
      {id:'1031838',ref:'IT00571',memo:'3445 2026 Oct Damage',source:'3445',destination:'3445 Damage',revision:'a'.repeat(64),lines:[
        {line:7,itemId:'5022',itemName:'UNI-PISAS-COP-SAFARI',quantity:18,unitId:'554',unit:'PC',reasonId:5,photos:empty?[]:['r2://photo-1','r2://photo-2']}]}]}});
    if(url.pathname.includes('/items/')) return route.fulfill({json:{item_id:5022,item_name:'UNI-PISAS-COP-SAFARI',sales_unit_id:554,units:[{id:'554',label:'PC'}]}});
    return route.fulfill({json:[]});
  });
  await page.goto(base+'/control/damage-stock');await expect(page.locator('[data-control-damage-transfer]')).toContainText('IT00571');
  return {page,context,originals,writes};
}
async function close(page,context,label) {
  await writeFile(`${out}/browser-${label}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));
  await context.close();
}
test('Z1/Z2/Z3 browser: one click downloads every original once with persisted line naming',async()=>{
  const {page,context,originals,writes}=await open();
  try {
    await page.locator('[data-cd-action="edit"]').click();await page.locator('[data-cd-quantity]').fill('99');await page.locator('[data-cd-action="apply-line"]').click();
    const saved=page.waitForEvent('download');await page.locator('[data-cd-action="download-photos"]').click();
    const download=await saved;assert.equal(download.suggestedFilename(),'Damage-stock_3445_2026-10.zip');
    await download.saveAs(`${out}/browser-photos.zip`);
    assert.deepEqual(originals,['r2://photo-1','r2://photo-2','r2://photo-3']);assert.deepEqual(writes,[]);
    await expect(page.locator('.control-damage-quantity')).toHaveText('99 PC');
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:`${out}/download-mobile.png`,fullPage:true});
    await writeFile(`${out}/mobile-layout.json`,JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('*')]
      .filter(element=>element.getBoundingClientRect().right>window.innerWidth+1)
      .map(element=>({tag:element.tagName,cls:element.className,left:element.getBoundingClientRect().left,width:element.getBoundingClientRect().width,
        minWidth:getComputedStyle(element).minWidth,text:element.textContent.slice(0,80)}))),null,2));
    assert.ok(await page.locator('[data-cd-action="download-photos"]').isVisible());
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  } finally {await close(page,context,'success');}
});
test('Z3 browser: a missing original shows the error and never downloads an incomplete ZIP',async()=>{
  const {page,context,writes}=await open({fail:true});let downloads=0;page.on('download',()=>downloads++);
  try {
    await page.locator('[data-cd-action="download-photos"]').click();
    await expect(page.locator('[data-cd-error]')).toContainText('Missing original photo');
    await expect(page.locator('[data-cd-action="download-photos"]')).toBeEnabled();
    assert.equal(downloads,0);assert.deepEqual(writes,[]);
  } finally {await close(page,context,'failure');}
});
test('Z3 browser: an empty review disables download',async()=>{
  const {page,context}=await open({empty:true});
  try {await expect(page.locator('[data-cd-action="download-photos"]')).toBeDisabled();}
  finally {await close(page,context,'empty');}
});
test('Z3/R1 browser: an expired session stops the download and returns to login',async()=>{
  const {page,context,writes}=await open({expired:true});let downloads=0;page.on('download',()=>downloads++);
  try {
    await page.locator('[data-cd-action="download-photos"]').click();
    await expect(page.locator('[data-form="login"]')).toBeVisible();
    assert.equal(await page.evaluate(()=>localStorage.getItem('mbbs.staff.token')),null);
    assert.equal(downloads,0);assert.deepEqual(writes,[]);
  } finally {await close(page,context,'expired');}
});
