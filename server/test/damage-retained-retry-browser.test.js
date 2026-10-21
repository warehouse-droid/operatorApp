/* global localStorage, window */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';

let server,browser,base;
const coverage=[];
const sku={item_id:5022,item_name:'UNI-PISAS-COP-SAFARI',sales_unit:'PC',sales_unit_id:554,to_pcs:1};
const photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY5sAAAAASUVORK5CYII=';
const harness=`<!doctype html><html><body><main id="app"></main>
<script src="/counting-calculator.js"></script><script src="/damage-draft-cache.js"></script><script src="/operator-inventory.js"></script>
<script>window.actor={id:'actor-a'};window.yard=1;window.testPhoto=${JSON.stringify(photo)};
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
window.inventory=MBBSOperatorInventory.create({root:document.querySelector('#app'),escape:esc,actor:()=>actor,location:()=>yard,locationLabel:()=>String(yard),
 shell:(_title,_yard,body,buttons)=>document.querySelector('#app').innerHTML=body+buttons,toast:()=>{},back:()=>{},active:()=>true,
 photo:ref=>'src="'+esc(ref)+'"',preview:()=>{},nativeCamera:()=>true,captureNativePhoto:async()=>testPhoto,
 upload:async(ref,meta)=>{if(ref.startsWith('r2://'))return ref;const r=await fetch('/test-upload',{method:'POST',body:JSON.stringify({ref,meta,locationId:yard})});if(!r.ok)throw Error('Photo upload interrupted');return (await r.json()).reference;},
 api:async(path,options)=>{const r=await fetch(path,options);const json=await r.json();if(!r.ok){const e=Error(json.error);e.status=r.status;throw e;}return json;}
});inventory.open('damage');</script></body></html>`;
before(async()=>{
  server=createServer(async(req,res)=>{
    if(req.url==='/') {res.setHeader('Content-Type','text/html');return res.end(harness);}
    if(/^\/[a-z-]+\.js$/.test(req.url)) {
      try {res.setHeader('Content-Type','text/javascript');return res.end(await readFile('public'+req.url));}catch{res.statusCode=404;return res.end();}
    }
    res.statusCode=404;res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
});
after(async()=>{await mkdir('test-artifacts/damage-posting-retry-20261001',{recursive:true});await writeFile('test-artifacts/damage-posting-retry-20261001/browser-retry.json',JSON.stringify(coverage));await browser?.close();await new Promise(resolve=>server.close(resolve));});
async function fixture() {
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(5000);
  await page.coverage.startJSCoverage({resetOnNavigation:false});
  const close=context.close.bind(context);context.close=async()=>{coverage.push(...await page.coverage.stopJSCoverage());await close();};
  const observed={posts:[],retries:[],uploads:[],statusReads:0,localReads:0,status:'attention',uploadFailureAt:0,postFailure:false,postStatus:0,statusError:0,pauseRead:null,pauseUpload:null};
  const report=()=>({id:observed.posts.at(-1)?.requestId,item_name:sku.item_name,quantity:18,unit:'PC',values:{pieces:18},
    reason_label:'R1 - Color Variation',photos:observed.posts.at(-1)?.photos || [],status:observed.status,safe_to_retry:true,
    last_error:observed.status==='attention'?'Inventory Transfer failed. Retry posting.':null,transfer_ref:null});
  await page.route('**/api/inventory/damage/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.pathname.endsWith('/config'))return route.fulfill({json:{month:'2026-10',reasons:[{id:5,label:'R1 - Color Variation'}]}});
    if(url.pathname.endsWith('/items'))return route.fulfill({json:[sku]});
    if(url.pathname.endsWith('/items/5022'))return route.fulfill({json:sku});
    if(url.pathname.endsWith('/retry')){observed.retries.push(url.pathname);observed.status='posted';return route.fulfill({json:report()});}
    if(url.pathname.endsWith('/reports') && request.method()==='POST') {
      observed.posts.push(request.postDataJSON());
      if(observed.postFailure)return route.abort('failed');
      if(observed.postStatus)return route.fulfill({status:observed.postStatus,json:{error:'Please correct this report'}});
      observed.status='pending';return route.fulfill({status:202,json:report()});
    }
    if(url.pathname.endsWith('/reports')) {observed.localReads++;return route.fulfill({json:{reports:observed.posts.length?[report()]:[],transfers:[],syncError:null}});}
    if(/\/reports\/[^/]+$/.test(url.pathname)) {observed.statusReads++;if(observed.pauseRead)await observed.pauseRead;if(observed.statusError)return route.fulfill({status:observed.statusError,json:{error:'Report not found'}});if(observed.status==='pending')observed.status='attention';return route.fulfill({json:report()});}
    return route.fulfill({status:404,json:{error:'Unexpected test API call'}});
  });
  await page.route('**/test-upload',async route=>{
    observed.uploads.push(route.request().postDataJSON());
    if(observed.uploads.length===1 && observed.pauseUpload)await observed.pauseUpload;
    if(observed.uploads.length===observed.uploadFailureAt)return route.fulfill({status:503,json:{error:'Interrupted'}});
    return route.fulfill({json:{reference:`r2://test/${observed.uploads.length}.jpg`}});
  });
  await page.goto(base);
  await expect(page.locator('#damageSearch')).toBeEnabled();
  return {page,context,observed};
}
async function enter(page,count=1) {
  await page.locator('#damageSearch').fill('PISA');await page.locator('[data-inv-action="damage-item"]').click();
  await page.locator('[data-damage-quantity="pieces"]').fill('18');await page.locator('#damageReason').selectOption('5');
  for(let i=0;i<count;i++)await page.locator('[data-inv-action="camera"]').click();
  await expect(page.locator('.damage-photos img')).toHaveCount(count);
}
test('D1: entered quantity, reason and original image survive reload',async()=>{
  const {page,context}=await fixture();
  try {
    await enter(page);await page.reload();
    await expect(page.locator('[data-damage-quantity="pieces"]')).toHaveValue('18');
    await expect(page.locator('#damageReason')).toHaveValue('5');await expect(page.locator('.damage-photos img')).toHaveCount(1);
    assert.equal(await page.locator('.damage-photos img').getAttribute('src'),photo);
  } finally {await context.close();}
});
test('D2: failed transfer retains inputs and shows Retry on entry; retry uses saved report and uploaded photo',async()=>{
  const {page,context,observed}=await fixture();
  try {
    await enter(page);await page.locator('[data-inv-action="submit-damage"]').click();
    await expect(page.locator('[data-damage-posting]')).toContainText('Retry posting');
    await expect(page.locator('[data-damage-quantity="pieces"]')).toHaveValue('18');
    await expect(page.locator('.damage-photos img')).toHaveCount(1);
    await page.reload();await expect(page.locator('[data-damage-posting]')).toContainText('Retry posting');
    await page.locator('[data-damage-posting] [data-inv-action="retry-saved-damage"]').click();
    await expect(page.locator('[data-damage-saved]')).toContainText('Saved to NetSuite');
    assert.equal(observed.posts.length,1);assert.equal(observed.uploads.length,1);assert.equal(observed.retries.length,1);
    assert.ok(observed.retries[0].includes(observed.posts[0].requestId));
    assert.ok(observed.statusReads>0);
  } finally {await context.close();}
});
test('D3: lost submission response retains the exact request ID, quantity and completed upload through reload',async()=>{
  const {page,context,observed}=await fixture();
  try {
    await enter(page);observed.postFailure=true;
    await page.locator('[data-inv-action="submit-damage"]').click();await expect(page.locator('.inventory-error')).toBeVisible();
    await page.reload();await expect(page.locator('[data-damage-quantity="pieces"]')).toHaveValue('18');
    // The app finds the saved report rather than creating a different report.
    await expect(page.locator('[data-damage-posting]')).toBeVisible();
    await page.locator('[data-damage-posting] [data-inv-action="retry-saved-damage"]').click();
    assert.equal(observed.posts.length,1);assert.equal(observed.uploads.length,1);assert.equal(observed.posts[0].values.pieces,'18');
  } finally {await context.close();}
});
test('D3: partial photo upload failure retains both originals and does not reupload the successful photo',async()=>{
  const {page,context,observed}=await fixture();
  try {
    await enter(page,2);observed.uploadFailureAt=2;
    await page.locator('[data-inv-action="submit-damage"]').click();await expect(page.locator('.inventory-error')).toBeVisible();
    await page.reload();await expect(page.locator('.damage-photos img')).toHaveCount(2);
    observed.uploadFailureAt=0;await page.locator('[data-inv-action="submit-damage"]').click();
    await expect(page.locator('[data-damage-posting]')).toBeVisible();
    assert.equal(observed.uploads.length,3);assert.equal(observed.posts.length,1);assert.equal(observed.posts[0].photos.length,2);
    assert.equal(observed.posts[0].photos[0],'r2://test/1.jpg');
  } finally {await context.close();}
});
test('D4: another yard and account cannot load or overwrite the cached draft',async()=>{
  const {page,context}=await fixture();
  try {
    await enter(page);
    await page.evaluate(async()=>{window.yard=28;await window.inventory.open('damage');});
    await expect(page.locator('.damage-photos img')).toHaveCount(0);
    await page.evaluate(async()=>{window.actor={id:'actor-b'};window.yard=1;await window.inventory.open('damage');});
    await expect(page.locator('.damage-photos img')).toHaveCount(0);
    await page.evaluate(async()=>{window.actor={id:'actor-a'};await window.inventory.open('damage');});
    await expect(page.locator('[data-damage-quantity="pieces"]')).toHaveValue('18');await expect(page.locator('.damage-photos img')).toHaveCount(1);
  } finally {await context.close();}
});
test('D1: IndexedDB retains five photos larger than localStorage through reload',async()=>{
  const {page,context}=await fixture();
  try {
    const size=2*1024*1024;
    await page.evaluate(async size=>{
      const cache=window.MBBSDamageDraftCache.create();
      await cache.save('large-originals',{photos:Array.from({length:5},(_,index)=>'data:image/jpeg;base64,'+String(index)+'A'.repeat(size))});
    },size);
    await page.reload();
    const lengths=await page.evaluate(async()=>{const draft=await window.MBBSDamageDraftCache.create().load('large-originals');return draft.photos.map(photo=>photo.length);});
    assert.deepEqual(lengths,Array(5).fill('data:image/jpeg;base64,'.length+1+size));
  } finally {await context.close();}
});
test('D3: unavailable device storage reports an error while keeping the draft on the page',async()=>{
  const {page,context}=await fixture();
  try {
    await page.addInitScript(()=>Object.defineProperty(window,'indexedDB',{value:undefined}));await page.reload();
    await expect(page.locator('.inventory-error')).toContainText('Could not save the draft');
    await enter(page);await expect(page.locator('[data-damage-quantity="pieces"]')).toHaveValue('18');await expect(page.locator('.damage-photos img')).toHaveCount(1);
  } finally {await context.close();}
});
test('D3: an unconfirmed save retries the same immutable payload after reload',async()=>{
  const {page,context,observed}=await fixture();
  try {
    await enter(page);observed.postFailure=true;observed.statusError=404;
    await page.locator('[data-inv-action="submit-damage"]').click();await expect(page.locator('.inventory-error')).toBeVisible();
    await page.reload();await expect(page.locator('[data-inv-action="retry-damage-save"]')).toBeVisible();
    await expect(page.locator('[data-damage-quantity="pieces"]')).toBeDisabled();
    observed.postFailure=false;observed.statusError=0;
    await page.locator('[data-inv-action="retry-damage-save"]').click();
    await expect.poll(()=>observed.posts.length).toBe(2);
    await expect(page.locator('[data-damage-posting]')).toBeVisible();
    assert.equal(observed.posts.length,2);assert.deepEqual(observed.posts[1],observed.posts[0]);assert.equal(observed.uploads.length,1);
  } finally {await context.close();}
});
test('D3: definite validation rejection permits correction without losing the uploaded photo',async()=>{
  const {page,context,observed}=await fixture();
  try {
    await enter(page);observed.postStatus=400;
    await page.locator('[data-inv-action="submit-damage"]').click();await expect(page.locator('.inventory-error')).toContainText('Please correct');
    await expect(page.locator('[data-damage-quantity="pieces"]')).toBeEnabled();
    await expect(page.locator('.damage-photos img')).toHaveCount(1);assert.equal(observed.uploads.length,1);
    await page.locator('[data-damage-quantity="pieces"]').fill('19');
    observed.postStatus=0;await page.locator('[data-inv-action="submit-damage"]').click();
    await expect(page.locator('[data-damage-posting]')).toBeVisible();assert.equal(observed.uploads.length,1);
    assert.equal(observed.posts[1].values.pieces,'19');
  } finally {await context.close();}
});
test('D4: a late posting response does not replace a different yard draft',async()=>{
  const {page,context,observed}=await fixture();let resume;
  try {
    await enter(page);observed.pauseRead=new Promise(resolve=>{resume=resolve;});
    await page.locator('[data-inv-action="submit-damage"]').click();await expect.poll(()=>observed.statusReads).toBe(1);
    await page.evaluate(async()=>{window.yard=28;await window.inventory.open('damage');});await enter(page);
    await page.locator('[data-damage-quantity="pieces"]').fill('4');resume();observed.pauseRead=null;
    await expect(page.locator('[data-damage-quantity="pieces"]')).toHaveValue('4');await expect(page.locator('[data-damage-posting]')).toHaveCount(0);
  } finally {resume?.();await context.close();}
});
test('D4: a superseded cached submission is cleared and allows a new damage report',async()=>{
  const {page,context,observed}=await fixture();
  try {
    await enter(page);await page.locator('[data-inv-action="submit-damage"]').click();await expect(page.locator('[data-damage-posting]')).toContainText('Retry posting');
    observed.status='superseded';await page.reload();
    await expect(page.locator('.inventory-notice')).toContainText('Superseded');
    await expect(page.locator('#damageSearch')).toBeEnabled();
    await expect(page.locator('.damage-photos img')).toHaveCount(0);
  } finally {await context.close();}
});
test('D4: changing yard during upload retains remaining originals and never sends them to the new yard',async()=>{
  const {page,context,observed}=await fixture();let resume;
  try {
    await enter(page,2);observed.pauseUpload=new Promise(resolve=>{resume=resolve;});
    await page.locator('[data-inv-action="submit-damage"]').click();await expect.poll(()=>observed.uploads.length).toBe(1);
    await page.evaluate(async()=>{window.yard=28;await window.inventory.open('damage');});await enter(page);
    await page.locator('[data-damage-quantity="pieces"]').fill('4');resume();observed.pauseUpload=null;
    const original=()=>page.evaluate(async()=>window.MBBSDamageDraftCache.create().load('actor-a:1'));
    await expect.poll(async()=>(await original())?.photos[0]).toBe('r2://test/1.jpg');
    const retained=await original();assert.equal(retained.photos[1],photo);assert.equal(retained.values.pieces,'18');
    assert.equal(observed.uploads.length,1);assert.equal(observed.posts.length,0);
    await expect(page.locator('[data-damage-quantity="pieces"]')).toHaveValue('4');
    await page.evaluate(async()=>{window.yard=1;await window.inventory.open('damage');});
    await expect(page.locator('.damage-photos img')).toHaveCount(2);
    await page.locator('[data-inv-action="submit-damage"]').click();await expect.poll(()=>observed.posts.length).toBe(1);
    assert.equal(observed.uploads.length,2);assert.ok(observed.uploads.every(upload=>upload.locationId===1));
    assert.equal(observed.posts[0].requestId,retained.requestId);assert.equal(observed.posts[0].locationId,1);
  } finally {resume?.();await context.close();}
});
