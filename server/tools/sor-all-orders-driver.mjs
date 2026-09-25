// Disposable replay only: actual planner HTTP APIs and installed Driver PWA.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {readFileSync,writeFileSync} from 'node:fs';
import {chromium,expect as baseExpect} from '@playwright/test';
import sharp from 'sharp';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).pathname,'/mbt_test_driver');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
process.env.DISPATCH_PLANNER_ORDER_POOL_MODE='on';
process.env.PHOTO_UPLOAD_PROVIDER='r2_worker';
process.env.PHOTO_UPLOAD_WORKER_URL='http://127.0.0.1:3101';
process.env.PHOTO_UPLOAD_TOKEN_SECRET='isolated-sor-photo-secret';
process.env.APP_BASE_URL='http://127.0.0.1:3000';
const {app,loadDispatchOrdersForResponse}=await import('../src/server.js');
const {query,closeDb}=await import('../src/db.js');
const {createOperator}=await import('../src/auth-repository.js');
const {replaceDispatchFleetSetup}=await import('../src/dispatch-setup-repository.js');
const {getDriverDayJobs}=await import('../src/driver-repository.js');
const {getSorReturnReadiness}=await import('../src/sor-return-readiness.js');
const {config}=await import('../src/config.js');
assert.equal(config.netsuite.directAccessEnabled,false);
assert.equal(config.dispatch.plannerOrderPoolMode,'on');
const root='test-artifacts/sor-rentals';
const expect=baseExpect.configure({timeout:15000});
const base='http://127.0.0.1:3000';
const report={passed:false,externalAccess:false,planning:[],journeys:[],journeyFailures:[],pageErrors:[],serverErrors:[],dummyAddresses:[],checks:[],clock:'Real browser and server clocks. Eight independent drivers execute each phase in parallel; all ten-second server confirmation guards remain intact.'};
const objects=new Map(),storeStats={uploads:0,reads:0};
const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
// Only the external blob store is simulated. Uploads validate real signed
// tickets and byte limits; the application persists the resulting references.
// Readback is supported but only exercised if the application requests it.
const store=http.createServer(async(req,res)=>{
 res.setHeader('Access-Control-Allow-Origin',base);
 res.setHeader('Access-Control-Allow-Headers','authorization,content-type,x-file-name');
 res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
 if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
 try {
  const parts=String(req.headers.authorization||'').replace(/^Bearer /u,'').split('.');assert.equal(parts.length,3);
  assert.equal(parts[2],crypto.createHmac('sha256',process.env.PHOTO_UPLOAD_TOKEN_SECRET).update(parts[0]+'.'+parts[1]).digest('base64url'));
  const claims=JSON.parse(Buffer.from(parts[1],'base64url'));assert.ok(claims.exp>Date.now()/1000);
  const url=new URL(req.url,'http://127.0.0.1:3101');
  if(req.method==='POST'&&url.pathname==='/upload'){
   assert.equal(claims.scope,'photo-upload');const chunks=[];for await(const chunk of req)chunks.push(chunk);
   let body=Buffer.concat(chunks),type=req.headers['content-type']||'image/jpeg';
   if(type.startsWith('multipart/form-data')){const form=await new Response(body,{headers:{'content-type':type}}).formData();const file=form.get('file');body=Buffer.from(await file.arrayBuffer());type=file.type;}
   assert.ok(body.length&&body.length<=claims.maxBytes);const key=claims.keyPrefix+'/'+crypto.randomUUID()+'.jpg';
   objects.set(key,{body,type});storeStats.uploads++;json(res,200,{key,objectReference:'r2://'+key,byteSize:body.length});return;
  }
  assert.equal(claims.scope,'photo-read');assert.equal(claims.key,url.searchParams.get('key'));
  const saved=objects.get(claims.key);if(!saved){json(res,404,{error:'Object not found'});return;}
  storeStats.reads++;res.writeHead(200,{'content-type':saved.type,'content-length':saved.body.length});res.end(saved.body);
 }catch(error){json(res,400,{error:error.message});}
});
const server=http.createServer(app);
let browser,activePage,activeContext,token,lease;
const sessionId=crypto.randomUUID();
const password='isolated-sor-workflow';
const refs=(await query("SELECT parent_order_ref FROM dispatch_custom_orders WHERE order_kind='sor_rental_return' AND status='open' ORDER BY parent_order_ref")).rows.map(row=>row.parent_order_ref);
assert.equal(refs.length,21,'Must include every eligible rental in the full replay');
const date=(await query("SELECT (now() AT TIME ZONE 'America/Toronto')::date::text AS day")).rows[0].day;
assert.equal((await query('SELECT 1 FROM dispatch_plans WHERE plan_date=$1',[date])).rowCount,0,'Fresh replay clone required');
async function api(path,{method='GET',body,auth=token,expected=200}={}){
 const began=Date.now();const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json',...(lease?{'x-dispatch-edit-lease':lease}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
 const payload=await response.json();assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(payload)}`);
 if(path.startsWith('/api/dispatch/plans'))report.planning.push({method,path,status:response.status,ms:Date.now()-began});return payload;
}
const current=page=>page.evaluate(()=>typeof currentJob==='undefined'||!currentJob?null:{id:currentJob.jobId,type:currentJob.stopType,status:currentJob.status,refs:currentJob.orderRefs||[],requiredPhotos:currentJob.requiredPhotos||0});
const picture={name:'isolated-sor-delivery.jpg',mimeType:'image/jpeg',buffer:await sharp({create:{width:800,height:600,channels:3,background:{r:61,g:132,b:204}}}).jpeg().toBuffer()};
async function driverPage(login){
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'allow'});
 activeContext=context;await context.tracing.start({screenshots:true,snapshots:true,sources:true});
 await context.addInitScript(()=>localStorage.setItem('mbbs.ui.language','en'));
 const page=await context.newPage();activePage=page;
 page.on('pageerror',error=>report.pageErrors.push({login,message:error.message}));
 page.on('response',response=>{if(response.url().startsWith(base+'/api/')&&response.status()>=500)report.serverErrors.push({login,path:new URL(response.url()).pathname,status:response.status()});});
 await page.goto(base+'/driver',{waitUntil:'domcontentloaded'});
 await page.locator('#driverLogin').fill(login);await page.locator('#driverPassword').fill(password);
 await page.locator('[data-form="login"] button[type="submit"]').click();await expect(page.locator('.job-panel')).toBeVisible();
 await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);
 return {page,context};
}
async function approveLocation(page){
 const override=page.locator('[data-action="override-location"]').first();
 await expect.poll(async()=>await override.isVisible()||await page.locator('[data-job-confirm]').first().isEnabled(),{timeout:25000}).toBe(true);
 if(await override.isVisible())await override.click();
}
async function signature(page,save){
 await page.locator('[data-action="sor-signature"]').last().click();await expect(page.locator('dialog.sor-signature-dialog')).toBeVisible();
 await expect(page.locator('.sor-signature-terms')).toContainText('Isolated SOR acceptance terms');
 if(!save){await page.locator('[data-sor-cancel]').click();await expect(page.locator('dialog')).toHaveCount(0);return;}
 const canvas=page.locator('dialog canvas');await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();
 await page.mouse.move(box.x+25,box.y+45);await page.mouse.down();await page.mouse.move(box.x+box.width-25,box.y+100,{steps:15});await page.mouse.up();
 await page.locator('[name="signer"]').fill('Isolated SOR customer');await page.locator('[data-sor-save]').click();await expect(page.locator('dialog')).toHaveCount(0);
}
async function journey(login,expected,completedBefore=[]){
 const {page,context}=await driverPage(login),completed=[...completedBefore];
 expected=expected.filter(job=>!completedBefore.some(done=>done.id===job.jobId));
 try {
 for(let index=0;index<expected.length;index++){
  const began=Date.now(),job=await current(page);assert.ok(job,login+' missing stop '+index);assert.equal(job.id,expected[index].jobId);
  if(job.status!=='in_progress'){await page.locator('[data-action="start-job"]').click();await expect.poll(async()=>(await current(page))?.status).toBe('in_progress');}
  await approveLocation(page);
  const isDelivery=job.type==='dropoff'&&job.refs.some(ref=>/^SOR\d+$/u.test(ref));
  const signed=isDelivery&&index%4===1;
  if(isDelivery)await signature(page,signed);else assert.equal(await page.locator('[data-action="sor-signature"]').count(),0,'Signature button is delivery only');
  if(job.requiredPhotos){
   if(!await page.locator('.photo-modal').count()){await page.locator('[data-action="show-photo"]').click();}
   await expect(page.locator('.photo-modal')).toBeVisible();
   await expect(page.locator('.photo-modal [data-action="complete-job"]')).toBeDisabled();
   for(let photo=0;photo<job.requiredPhotos;photo++){
    const chooser=page.waitForEvent('filechooser');await page.locator(`[data-action="${photo?'choose-gallery-photo':'take-photo'}"][data-photo-index="${photo}"]`).click();await (await chooser).setFiles(picture);
    await expect(page.locator('.photo-grid .photo-slot').nth(photo).locator('.photo-preview img')).toBeVisible();
   }
   await page.locator('[data-driver-photo-remark]').fill('Isolated SOR workflow proof');
   if(index===1){await page.setViewportSize({width:320,height:568});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.screenshot({path:`${root}/${login}-small.png`,fullPage:true});}
   const complete=page.locator('.photo-modal [data-action="complete-job"]');await expect(complete).toBeEnabled();await complete.scrollIntoViewIfNeeded();
   assert.equal(await complete.evaluate(e=>{const b=e.getBoundingClientRect(),top=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return top===e||e.contains(top);}),true);
   await complete.click();await page.setViewportSize({width:390,height:844});
  }else{const complete=page.locator('[data-action="complete-job"]').last();await expect(complete).toBeEnabled();await complete.click();}
  await expect.poll(async()=>(await current(page))?.id,{timeout:25000}).not.toBe(job.id);
  completed.push({...job,signed,ms:Date.now()-began});console.log(login+': '+job.type+' '+job.refs.join(','));
 }
 const records=(await query('SELECT job_id,status,photo_data_urls,job_details FROM driver_job_records WHERE driver_login=$1',[login])).rows;
 for(const job of completed){const saved=records.find(row=>row.job_id===job.id);assert.ok(saved);assert.equal(saved.status,'complete');assert.equal(saved.photo_data_urls.length,job.requiredPhotos);assert.equal(Boolean(saved.job_details.customerSignature),job.signed);if(job.signed)assert.match(saved.job_details.customerSignature.terms,/Isolated SOR acceptance terms/u);}
 const restEnd=page.locator('[data-action="end-rest"]');if(await restEnd.isVisible())await restEnd.click();
 await page.locator('[data-action="open-history"]').first().click();await expect(page.locator('.history-panel')).toBeVisible();
 await page.screenshot({path:`${root}/${login}-history.png`,fullPage:true});await page.locator('[data-action="back-job"]').click();await page.reload({waitUntil:'domcontentloaded'});await expect(page.locator('#driverLogin')).toHaveCount(0);
 report.journeys.push({login,completed,photos:records.reduce((n,row)=>n+row.photo_data_urls.length,0)});
 await context.tracing.stop({path:`${root}/${login}-trace.zip`});await context.close();activeContext=null;activePage=null;
 }catch(error){
  report.journeyFailures.push({login,error:error.stack,clientState:await current(page).catch(()=>null),visibleText:await page.locator('body').innerText().catch(()=>'')});
  await page.screenshot({path:`${root}/${login}-failure.png`,fullPage:true}).catch(()=>{});await context.tracing.stop({path:`${root}/${login}-failure-trace.zip`}).catch(()=>{});await context.close();throw error;
 }
}
try {
 await query('UPDATE mbt_feature_flags SET enabled=false');
 await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='sor_rental_workflow'");
 await query('UPDATE sor_signature_settings SET returns_enabled=true');
 for(const [index,ref] of ['SOR00030','SOR00085','SOR00183','SOR00185','SOR00147'].entries()){
  const address=`${900+index} Isolated Test Road, Toronto, ON`;
  await query('UPDATE sales_orders SET dispatch_address=$2 WHERE tranid=$1',[ref,address]);report.dummyAddresses.push({ref,address,onlyInIsolatedDatabase:true});
 }
 // Keep the contradictory self-pickup memo but exercise its stored Delivery method.
 assert.equal((await query("SELECT sales_order_type FROM sales_orders WHERE tranid='SOR00030'")).rows[0].sales_order_type,'Delivery');
 const username='sor-driver-planner-'+crypto.randomUUID();await createOperator({username,password,displayName:'Isolated SOR dispatcher',role:'admin',roles:['admin']});
 await new Promise(resolve=>server.listen(3000,'127.0.0.1',resolve));await new Promise(resolve=>store.listen(3101,'127.0.0.1',resolve));
 browser=await chromium.launch({args:['--no-sandbox']});
 const staff=await browser.newPage();await staff.goto(base+'/');await staff.locator('[name=username]').fill(username);await staff.locator('[name=password]').fill(password);
 await Promise.all([staff.waitForURL(url=>url.pathname!=='/'),staff.locator('button[type=submit]').click()]);await staff.waitForFunction(()=>Boolean(localStorage.getItem('mbbs.staff.token')));token=await staff.evaluate(()=>localStorage.getItem('mbbs.staff.token'));
 const policy=(await query('SELECT * FROM sor_item_policies ORDER BY item_id LIMIT 1')).rows[0];
 while(Number((await query('SELECT count(*) FROM sor_return_reconcile_queue')).rows[0].count)){
  const result=await api(`/api/admin/sor-auto-returns/items/${policy.item_id}`,{method:'PUT',body:{override:policy.auto_return_override,expectedRevision:Number(policy.revision)}});assert.ok(result.reconciliation.processed>0);assert.equal(result.reconciliation.error,undefined);console.log('Reconciled '+result.reconciliation.processed+' source orders');
 }
 await query("UPDATE sor_signature_settings SET terms='Isolated SOR acceptance terms: I acknowledge receipt of the listed equipment.',revision=revision+1 WHERE singleton");
 await query('INSERT INTO sor_signature_terms_history SELECT revision,terms,updated_at,updated_by FROM sor_signature_settings');
 const all=await loadDispatchOrdersForResponse({type:'SO'}),orders=all.filter(order=>!order.dispatchPlanningRestricted);
 const deliveryRefs=orders.filter(order=>order.type==='SO').map(order=>order.id).sort();
 assert.equal(deliveryRefs.length,23);assert.equal(orders.length,44);
 const itemIdentity=items=>items.map(item=>[String(item.itemId),String(item.lineRowId),Number(item.quantity??item.salesQty)]).sort();
 for(const ref of refs){
  const delivery=orders.find(order=>order.id===ref),collection=orders.find(order=>order.id===ref+'-Return');
  assert.ok(delivery&&collection);assert.equal(delivery.sourceYard,'3445');assert.match(delivery.sourceAddress,/3445 Kennedy Road/u);assert.ok(delivery.address);
  assert.equal(collection.sourceAddress,delivery.address);assert.match(collection.address,/3445 Kennedy Road/u);assert.equal(collection.expectedDeliveryDate,'');
  assert.deepEqual(itemIdentity(collection.items),itemIdentity(delivery.items.filter(item=>item.sorAutoReturn)));
  assert.ok(!delivery.dispatchPlanningRestricted&&!collection.dispatchPlanningRestricted,ref+' unexpectedly restricted');
 }
 report.checks.push('All 21 rental deliveries and 21 returns have matching rental cargo and reversed addresses; returns initially undated');
 report.otherPoolOrders=all.filter(order=>!orders.includes(order)).map(order=>({ref:order.id,restricted:Boolean(order.dispatchPlanningRestricted),reason:order.dispatchPlanningRestrictionReason||'',items:order.items.map(item=>({name:item.itemName,type:item.itemType,autoReturn:item.sorAutoReturn}))}));
 const perPhase=8,deliveryLogins=Array.from({length:perPhase},(_,i)=>'sor-replay-delivery-'+i),returnLogins=Array.from({length:perPhase},(_,i)=>'sor-replay-return-'+i),logins=[...deliveryLogins,...returnLogins];
 const assigned=new Map(logins.map((login,index)=>[login,(index>=perPhase?refs:deliveryRefs).filter((_,n)=>n%perPhase===index%perPhase)]));
 await replaceDispatchFleetSetup({drivers:logins.map(login=>({login,name:login,password,active:true,samsaraEnabled:false})),trucks:logins.map((_,i)=>({plate:`SOR-REPLAY-${String(i).padStart(2,'0')}`,baseYard:'3445',capacityLbs:40000,active:true}))},{activeOnly:false,deactivateMissing:false});
 const fleet=(await query("SELECT id,plate FROM dispatch_trucks WHERE plate LIKE 'SOR-REPLAY-%' ORDER BY plate")).rows;
 const drivers=(await query('SELECT id,login FROM dispatch_drivers WHERE login=ANY($1::text[])',[logins])).rows;
 const trucks=logins.map((login,index)=>({id:String(fleet[index].id),plate:fleet[index].plate,base:'3445',driverLogin:login,driverId:String(drivers.find(d=>d.login===login).id),loads:assigned.get(login).map((ref,n)=>{
  const returning=index>=perPhase,order=orders.find(o=>o.id===ref+(returning?'-Return':''));return {id:`sor-replay-${index}-${n}`,name:order.id,orders:[order.id],driverLogin:login,truckId:String(fleet[index].id),truckPlate:fleet[index].plate,driverSequence:n,plannedStartMinute:480+n*20,plannedFinishMinute:495+n*20,stops:[{id:`sor-pick-${index}-${n}`,type:'pick',orderId:order.id,orderIds:[order.id],location:returning?order.sourceAddress:order.sourceYard},{id:`sor-drop-${index}-${n}`,type:'drop',orderId:order.id,location:order.address}]};
 })}));
 lease=(await api('/api/dispatch/plan-edit-lease/acquire',{method:'POST',body:{planDate:date,sessionId}})).editLeaseToken;assert.ok(lease);
 const plan=await api('/api/dispatch/plans',{method:'POST',body:{planDate:date,sessionId,note:'All SOR replay — isolated dummy addresses only'}});
 assert.ok(plan.digest);const saved=await api(`/api/dispatch/plans/${plan.id}`,{method:'PUT',body:{planDate:date,sessionId,baseRevision:plan.revision,baseDigest:plan.digest,orders,trucks,summary:{}}});assert.notEqual(saved.applied,false);assert.equal(saved.orders.length,44);
 const confirmed=await api(`/api/dispatch/plans/${plan.id}/confirm`,{method:'POST',body:{sessionId,baseRevision:saved.revision,baseDigest:saved.digest}});assert.equal(confirmed.status,'confirmed');report.planId=plan.id;console.log('Confirmed 23 deliveries and 21 returns through planner HTTP APIs');
 const routes={};for(const login of logins){routes[login]=(await getDriverDayJobs(login,{date})).jobs;assert.equal(routes[login].filter(job=>['pickup','dropoff'].includes(job.stopType)).length,assigned.get(login).length*2,login+' all planned stops materialize');}
 const readiness=await getSorReturnReadiness(refs.map(ref=>ref+'-Return'));assert.equal(readiness.length,21);assert.ok(readiness.every(row=>!row.allowed&&row.message.includes('waiting for delivery')));
 const blocked=await driverPage(returnLogins[0]);assert.equal((await current(blocked.page)).id,routes[returnLogins[0]][0].jobId);
 const preflight=[];
 if((await current(blocked.page)).type==='travel'){
  const travel=await current(blocked.page);if(travel.status!=='in_progress'){await blocked.page.locator('[data-action="start-job"]').click();await expect.poll(async()=>(await current(blocked.page))?.status).toBe('in_progress');}
  await approveLocation(blocked.page);await blocked.page.locator('[data-action="complete-job"]').last().click();await expect.poll(async()=>(await current(blocked.page))?.id).not.toBe(travel.id);preflight.push({...travel,signed:false});
 }
 const earlyPickup=await current(blocked.page);assert.equal(earlyPickup.type,'pickup');
 await blocked.page.locator('[data-action="start-job"]').click();await expect(blocked.page.locator('#driverToast')).toContainText('waiting for delivery');
 const denied=await blocked.page.evaluate(async jobId=>{try{await request(`/api/driver/jobs/${encodeURIComponent(jobId)}/start`,{method:'POST',body:'{}'});return {status:200};}catch(error){return {status:error.status,error:error.message};}},earlyPickup.id);
 assert.equal(denied.status,409,JSON.stringify(denied));assert.match(denied.error,/waiting for delivery/u);
 await blocked.page.screenshot({path:root+'/sor-return-before-delivery.png',fullPage:true});await blocked.context.tracing.stop({path:root+'/sor-return-before-delivery-trace.zip'});await blocked.context.close();activeContext=null;activePage=null;
 report.checks.push('All 21 collections are not ready before delivery; actual Driver start API rejects premature collection');
 if(process.env.SOR_PLAN_ONLY==='1'){report.planOnly=true;}else{
  const delivered=await Promise.allSettled(deliveryLogins.map(login=>journey(login,routes[login])));assert.ok(delivered.every(result=>result.status==='fulfilled'),JSON.stringify(report.journeyFailures));
  assert.ok((await getSorReturnReadiness(refs.map(ref=>ref+'-Return'))).every(row=>row.allowed));
  const returned=await Promise.allSettled(returnLogins.map((login,index)=>journey(login,routes[login],index===0?preflight:[])));assert.ok(returned.every(result=>result.status==='fulfilled'),JSON.stringify(report.journeyFailures));
  const completed=(await query("SELECT ref_number,status FROM dispatch_custom_orders WHERE order_kind='sor_rental_return' AND parent_order_ref=ANY($1::text[])",[refs])).rows;assert.equal(completed.length,21);assert.ok(completed.every(row=>row.status==='completed'),JSON.stringify(completed));
  report.checks.push('All 23 eligible deliveries and 21 returns complete through actual PWA with required photos; optional signature saved/skipped; history and reload work');
 }
 assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.serverErrors,[]);report.storage=storeStats;report.refs=refs;report.deliveryRefs=deliveryRefs;report.deliveryOnlyRefs=deliveryRefs.filter(ref=>!refs.includes(ref));
 report.sourceHashes=Object.fromEntries(['src/server.js','src/sor-rental-service.js','src/dispatch-delivery-group-repository.js','src/driver-repository.js','public/driver.js','public/driver.html','public/driver-service-worker.js'].map(file=>[file,crypto.createHash('sha256').update(readFileSync(file)).digest('hex')]));
 report.passed=true;console.log(JSON.stringify({passed:true,planOnly:report.planOnly,orders:orders.length,stops:report.journeys.reduce((n,row)=>n+row.completed.length,0)}));
}catch(error){
 report.error=error.stack;console.error(error);
 if(activePage){await activePage.screenshot({path:root+'/sor-driver-failure.png',fullPage:true}).catch(()=>{});report.visibleText=await activePage.locator('body').innerText().catch(()=>'');report.clientState=await current(activePage).catch(()=>null);}
 if(activeContext)await activeContext.tracing.stop({path:root+'/sor-driver-failure-trace.zip'}).catch(()=>{});
 process.exitCode=1;
}finally{
 report.finishedAt=new Date().toISOString();writeFileSync(root+'/all-orders-driver.json',JSON.stringify(report,null,2));
 await browser?.close();for(const host of [server,store]){host.closeAllConnections();await new Promise(resolve=>host.close(resolve));}await closeDb();
}
