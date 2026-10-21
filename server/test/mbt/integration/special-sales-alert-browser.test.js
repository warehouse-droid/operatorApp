/* global localStorage, window, StorageEvent */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
let browser,capture=0;
const out='test-artifacts/special-workflow-review/request-enhancements-20260928';
before(async()=>{await mkdir(out,{recursive:true});browser=await chromium.launch({headless:true,args:['--no-sandbox']});});
after(async()=>browser?.close());
async function fixture(role='sales',publicSales=false){
 const context=await browser.newContext({serviceWorkers:'block'});await context.addInitScript(()=>localStorage.setItem('mbbs.staff.token','first-user'));
 const page=await context.newPage();await page.coverage.startJSCoverage({resetOnNavigation:false});
 const state={role,publicSales,status:200,calls:0,counts:{awaitCustomerConfirmation:1,dispatchArrangement:2,waitForProduction:3,total:6},hold:null};
 await page.route('**/*',async route=>{
 const path=new URL(route.request().url()).pathname;
 if(path==='/api/auth/me')return route.fulfill({json:{operator:{id:'test',role:state.role,roles:[state.role],publicSales:state.publicSales}}});
 if(path.endsWith('/alerts')){state.calls++;const data={...state.counts},status=state.status;if(state.hold)await state.hold;return route.fulfill({status,json:data}).catch(()=>{});}
 if(path==='/sales-special-alert.js')return route.fulfill({body:await readFile('public/sales-special-alert.js'),contentType:'application/javascript'});
 if(path==='/preview')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="UTF-8"></head><body><header class="topbar"><div class="topbar-actions"></div></header><script src="/sales-special-alert.js"></script></body></html>'});
 return route.fulfill({json:{}});
 });
 await page.goto('http://localhost/preview');
 return {page,state,close:async()=>{await writeFile(`${out}/browser-coverage-alert-${++capture}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}};
}
const refresh=page=>page.evaluate(()=>window.MBBSSalesSpecialAlert.refresh());
test('Sales alert validates counts, retains them through temporary failures, hides disabled workflow and clears rejected access',async()=>{
 const {page,state,close}=await fixture();try{
 const alert=page.locator('.sales-special-alert');await expect(alert).toHaveAccessibleName('6 special requests: 1 await customer confirmation, 2 dispatch arrangement, 3 wait for production / Transfer');
 state.status=500;await refresh(page);await expect(alert).toContainText('6');state.status=200;state.counts.total=7;await refresh(page);await expect(alert).toContainText('6');
 state.status=404;await refresh(page);await expect(alert).toBeHidden();state.status=200;state.counts.total=6;await refresh(page);await expect(alert).toBeVisible();
 state.status=403;await refresh(page);await expect(alert).toHaveCount(0);
 }finally{await close();}
});
test('Sales alert drops a late response when a different user signs in',async()=>{
 const {page,state,close}=await fixture();let release;try{
 const alert=page.locator('.sales-special-alert');await expect(alert).toBeVisible();state.hold=new Promise(resolve=>{release=resolve;});const previous=state.calls;
 await page.evaluate(()=>void window.MBBSSalesSpecialAlert.refresh());await expect.poll(()=>state.calls).toBe(previous+1);
 state.role='scm';await page.evaluate(()=>{localStorage.setItem('mbbs.staff.token','second-user');window.dispatchEvent(new StorageEvent('storage',{key:'mbbs.staff.token'}));});
 release();state.hold=null;await expect(alert).toHaveCount(0);await refresh(page);await expect(alert).toHaveCount(0);
 }finally{release?.();await close();}
});
for(const [role,publicSales] of [['scm',false],['sales',true],['dispatcher',false]])test(`${role}${publicSales?' public':''} sees no Sales alert data`,async()=>{
 const {page,state,close}=await fixture(role,publicSales);try{await page.waitForTimeout(100);assert.equal(state.calls,0);await expect(page.locator('.sales-special-alert')).toHaveCount(0);}finally{await close();}
});
