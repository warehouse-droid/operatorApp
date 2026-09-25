import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
const browser=await chromium.launch({args:['--no-sandbox']});
const errors=[];
const job={jobId:'sor-signature-job',planId:1,planDate:'2026-09-24',stopType:'dropoff',status:'in_progress',startedAt:'2026-09-24T09:00:00Z',location:'Customer site',address:'77 Site Road',orderRefs:['SOR00188'],orders:[],requiredPhotos:2,customerSignaturePrompt:{terms:'Delivery terms <script>window.hostile=true</script>',revision:1,orderRefs:['SOR00188']}};
try {
 const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});
 await page.coverage.startJSCoverage({resetOnNavigation:false});
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('http://localhost:32189/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname.startsWith('/api/'))return route.fulfill({contentType:'application/json',body:JSON.stringify(url.pathname.includes('pwa')?{currentVersion:'2026.08.12.3',minimumVersion:'2026.08.12.3'}:{})});
  const file=url.pathname==='/driver'?'driver.html':url.pathname.slice(1);
  try {await route.fulfill({body:readFileSync(`public/${file}`),contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'});}catch{await route.fulfill({status:404,body:''});}
 });
 await page.addInitScript(()=>{localStorage.setItem('mbbs.ui.language','en');window.EventSource=class{addEventListener(){}close(){}};});
 await page.goto('http://localhost:32189/driver');
 await page.waitForFunction(()=>typeof renderJob==='function');await page.getByRole('heading',{name:'Driver Login',exact:true}).waitFor();
 await page.evaluate(job=>{driver={name:'Driver test',login:'test'};currentJob=job;driverPwaVersionCheckComplete=true;driverIdentityValidated=true;renderJob();},job);
 await expect(page.locator('[data-action="sor-signature"]')).toBeVisible();
 await page.locator('[data-action="sor-signature"]').click();
 await expect(page.locator('dialog.sor-signature-dialog')).toBeVisible();
 await expect(page.locator('.sor-signature-terms')).toHaveText(job.customerSignaturePrompt.terms);
 assert.equal(await page.evaluate(()=>window.hostile),undefined);
 await page.locator('[data-sor-save]').click();
 await expect(page.locator('[data-sor-status]')).toContainText('Please draw');
 await page.locator('[data-sor-cancel]').click();
 await expect(page.locator('dialog')).toHaveCount(0);
 await page.evaluate(()=>{offlinePartition={partitionKey:'sor-browser'};offlineStorageAvailable=true;});
 await page.locator('[data-action="sor-signature"]').click();
 const box=await page.locator('canvas').boundingBox();
 await page.mouse.move(box.x+30,box.y+60);await page.mouse.down();await page.mouse.move(box.x+180,box.y+110,{steps:10});await page.mouse.up();
 await page.locator('[name=signer]').fill('Customer Test');
 await page.screenshot({path:'test-artifacts/sor-rentals/driver-signature-popup.png'});
 await page.locator('[data-sor-save]').click();
 await expect(page.locator('dialog')).toHaveCount(0);
 let saved=await page.evaluate(()=>window.SorDriverSignature.read(currentJob,{partitionKey:offlinePartition.partitionKey,draftKey:currentPhotoDraftKey()}));
 assert.equal(saved.metadata.termsRevision,1);assert.equal(saved.metadata.signedBy,'Customer Test');assert.equal(saved.photo.recordType,'driver-customer-signature');
 await page.reload();await page.waitForFunction(()=>typeof renderJob==='function');await page.getByRole('heading',{name:'Driver Login',exact:true}).waitFor();
 await page.evaluate(job=>{driver={name:'Driver test',login:'test'};currentJob=job;offlinePartition={partitionKey:'sor-browser'};offlineStorageAvailable=true;driverPwaVersionCheckComplete=true;driverIdentityValidated=true;renderJob();},job);
 const recovered=await page.evaluate(()=>window.SorDriverSignature.read(currentJob,{partitionKey:offlinePartition.partitionKey,draftKey:currentPhotoDraftKey()}));
 assert.equal(recovered.metadata.photoId,saved.metadata.photoId);
 const adopted=await page.evaluate(()=>window.SorDriverSignature.read(currentJob,{...sorSignatureContext(),manifest:{manifestId:'new-manifest',planId:1,planDate:'2026-09-24',planRevision:1}}));
 assert.equal(adopted?.metadata.photoId,saved.metadata.photoId,'Downloading the offline manifest must retain a signature saved during bootstrap');
 await page.evaluate(()=>{currentJob.customerSignaturePrompt={...currentJob.customerSignaturePrompt,terms:'Newer terms',revision:2};});
 await page.locator('[data-action="sor-signature"]').click();
 await expect(page.locator('.sor-signature-terms')).toHaveText(job.customerSignaturePrompt.terms);
 await page.locator('[data-sor-clear]').click();await page.locator('[data-sor-save]').click();
 await expect(page.locator('[data-sor-status]')).toContainText('Please draw');
 await page.locator('[data-sor-cancel]').click();
 assert.equal((await page.evaluate(()=>window.SorDriverSignature.read(currentJob,sorSignatureContext()))).metadata.photoId,saved.metadata.photoId);
 const online=await page.evaluate(async()=>window.SorDriverSignature.onlinePayload(await window.SorDriverSignature.read(currentJob,sorSignatureContext())));
 assert.match(online.imageDataUrl,/^data:image\/jpeg;base64,/);assert.equal(online.termsRevision,1);
 await page.locator('[data-action="sor-signature"]').click();
 await page.getByRole('button',{name:'Remove saved signature',exact:true}).click();
 await expect(page.locator('dialog')).toHaveCount(0);
 assert.equal(await page.evaluate(()=>window.SorDriverSignature.read(currentJob,sorSignatureContext())),null);
 await page.locator('[data-action="sor-signature"]').click();
 const replacement=await page.locator('canvas').boundingBox();
 await page.mouse.move(replacement.x+30,replacement.y+60);await page.mouse.down();await page.mouse.move(replacement.x+180,replacement.y+110,{steps:10});await page.mouse.up();
 await page.locator('[data-sor-save]').click();await expect(page.locator('dialog')).toHaveCount(0);
 saved=await page.evaluate(()=>window.SorDriverSignature.read(currentJob,sorSignatureContext()));
 assert.equal(saved.metadata.termsRevision,2);assert.equal(saved.terms,'Newer terms');
 const rejected=await page.evaluate(async()=>{
  const signature=await window.SorDriverSignature.read(currentJob,{partitionKey:offlinePartition.partitionKey,draftKey:currentPhotoDraftKey()});
  try{await window.DriverOfflineDB.queueEvent('sor-browser',{eventType:'job_completed',jobId:currentJob.jobId,requiredPhotoCount:2,photos:[signature.photo],details:{customerSignature:signature.metadata}});return '';}
  catch(error){return error.message;}
 });
 assert.match(rejected,/2 saved photos/);
 const queued=await page.evaluate(async()=>{
  const signature=await window.SorDriverSignature.read(currentJob,{partitionKey:offlinePartition.partitionKey,draftKey:currentPhotoDraftKey()});
  const normal=[];
  for(const ordinal of [0,1])normal.push(await window.DriverOfflineDB.saveDraftPhoto('sor-browser',currentPhotoDraftKey(),{...signature.photo,photoId:window.DriverOfflineDB.createUuid(),ordinal,recordType:'driver-dropoff-photo'}));
  return window.DriverOfflineDB.queueEvent('sor-browser',{eventType:'job_completed',jobId:currentJob.jobId,requiredPhotoCount:2,photos:[...normal,signature.photo],details:{customerSignature:signature.metadata}});
 });
 assert.equal(queued.photoIds.length,3);assert.equal(queued.details.customerSignature.photoId,saved.metadata.photoId);
 assert.equal(await page.evaluate(()=>window.SorDriverSignature.read(currentJob,{partitionKey:offlinePartition.partitionKey,draftKey:currentPhotoDraftKey()})),null);
 await page.evaluate(()=>{currentJob={...currentJob,jobId:'different-stop'};});
 assert.equal(await page.evaluate(()=>window.SorDriverSignature.read(currentJob,{partitionKey:offlinePartition.partitionKey,draftKey:currentPhotoDraftKey()})),null);
 await page.evaluate(evidence=>{const host=document.createElement('div');host.id='signature-history-proof';host.style.cssText='position:fixed;inset:10px;z-index:10000;background:white;overflow:auto';host.innerHTML=renderSorSignatureHistory(evidence);document.body.append(host);},{...online,orderRefs:['SOR00188'],imageReference:online.imageDataUrl,terms:job.customerSignaturePrompt.terms});
 await expect(page.locator('#signature-history-proof img')).toHaveAttribute('src',online.imageDataUrl);
 assert.equal(await page.locator('#signature-history-proof script').count(),0);
 await page.locator('#signature-history-proof summary').click();
 await expect(page.locator('#signature-history-proof details p')).toHaveText(job.customerSignaturePrompt.terms);
 assert.deepEqual(errors,[]);
 writeFileSync('test-artifacts/sor-rentals/driver-browser-coverage.json',JSON.stringify(await page.coverage.stopJSCoverage()));
 writeFileSync('test-artifacts/sor-rentals/browser-result.json',JSON.stringify({passed:true,checks:['driver button','optional popup','plain T&C','empty signature rejected','saved offline','refresh recovery','offline bootstrap recovery','original terms retained','Clear and Cancel','remove and re-sign','online JPEG payload','signature excluded from required photo count','atomic event evidence ownership','stop isolation']},null,2));
} finally {await browser.close();}
