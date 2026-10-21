/* global window,localStorage,EventTarget */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
const out='test-artifacts/scm-line-visibility-20261016',coverage=[];
let browser;
before(async()=>{await mkdir(out,{recursive:true});browser=await chromium.launch({headless:true,args:['--no-sandbox']});});
after(async()=>{await browser?.close();await writeFile(out+'/visibility-browser-coverage.json',JSON.stringify(coverage));});
function record(kind) {
  const line=(id,productName,salesDecision,supplyStatus)=>({id,itemId:101,productName,itemName:productName,quantity:2,uom:'PCS',requiredDate:'2099-02-01',salesDecision,supplyStatus,
    vendorName:'TEST Vendor',responseVendorName:'TEST Vendor',vendorId:331,responseVendorId:331,vendorYard:'TEST Dock',destinationLocationId:1,destinationName:'3445'});
  return {id:1,requestRef:'REQ-VISIBILITY',revision:3,status:'submitted',bucket:'pending',requestType:kind==='special'?'special':'regular',workflowKind:kind,workflowVersion:2,
    regular:{deliveryMethod:kind},stage:'new_enquiry',closeStatus:'active',storeName:'3445',storeLocationId:1,destinationLocationId:1,destinationName:'3445',customerName:'TEST Customer',
    vendorId:331,vendorName:'TEST Vendor',fulfillmentMethod:'yard_pickup',inquiryDate:'2099-01-01',events:[],salesOrderLines:[],purchaseOrderLines:[],media:[],transfers:[],readinessAlerts:[],
    lines:[line(1,'Active pending','pending','in_stock'),line(2,'Sales withdrawal before stock check','declined',null),line(3,'Customer decline after stock check','declined','in_stock'),
      {...line(4,'Restored active line','accepted','in_stock'),declineRestore:{}},line(5,'Update requested','request_update','no_stock')]};
}
async function fixture(kind,{allDeclined=false,width=1440}={}) {
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
  await context.addInitScript(()=>{localStorage.setItem('mbbs.staff.token','test-visibility');window.EventSource=class extends EventTarget{close(){}};});
  const page=await context.newPage();page.setDefaultTimeout(4000);await page.coverage.startJSCoverage({resetOnNavigation:false});
  const state={record:record(kind),posts:[],errors:[]};if(allDeclined)state.record.lines.forEach(line=>line.salesDecision='declined');
  page.on('pageerror',error=>state.errors.push(error.message));
  await page.route('**/*',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.startsWith('/api/')) {
      if(path==='/api/auth/me')return route.fulfill({json:{operator:{id:'scm-test',role:'scm',roles:['scm'],yardLocationIds:[]}}});
      if(path.endsWith('/conversation'))return route.fulfill({json:{messages:[],canSend:true,latestEventId:0}});
      if(route.request().method()==='POST') {
        assert.equal(path,'/api/scm/special-stock-requests/1/stock-check');
        const body=route.request().postDataJSON();state.posts.push(body);
        for(const input of body.lines) {
          const line=state.record.lines.find(row=>row.id===input.lineId);Object.assign(line,input);
          if(line.salesDecision==='declined')line.salesDecision='pending';
        }
        state.record.revision++;return route.fulfill({json:state.record});
      }
      if(path.endsWith('/policy'))return route.fulfill({json:{enabled:true}});
      if(/\/(?:special-)?stock-requests\/1$/.test(path))return route.fulfill({json:state.record});
      if(path.endsWith(kind==='special'?'/special-stock-requests':'/stock-requests'))return route.fulfill({json:{requests:[state.record],yards:[],vendors:[],filterOptions:{vendors:[],sourceYards:[],destinationYards:[]}}});
      return route.fulfill({json:{requests:[],vendors:[],count:0,lines:[]}});
    }
    const pathFile=path==='/scm/stock-requests'?'/scm-stock-requests.html':path;
    try{return route.fulfill({body:await readFile('public'+pathFile),contentType:({html:'text/html',css:'text/css',js:'application/javascript'})[pathFile.split('.').at(-1)]||'application/octet-stream'});}
    catch{return route.fulfill({status:404,body:''});}
  });
  await page.goto(`http://localhost/scm/stock-requests?tab=${kind==='special'?'special':'regular'}`);
  return {page,state,close:async()=>{coverage.push(...await page.coverage.stopJSCoverage());await context.close();}};
}
for(const kind of ['special','backorder'])test(`SCM hides withdrawn and customer-declined ${kind} lines before and after stock check`,async()=>{
  const f=await fixture(kind);try {
    const toggle=f.page.getByRole('button',{name:'Show All',exact:true});await expect(toggle).toBeVisible();
    const before=JSON.stringify(f.state.record);
    for(const id of [1,4,5])await expect(f.page.locator(`[data-scm-line-id="${id}"]`)).toBeVisible();
    for(const id of [2,3]){await expect(f.page.locator(`[data-scm-line-id="${id}"]`)).toHaveCount(1);await expect(f.page.locator(`[data-scm-line-id="${id}"]`)).toBeHidden();}
    await toggle.click();const hide=f.page.getByRole('button',{name:'Hide Decline/Revoke',exact:true});await expect(hide).toHaveAttribute('aria-expanded','true');
    for(const id of [1,2,3,4,5])await expect(f.page.locator(`[data-scm-line-id="${id}"]`)).toBeVisible();
    await f.page.screenshot({path:`${out}/${kind}-show-all.png`,fullPage:true});await hide.click();
    for(const id of [2,3])await expect(f.page.locator(`[data-scm-line-id="${id}"]`)).toBeHidden();
    assert.equal(JSON.stringify(f.state.record),before);assert.equal(f.state.posts.length,0);
    await toggle.click();await f.page.reload();await expect(toggle).toBeVisible();await expect(f.page.locator('[data-scm-line-id="2"]')).toBeHidden();assert.deepEqual(f.state.errors,[]);
  }finally{await f.close();}
});

test('SCM toggle preserves unsaved edits and excludes hidden declined revisions from stock-check submissions',async()=>{
  const f=await fixture('special');try {
    const active=f.page.locator('[data-special-stock-line="1"] [name=salesVisibleNote]');await active.fill('Keep active reply');
    await f.page.getByRole('button',{name:'Show All',exact:true}).click();
    await f.page.locator('[data-scm-line-id="2"]').getByRole('button',{name:'Revise stock check',exact:true}).click();
    const revised=f.page.locator('[data-special-stock-line="2"] [name=salesVisibleNote]');await revised.fill('Keep declined draft');
    await f.page.getByRole('button',{name:'Hide Decline/Revoke',exact:true}).click();await expect(active).toHaveValue('Keep active reply');await expect(revised).toBeDisabled();
    await f.page.getByRole('button',{name:'Show All',exact:true}).click();await expect(revised).toHaveValue('Keep declined draft');await expect(revised).toBeEnabled();
    await f.page.getByRole('button',{name:'Hide Decline/Revoke',exact:true}).click();
    await f.page.getByRole('button',{name:'Save stock check',exact:true}).click();await expect.poll(()=>f.state.posts.length).toBe(1);
    assert.deepEqual(f.state.posts[0].lines.map(line=>line.lineId),[1,4,5]);assert.equal(f.state.posts[0].lines[0].salesVisibleNote,'Keep active reply');
    assert.equal(f.state.record.lines[1].salesDecision,'declined');assert.equal(f.state.record.lines[2].salesDecision,'declined');assert.deepEqual(f.state.errors,[]);
  }finally{await f.close();}
});

test('SCM can reveal an entirely declined request on mobile without submitting hidden stock edits',async()=>{
  const f=await fixture('special',{allDeclined:true,width:390});try {
    await expect(f.page.getByRole('button',{name:'Show All',exact:true})).toBeVisible();
    await expect(f.page.locator('[data-scm-lines-empty]')).toBeVisible();
    await f.page.getByRole('button',{name:'Show All',exact:true}).click();await expect(f.page.locator('[data-scm-lines-empty]')).toBeHidden();
    await f.page.locator('[data-scm-line-id="2"]').getByRole('button',{name:'Revise stock check',exact:true}).click();
    await f.page.getByRole('button',{name:'Hide Decline/Revoke',exact:true}).click();
    await expect(f.page.getByRole('button',{name:'Save stock check',exact:true})).toBeDisabled();
    assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));assert.equal(f.state.posts.length,0);assert.deepEqual(f.state.errors,[]);
  }finally{await f.close();}
});
