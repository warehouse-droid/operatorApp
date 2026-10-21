/* global window,document,localStorage */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';

let browser;
const coverage=[];
const active={id:73,title:'HUNT 20261002',location_id:1,status:'in_progress',owner_id:'operator',attempt:1,revision:2,counted:0,total:1,
  items:[{item_id:2278,item_name:'BWS-HUNT70S-RDM-SM',stock_unit:'SQFT',to_lyr:12.79,count:null}]};
before(async()=>{browser=await chromium.launch({headless:true,args:['--no-sandbox']});});
after(async()=>{await writeFile('test-artifacts/count-sheet-refresh-browser-coverage.json',JSON.stringify(coverage));await browser.close();});
async function fixture({resume=false,owned=false,status='in_progress',refresh,detail}={}) {
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),calls=[];
  const sheet={...active,status};
  page.setDefaultTimeout(6000);await page.coverage.startJSCoverage({resetOnNavigation:false});
  await page.route('https://count.test/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/') {await route.fulfill({contentType:'text/html',body:'<main id="root"></main>'});return;}
    calls.push({path,method:route.request().method(),body:route.request().postDataJSON()});
    if(path.endsWith('/refresh-inventory')) {
      if(refresh) {await refresh(route,sheet);return;}
      await route.fulfill({json:sheet});return;
    }
    if(path==='/api/count-sheets') {await route.fulfill({json:[{...sheet,status:resume || owned?status:'available'}]});return;}
    if(detail) {await detail(route,sheet);return;}
    await route.fulfill({json:sheet});
  });
  await page.goto('https://count.test/');
  await page.addScriptTag({content:await readFile('public/counting-calculator.js','utf8')});
  await page.addScriptTag({content:await readFile('public/damage-draft-cache.js','utf8')});
  let source=await readFile('public/operator-inventory.js','utf8');
  if(process.env.COUNT_REFRESH_BROWSER_MUTANT) {
    const anchor="if(sheet.status==='in_progress') {";
    assert.equal(source.split(anchor).length,2);source=source.replace(anchor,'if(true) {');
    process.stderr.write('COUNT_REFRESH_BROWSER_MUTATION_APPLIED\n');
  }
  await page.addScriptTag({content:source+'\n//# sourceURL=https://count.test/operator-inventory.js'});
  await page.evaluate(({resume:resumeSheet})=>{
    if(resumeSheet) {localStorage.setItem('mbbs.inventory.sheet.operator.1','73');}
    window.inventory=window.MBBSOperatorInventory.create({root:document.getElementById('root'),actor:()=>({id:'operator'}),location:()=>1,locationLabel:()=> '3445',
      escape:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),toast:()=>{},
      shell:(title,_yard,body,buttons)=>{document.getElementById('root').innerHTML=`<h1>${title}</h1>${buttons}${body}`;},
      back:()=>{document.getElementById('root').innerHTML='<p data-left>Inventory menu</p>';},
      api:async(path,options)=>{const response=await fetch(path,{...options,headers:{'content-type':'application/json'}}),body=await response.json();if(!response.ok){throw Object.assign(new Error(body.error),{status:response.status});}return body;}});
    void window.inventory.open('count-sheets');
  },{resume});
  return {page,context,calls,finish:async()=>{coverage.push(...await page.coverage.stopJSCoverage());await context.close();}};
}
test('U1: taking a sheet waits for its targeted refresh before showing count controls',async()=>{
  let release,started=false;
  const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture({refresh:async(route,sheet)=>{started=true;await gate;await route.fulfill({json:sheet});}});
  try {
    await f.page.locator('[data-inv-action="take"]').click();
    await expect.poll(()=>started).toBe(true);
    await expect(f.page.locator('[data-sheet-refresh]')).toContainText('Refreshing');
    await expect(f.page.locator('[data-inv-action="count-item"]')).toHaveCount(0);
    release();await expect(f.page.locator('[data-inv-action="count-item"]')).toBeVisible();
    assert.deepEqual(f.calls.filter(c=>c.path.endsWith('/refresh-inventory')).map(c=>c.method),['POST']);
    await f.page.locator('[data-inv-action="count-item"]').click();
    for(const key of ['5','=']) {await f.page.locator(`[data-key="${key}"]`).click();}
    await expect(f.page.locator('[data-count-total]')).toHaveText('63.95 SQFT');
    await expect(f.page.locator('#root')).not.toContainText('767.24');
    await f.page.locator('[data-inv-action="confirm-count"]').click();
    await expect.poll(()=>f.calls.some(c=>c.path.endsWith('/line'))).toBe(true);
  } finally {release();await f.finish();}
});
test('U1: automatic resume and the Refresh button each fetch current sheet inventory',async()=>{
  const f=await fixture({resume:true});
  try {
    await expect(f.page.locator('[data-inv-action="count-item"]')).toBeVisible();
    assert.equal(f.calls.filter(c=>c.path.endsWith('/refresh-inventory')).length,1);
    await f.page.locator('[data-inv-action="refresh"]').click();
    await expect.poll(()=>f.calls.filter(c=>c.path.endsWith('/refresh-inventory')).length).toBe(2);
    await expect(f.page.locator('[data-inv-action="count-item"]')).toBeVisible();
  } finally {await f.finish();}
});
test('U1: Resume from the sheet list refreshes the assigned inventory',async()=>{
  const f=await fixture({owned:true});
  try {
    await f.page.locator('[data-inv-action="open-sheet"]').click();
    await expect(f.page.locator('[data-inv-action="count-item"]')).toBeVisible();
    assert.equal(f.calls.filter(c=>c.path.endsWith('/refresh-inventory')).length,1);
  } finally {await f.finish();}
});
test('U1: failed entry refresh hides count controls and Retry recovers the same sheet',async()=>{
  let attempts=0;
  const f=await fixture({resume:true,refresh:async(route,sheet)=>{attempts++;await route.fulfill(attempts===1?{status:503,json:{error:'Could not refresh this count sheet’s stock. Please retry.'}}:{json:sheet});}});
  try {
    await expect(f.page.locator('[role="alert"]')).toContainText('Please retry');
    await expect(f.page.locator('[data-inv-action="count-item"]')).toHaveCount(0);
    await expect(f.page.locator('[data-inv-action="confirm-count"]')).toHaveCount(0);
    await f.page.locator('[data-inv-action="retry-sheet-refresh"]').click();
    await expect(f.page.locator('[data-inv-action="count-item"]')).toBeVisible();assert.equal(attempts,2);
    assert.equal(await f.page.evaluate(()=>localStorage.getItem('mbbs.inventory.sheet.operator.1')),'73');
  } finally {await f.finish();}
});
test('U1: submitted sheet review preserves history and skips a stock refresh',async()=>{
  const f=await fixture({resume:true,status:'submitted'});
  try {
    await expect(f.page.locator('[data-sheet-status]')).toHaveText('Submitted');
    await expect(f.page.locator('[data-inv-action="submit-sheet"]')).toHaveCount(0);
    assert.equal(f.calls.some(c=>c.path.endsWith('/refresh-inventory')),false);
  } finally {await f.finish();}
});
test('U2: leaving during a delayed refresh ignores the late response',async()=>{
  let release,started=false;const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture({resume:true,refresh:async(route,sheet)=>{started=true;await gate;await route.fulfill({json:sheet});}});
  try {
    await expect.poll(()=>started).toBe(true);
    await f.page.locator('[data-inv-action="menu"]').click();await expect(f.page.locator('[data-left]')).toBeVisible();
    const response=f.page.waitForResponse('**/refresh-inventory');release();await response;
    await f.page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,30)));
    await expect(f.page.locator('[data-left]')).toBeVisible();
    await expect(f.page.locator('[data-inv-action="count-item"]')).toHaveCount(0);
  } finally {release();await f.finish();}
});
test('U2: leaving while the initial sheet read is pending ignores its late result',async()=>{
  let release,started=false;const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture({resume:true,detail:async(route,sheet)=>{started=true;await gate;await route.fulfill({json:sheet});}});
  try {
    await expect.poll(()=>started).toBe(true);
    await f.page.locator('[data-inv-action="menu"]').click();await expect(f.page.locator('[data-left]')).toBeVisible();
    const response=f.page.waitForResponse('**/api/count-sheets/73');release();await response;
    await f.page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,30)));
    await expect(f.page.locator('[data-left]')).toBeVisible();
    assert.equal(f.calls.some(c=>c.path.endsWith('/refresh-inventory')),false);
  } finally {release();await f.finish();}
});
test('U1: an inaccessible remembered sheet clears the saved link and reports the error',async()=>{
  const f=await fixture({resume:true,detail:route=>route.fulfill({status:403,json:{error:'This sheet belongs to another operator.'}})});
  try {
    await expect(f.page.locator('[role="alert"]')).toContainText('another operator');
    assert.equal(await f.page.evaluate(()=>localStorage.getItem('mbbs.inventory.sheet.operator.1')),null);
    await expect(f.page.locator('[data-inv-action="count-item"]')).toHaveCount(0);
  } finally {await f.finish();}
});
