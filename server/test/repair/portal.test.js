import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import sharp from 'sharp';
import {fixture,startedAction} from './fixture.js';
import {query,closeDb} from '../../src/db.js';
after(closeDb);
const input=vehicleId=>({commandId:randomUUID(),vehicleId,meter:'1200',meterUnit:'km',defect:'Brake inspection needed',condition:'can_operate'});

test('active personal requests include pending receipt and reinspection before pagination, excluding accepted/cancelled and other owners',async()=>{
 const f=await fixture();try{
  const actor={...f.actors.driver,id:randomUUID()};
  const pending=await f.repo.create(actor,input(f.vehicle));
  const recheck=await f.repo.create(actor,input(f.vehicle));
  await query("UPDATE repair_requests SET status='completed',receipt='pending' WHERE id=$1",[pending.id]);
  await query("UPDATE repair_requests SET status='re_inspect',receipt='rejected' WHERE id=$1",[recheck.id]);
  await query(`INSERT INTO repair_requests(id,vehicle_id,company,requester_type,requester_id,condition,inspection_fee_minor,inspection_tax_bps,status,receipt,data)
   SELECT gen_random_uuid(),$1,'MBT','driver',$2,'can_operate',15000,1300,'completed','accepted',$3::jsonb FROM generate_series(1,205)`,[f.vehicle,actor.id,pending.data]);
  const cancelled=await f.repo.create(actor,input(f.vehicle));await query("UPDATE repair_requests SET status='cancelled' WHERE id=$1",[cancelled.id]);
  await f.repo.create({...actor,id:randomUUID()},input(f.vehicle));
  const rows=await f.repo.list(actor,{mine:true,active:true});
  assert.deepEqual(rows.map(row=>row.id).sort(),[pending.id,recheck.id].sort());
 }finally{await f.close();}
});

test('Office searches whole repair and purchase records without attachments and requester access remains denied',async()=>{
 const f=await fixture();try{
  const marker='record-'+randomUUID();
  const job=await f.repo.create(f.actors.driver,{...input(f.vehicle),defect:marker});
  const purchase=await f.repo.purchase(f.actors.repair_office,{commandId:randomUUID(),vendorId:'12821',invoiceRef:marker,purchaseDate:'2026-10-27',vendorName:'Workshop supplier',lines:[{category:'general',description:'Cleaning cloths',quantity:'1',unitPrice:'8',accountId:'2211'}]});
  const response=await fetch(f.base+'/api/repair/records?search='+marker,{headers:{Authorization:'Bearer repair_office'}});
  assert.equal(response.status,200);const rows=await response.json();
  assert.deepEqual(new Set(rows.map(row=>row.id)),new Set([job.id,purchase.id]));
  assert.deepEqual(new Set(rows.map(row=>row.kind)),new Set(['repair','purchase']));
  assert.ok(rows.every(row=>Number(row.attachmentCount)===0));
  assert.equal((await fetch(f.base+'/api/repair/records?search='+marker,{headers:{Authorization:'Bearer driver'}})).status,403);
 }finally{await f.close();}
});

async function browserFixture(t,role,width){
 const f=await fixture(),browser=await chromium.launch({args:['--no-sandbox']});
 t.after(async()=>{await browser.close();await f.close();});
 const context=await browser.newContext({viewport:{width,height:1024}}),page=await context.newPage();
 page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 t.after(()=>assert.deepEqual(errors,[]));
 await page.addInitScript(value=>{localStorage.setItem('mbbs.staff.token',value);localStorage.setItem('mbbs.staff.role',value);localStorage.setItem('mbbs.staff.roles',JSON.stringify([value]));localStorage.setItem('mbbs.driver.token','driver');},role);
 await page.route('**/api/auth/me',route=>route.fulfill({json:{operator:f.actors[role],mbrContractsEnabled:true}}));
 // Auxiliary app notifications are unrelated to these fixture API endpoints.
 await page.route(/\/(app-alert-sound|app-notifications|app-event-stream|regular-stock-alert|aggregate-alert|scm-aggregate-alert|scm-special-alert|sales-special-alert|special-delivery-method-alert|delivery-request-alert|stock-request-conversation-alert)\.js/,route=>route.fulfill({contentType:'text/javascript',body:''}));
 await page.route('**/api/navigation/menu-order',route=>route.fulfill({json:{revision:1,orders:{}}}));
 return {...f,page,context};
}

for(const [mode,role,width] of [['staff','operator',820],['driver','driver',390]])test(`${mode} requester has a focused touch view, creates a request and removes it only after photographed receipt`,async t=>{
 const f=await browserFixture(t,role,width);f.actors[role].id=randomUUID();
 if(role==='operator')f.actors.operator.roles=['operator','admin'];
 if(role==='operator')await query("UPDATE repair_vehicles SET company='MBBS',customer_id='7000',data=$2 WHERE id=$1",[f.vehicle,{equipmentType:'forklift'}]);
 const options={...input(f.vehicle),...role==='operator'?{yardId:1,meterUnit:'hours'}:{}};
 const pending=await f.repo.create(f.actors[role],options);
 await query("UPDATE repair_requests SET status='completed',receipt='pending',data=data||jsonb_build_object('phase','awaiting_receipt','completedAt',now()::text) WHERE id=$1",[pending.id]);
 await query("UPDATE repair_jobs SET status='completed' WHERE id=$1",[pending.id]);
 const closed=await f.repo.create(f.actors[role],{...options,commandId:randomUUID()});
 await query("UPDATE repair_requests SET status='completed',receipt='accepted' WHERE id=$1",[closed.id]);
 const loaded=[];f.page.on('request',request=>loaded.push(new URL(request.url()).pathname));
 await f.page.goto(`${f.base}/repair/requester.html?mode=${mode}&embedded=1`);
 await expect(f.page.getByRole('button',{name:'New repair request',exact:true})).toBeVisible();
 await expect(f.page.getByText(pending.requestNumber,{exact:true})).toBeVisible();
 await expect(f.page.getByText(closed.requestNumber,{exact:true})).toHaveCount(0);
 await expect(f.page.locator('#appSidebar')).toHaveCount(0);
 assert.equal(await f.page.locator('body').evaluate(el=>el.scrollWidth<=window.innerWidth),true);
 await f.page.getByRole('button',{name:'New repair request',exact:true}).click();
 await f.page.getByRole('button',{name:'Find equipment',exact:true}).click();await f.page.locator(`[data-equipment-id="${f.vehicle}"]`).click();
 if(role==='operator')await f.page.getByLabel('Responsible yard',{exact:true}).selectOption('1');
 await f.page.getByLabel(role==='operator'?'Hour meter (hours)':'Odometer (km)',{exact:true}).fill('2000');
 await f.page.getByLabel('What needs repairing?',{exact:true}).fill('New requester screen test');
 await f.page.getByRole('button',{name:'Submit repair request',exact:true}).click();
 await expect(f.page.getByText('New requester screen test',{exact:true})).toBeVisible();
 await f.page.locator(`[data-request-id="${pending.id}"]`).click();
 await expect(f.page.getByRole('heading',{name:'Receive equipment',exact:true})).toBeVisible();
 const bytes=await sharp({create:{width:4,height:4,channels:3,background:'blue'}}).png().toBuffer();
 await f.page.locator('[data-requester-form=receive] input[data-native-camera]').setInputFiles({name:'receipt.png',mimeType:'image/png',buffer:bytes});
 await f.page.getByRole('button',{name:'Confirm receipt',exact:true}).click();
 await expect(f.page.getByText(pending.requestNumber,{exact:true})).toHaveCount(0);
 assert.equal((await f.repo.get(f.actors[role],pending.id)).receipt,'accepted');
 assert.ok(!loaded.some(path=>['/repair/app.js','/repair/office.js','/api/repair/settings','/api/repair/purchases','/api/repair/parts'].includes(path)),JSON.stringify(loaded));
});

test('department portal keeps the full jobs view for mixed Admin/Operator, with one merged portal and a Repair Team sidebar destination',async t=>{
 const f=await browserFixture(t,'admin',1280);f.actors.admin.roles=['admin','operator'];
 await f.page.goto(f.base+'/repair/');
 await expect(f.page.getByRole('heading',{name:'Repair department',exact:true})).toBeVisible();
 await expect(f.page.locator('#appSidebar [href="/repair/office"]')).toHaveCount(0);
 await expect(f.page.locator('#appSidebar [aria-label="Repair pages"] [href="/repair"]')).toHaveCount(1);
 await expect(f.page.locator('#appSidebar [href="/repair/workshop"]')).toBeVisible();
 await expect(f.page.getByRole('button',{name:'All requests',exact:true})).toBeVisible();
 await expect(f.page.getByText('Personal repair history',{exact:true})).toHaveCount(0);
 await f.page.getByRole('button',{name:'Purchases',exact:true}).click();
 await expect(f.page.getByRole('button',{name:'Add purchase record',exact:true})).toBeVisible();
});

test('Office record search opens the record and parts search matches name/SKU without losing typing focus',async t=>{
 const f=await browserFixture(t,'repair_office',1024),marker='Lookup '+randomUUID();
 const job=await f.repo.create(f.actors.driver,{...input(f.vehicle),defect:marker});
 await f.repo.savePart(f.actors.repair_office,{sku:'PUMP-'+randomUUID(),name:'Hydraulic pump',tracked:true});
 const other=await f.repo.savePart(f.actors.repair_office,{sku:'BELT-'+randomUUID(),name:'Drive belt',tracked:true});
 await f.page.goto(f.base+'/repair/office');
 await f.page.getByRole('button',{name:'Search records',exact:true}).click();
 await f.page.getByLabel('Search repair and purchase records',{exact:true}).fill(marker);
 await f.page.getByRole('button',{name:'Search',exact:true}).click();
 await f.page.getByRole('button',{name:new RegExp(job.requestNumber)}).click();
 await expect(f.page.getByRole('heading',{name:'Photos & attachments',exact:true})).toBeVisible();
 await f.page.getByRole('button',{name:'Parts & stock',exact:true}).click();
 const search=f.page.getByLabel('Search parts',{exact:true});await search.pressSequentially('hydraulic');
 await expect(search).toBeFocused();await expect(f.page.getByRole('cell',{name:'Hydraulic pump',exact:true})).toBeVisible();
 await expect(f.page.getByRole('cell',{name:'Drive belt',exact:true})).toBeHidden();
 await search.fill(other.sku);await expect(f.page.getByRole('cell',{name:'Drive belt',exact:true})).toBeVisible();
 await search.fill('no-matching-part');await expect(f.page.getByText('No matching parts.',{exact:true})).toBeVisible();
});

for(const width of [390,820])test(`Repair Team PWA at ${width}px starts approved work, takes photos and requests job parts`,async t=>{
 const f=await browserFixture(t,'repair_technician',width);
 let job=await f.repo.create(f.actors.driver,input(f.vehicle));
 job=await startedAction(f.repo,f.actors.repair_technician,job.id,{commandId:randomUUID(),revision:job.revision,action:'inspection_complete',done:'Pump fault diagnosed'});
 const quote=await f.repo.quote(f.actors.repair_office,job.id,{commandId:randomUUID(),revision:job.revision,lines:[{id:'pump',kind:'part',description:'Replacement pump',quantity:'1',unitPrice:'200',itemId:'10555'}]});
 await f.repo.decide(f.actors.dispatcher,job.id,{commandId:randomUUID(),quoteId:quote.id,decisions:[{id:'pump',status:'approved'}]});
 await f.page.goto(`${f.base}/repair/workshop#${job.id}`);
 await expect(f.page.getByRole('heading',{name:'Repair Team',exact:true})).toBeVisible();
 await f.page.getByRole('button',{name:'Start job',exact:true}).click();
 await expect.poll(async()=>(await f.repo.get(f.actors.repair_technician,job.id)).data.phase).toBe('repair');
 const chooser=f.page.waitForEvent('filechooser');await f.page.getByRole('button',{name:'Take photos',exact:true}).click();
 const bytes=await sharp({create:{width:4,height:4,channels:3,background:'green'}}).png().toBuffer();
 await (await chooser).setFiles({name:'work.png',mimeType:'image/png',buffer:bytes});
 await f.page.getByRole('button',{name:'Save photos',exact:true}).click();
 await expect.poll(async()=>(await f.repo.get(f.actors.repair_technician,job.id)).attachments.length).toBe(1);
 await f.page.getByRole('button',{name:'Request job parts',exact:true}).click();
 const form=f.page.locator('form[data-form="part-request"]');
 await form.getByLabel('What needs purchasing',{exact:true}).fill('Replacement pump');
 await form.getByRole('button',{name:'Request parts',exact:true}).click();
 await expect.poll(async()=>(await f.repo.get(f.actors.repair_technician,job.id)).partRequests.length).toBe(1);
 assert.equal(await f.page.locator('body').evaluate(el=>el.scrollWidth<=window.innerWidth),true);
 const manifest=await f.page.locator('link[rel="manifest"]').getAttribute('href');
 const definition=await (await fetch(f.base+manifest)).json();assert.equal(definition.start_url,'/repair/workshop');assert.equal(definition.display,'standalone');
 await f.page.evaluate(()=>navigator.serviceWorker.ready);
 await f.context.setOffline(true);await f.page.goto(f.base+'/repair/workshop');
 await expect(f.page.getByRole('heading',{name:"You're offline",exact:true})).toBeVisible();
});
