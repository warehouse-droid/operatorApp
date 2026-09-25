import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {chromium,expect as baseExpect} from '@playwright/test';
import sharp from 'sharp';

const expect=baseExpect.configure({timeout:20000});
const root='test-artifacts/driver-workflow';
const base='http://127.0.0.1:3000';
const control='http://127.0.0.1:3102';
const browser=await chromium.launch({args:['--no-sandbox']});
const report={passed:false,scenarios:[],pageErrors:[],serverErrors:[],layouts:[],timings:[]};
const picture={name:'isolated-delivery.jpg',mimeType:'image/jpeg',buffer:await sharp({create:{width:800,height:600,channels:3,background:{r:61,g:132,b:204}}}).jpeg().toBuffer()};
let activePage;let activeContext;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(path='/status',method='GET'){
 const response=await fetch(control+path,{method});const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;
}
async function current(page){return page.evaluate(()=>typeof currentJob==='undefined'||!currentJob?null:{id:currentJob.jobId,type:currentJob.stopType,status:currentJob.status,refs:currentJob.orderRefs||[],requiredPhotos:currentJob.requiredPhotos||0});}
async function layout(page,label){
 const result=await page.evaluate(()=>({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+1,
  dialogs:[...document.querySelectorAll('dialog[open],.photo-modal')].filter(e=>e.getClientRects().length).map(e=>{const b=e.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom};})}));
 assert.equal(result.overflow,false,label+' has horizontal overflow');
 for(const box of result.dialogs){assert.ok(box.left>=-1&&box.right<=result.width+1,label+' dialog exceeds width');}
 report.layouts.push({label,...result});
}
async function signature(page,{save=false}={}){
 await page.locator('[data-action="sor-signature"]').last().click();
 await expect(page.locator('dialog.sor-signature-dialog')).toBeVisible();
 await expect(page.locator('.sor-signature-terms')).toContainText('acknowledge receipt');
 await layout(page,'signature-popup');
 if(!save){await page.locator('[data-sor-cancel]').click();await expect(page.locator('dialog')).toHaveCount(0);return;}
 await page.locator('[data-sor-save]').click();await expect(page.locator('[data-sor-status]')).toContainText('Please draw');
 const canvas=page.locator('dialog canvas');await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();
 await page.mouse.move(box.x+25,box.y+45);await page.mouse.down();await page.mouse.move(box.x+box.width-25,box.y+100,{steps:15});await page.mouse.up();
 await page.locator('[name="signer"]').fill('Isolated customer');
 await page.screenshot({path:root+'/signature-popup.png',fullPage:true});
 await page.locator('[data-sor-save]').click();await expect(page.locator('dialog')).toHaveCount(0);
}
async function openPhotos(page){
 if(await page.locator('.photo-modal').count())return;
 const show=page.locator('[data-action="show-photo"]');
 await expect(show).toBeEnabled();await show.click();await expect(page.locator('.photo-modal')).toBeVisible();
}
async function choosePhoto(page,index,source){
 const action=source==='camera'?'take-photo':'choose-gallery-photo';
 const chooser=page.waitForEvent('filechooser');
 await page.locator(`[data-action="${action}"][data-photo-index="${index}"]`).click();
 await (await chooser).setFiles(picture);
 await expect(page.locator('.photo-grid .photo-slot').nth(index).locator('.photo-preview img')).toBeVisible();
}
async function approveLocation(page){
 const override=page.locator('[data-action="override-location"]').first();
 await expect.poll(async()=>await override.isVisible()||await page.locator('[data-job-confirm]').first().isEnabled(),{timeout:25000}).toBe(true);
 if(await override.isVisible())await override.click();
}
async function runJourney(mode){
 const offline=mode==='offline';
 await fixture('/mode?offline='+offline,'POST');
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1,serviceWorkers:'allow'});
 activeContext=context;await context.tracing.start({screenshots:true,snapshots:true,sources:true});
 await context.addInitScript(()=>localStorage.setItem('mbbs.ui.language','en'));
 const page=await context.newPage();activePage=page;
 page.on('pageerror',error=>report.pageErrors.push({mode,message:error.message}));
 page.on('response',response=>{if(response.url().startsWith(base+'/api/')&&response.status()>=500)report.serverErrors.push({mode,url:new URL(response.url()).pathname,status:response.status()});});
 const began=Date.now();
 await page.goto(base+'/driver',{waitUntil:'domcontentloaded'});
 await expect(page.locator('#driverLogin')).toBeVisible();
 await page.locator('#driverLogin').fill('workflow-'+mode);await page.locator('#driverPassword').fill('incorrect');
 await page.locator('[data-form="login"] button[type="submit"]').click();
 await expect(page.locator('.login-panel .message')).toContainText('Invalid driver login');
 await page.locator('#driverLogin').fill('workflow-'+mode);await page.locator('#driverPassword').fill('isolated-workflow');
 await page.locator('[data-form="login"] button[type="submit"]').click();
 await expect(page.locator('.job-panel')).toBeVisible();
 await layout(page,mode+'-route');
 await page.waitForFunction(()=>navigator.serviceWorker.controller!==null,{},{timeout:20000});
 assert.equal(await page.evaluate(()=>isSecureContext),true);
 await expect(page.locator('.map-button')).toHaveAttribute('href',/google\.com\/maps\/dir/);
 report.timings.push({phase:mode+'-login',ms:Date.now()-began});
 console.log(mode+': login and route ready');
 const first=await current(page);assert.equal(first.type,'pickup');assert.equal(await page.locator('[data-action="sor-signature"]').count(),0);
 // Exercise a real break and resume before beginning the route.
 await page.locator('[data-action="start-rest"]').click();
 await expect(page.locator('[data-action="end-rest"]')).toBeVisible();await page.locator('[data-action="end-rest"]').click();
 await expect(page.locator('.job-panel')).toBeVisible();
 const expected=(await fixture()).routes['workflow-'+mode];
 const completed=[];
 for(let index=0;index<expected.length;index++){
  let job=await current(page);assert.ok(job,mode+' missing route job '+index);
  assert.equal(job.id,expected[index].jobId);
  if(job.status!=='in_progress'){
   await page.locator('[data-action="start-job"]').click();
   await expect.poll(async()=>(await current(page))?.status).toBe('in_progress');
  }
  await approveLocation(page);
  const isSor=job.type==='dropoff'&&job.refs.some(ref=>ref.startsWith('SOR'));
  const sign=isSor&&(offline||job.refs.includes('SOR99881003'));
  if(isSor){await signature(page,{save:sign});}
  else {assert.equal(await page.locator('[data-action="sor-signature"]').count(),0);}
  if(offline&&job.type==='dropoff'&&index===1){
   // Real airplane-mode transition: use installed service worker and IndexedDB.
   await expect.poll(()=>page.evaluate(()=>Boolean(offlineManifest?.manifestId))).toBe(true);
   await context.setOffline(true);await page.reload({waitUntil:'domcontentloaded'});
   await expect(page.locator('.job-panel')).toBeVisible();assert.equal((await current(page)).id,job.id);
   assert.equal(await page.evaluate(async()=>{try{await fetch('/api/driver/network-health');return false;}catch{return true;}}),true);
   await approveLocation(page);
   report.scenarios.push('Installed PWA reopens offline with the same active stop');
  }
  if(job.requiredPhotos){
   await openPhotos(page);
   if(isSor)await signature(page,{save:false});
   await expect(page.locator('.photo-modal [data-action="complete-job"]')).toBeDisabled();
   await choosePhoto(page,0,'camera');
   await expect(page.locator('.photo-modal [data-action="complete-job"]')).toBeDisabled();
   await page.locator('[data-driver-photo-remark]').fill('Workflow photo note '+index);
   // Online-only mode deliberately disables local ordinary photo/note drafts.
   // Exercise refresh recovery under the existing offline-enabled contract.
   if(offline&&index===1){
    await page.reload({waitUntil:'domcontentloaded'});await expect(page.locator('.job-panel')).toBeVisible();
    assert.equal((await current(page)).id,job.id);await approveLocation(page);await openPhotos(page);
    await expect(page.locator('.photo-grid .photo-slot').first().locator('img')).toBeVisible();
    await expect(page.locator('[data-driver-photo-remark]')).toHaveValue('Workflow photo note '+index);
    report.scenarios.push(mode+': photo and note survive reload');
   }
   await choosePhoto(page,1,'gallery');
   await page.setViewportSize({width:320,height:568});await layout(page,mode+'-photos-small');
   const complete=page.locator('.photo-modal [data-action="complete-job"]');await expect(complete).toBeEnabled();
   await complete.scrollIntoViewIfNeeded();
   const point=await complete.evaluate(e=>{const b=e.getBoundingClientRect();const top=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return top===e||e.contains(top);});
   assert.equal(point,true,'Complete Stop is covered by another element');
   await page.screenshot({path:root+'/'+mode+'-photos-small.png',fullPage:true});
   await complete.click();await page.setViewportSize({width:390,height:844});
  }else{
   const complete=page.locator('[data-action="complete-job"]').last();await expect(complete).toBeEnabled();await complete.click();
  }
  await expect.poll(async()=>(await current(page))?.id,{timeout:25000}).not.toBe(job.id);
  completed.push({id:job.id,type:job.type,refs:job.refs,signed:sign});
  console.log(mode+': completed '+job.type+' '+job.refs.join(','));
 }
 if(offline){
  const before=await fixture();
  assert.ok(before.records.filter(row=>row.driver_login==='workflow-offline'&&row.status==='complete').length<completed.length,'Offline work unexpectedly reached server');
  await context.setOffline(false);
 }
 await expect.poll(async()=>{
  const state=await fixture();return state.records.filter(row=>row.driver_login==='workflow-'+mode&&row.status==='complete').length;
 },{timeout:60000}).toBe(completed.length);
 const state=await fixture();const records=state.records.filter(row=>row.driver_login==='workflow-'+mode);
 for(const job of completed){
  const saved=records.find(row=>row.job_id===job.id);assert.ok(saved);assert.equal(saved.status,'complete');
  assert.equal(Boolean(saved.signature),job.signed);
  if(job.type==='dropoff')assert.equal(saved.photos,2);
  if(job.signed){assert.equal(saved.signature.signedBy,'Isolated customer');assert.match(saved.signature.terms,/acknowledge receipt/);}
 }
 assert.equal(state.events.filter(row=>row.driver_login==='workflow-'+mode&&row.status!=='applied').length,0,'Offline event did not apply cleanly');
 // History and return navigation must remain usable on a narrow display.
 const restEnd=page.locator('[data-action="end-rest"]');if(await restEnd.isVisible())await restEnd.click();
 await page.locator('[data-action="open-history"]').first().click();await expect(page.locator('.history-panel')).toBeVisible();
 await page.setViewportSize({width:320,height:568});await layout(page,mode+'-history-small');
 await page.screenshot({path:root+'/'+mode+'-history.png',fullPage:true});
 await page.locator('[data-action="back-job"]').click();
 await expect(page.locator('.history-panel')).toHaveCount(0);
 await page.reload({waitUntil:'domcontentloaded'});await expect(page.locator('#driverLogin')).toHaveCount(0);
 report.scenarios.push({mode,completed,photosStored:records.reduce((sum,row)=>sum+row.photos,0),signatureCount:records.filter(row=>row.signature).length});
 await context.tracing.stop({path:root+'/'+mode+'-trace.zip'});await context.close();activePage=null;activeContext=null;
}
try{
 for(let attempt=0;attempt<30;attempt++){try{const r=await fetch(base+'/health');if(r.ok)break;}catch{}await sleep(1000);}
 report.sourceHashes={};
 for(const file of ['driver.js','driver.html','driver-service-worker.js']){
  const response=await fetch(base+'/'+file);assert.equal(response.status,200);
  report.sourceHashes['public/'+file]=crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
 }
 await runJourney('online');await runJourney('offline');
 assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.serverErrors,[]);
 report.storage=(await fixture()).storeStats;assert.ok(report.storage.uploads>0&&report.storage.reads>0);
 report.passed=true;console.log(JSON.stringify(report));
}catch(error){
 report.error=error.stack;console.error(error);
 if(activePage){await activePage.screenshot({path:root+'/failure.png',fullPage:true}).catch(()=>{});report.visibleText=await activePage.locator('body').innerText().catch(()=>'');report.clientState=await activePage.evaluate(()=>({job:typeof currentJob==='undefined'?null:currentJob,offlineStatus:document.getElementById('driverOfflineStatus')?.innerText})).catch(()=>null);}
 if(activeContext)await activeContext.tracing.stop({path:root+'/failure-trace.zip'}).catch(()=>{});
 process.exitCode=1;
}finally{report.finishedAt=new Date().toISOString();writeFileSync(root+'/result.json',JSON.stringify(report,null,2));await browser.close();}
