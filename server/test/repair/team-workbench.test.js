import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import sharp from 'sharp';
import {fixture,startedAction} from './fixture.js';
import {closeDb} from '../../src/db.js';
after(closeDb);
async function setup(t,width=1024,{mixed=false}={}){
 const f=await fixture(),browser=await chromium.launch({args:['--no-sandbox']});t.after(async()=>{await browser.close();await f.close();});
 if(mixed)f.actors.repair_technician.roles=['repair_technician','admin'];
 const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();page.setDefaultTimeout(6000);
 const errors=[],loaded=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>loaded.push(new URL(r.url()).pathname));t.after(()=>assert.deepEqual(errors,[]));
 await page.addInitScript(()=>localStorage.setItem('mbbs.staff.token','repair_technician'));
 await page.route('**/api/auth/me',r=>r.fulfill({json:{operator:f.actors.repair_technician}}));
 await page.route('**/api/navigation/menu-order',r=>r.fulfill({json:{revision:1,orders:{}}}));
 async function job({approved=false,urgent=false,defect='Team workbench '+randomUUID()}={}){
  let j=await f.repo.create(f.actors.driver,{commandId:randomUUID(),vehicleId:f.vehicle,meter:'120',meterUnit:'km',defect,condition:'can_operate',priority:urgent?'urgent':'normal'});
  if(approved){j=await startedAction(f.repo,f.actors.repair_technician,j.id,{commandId:randomUUID(),revision:j.revision,action:'inspection_complete',done:'Inspected pump'});const quote=await f.repo.quote(f.actors.repair_office,j.id,{commandId:randomUUID(),revision:j.revision,lines:[{id:'pump',kind:'part',description:'Replace pump',quantity:'2',unitPrice:'30',itemId:'10555'}]});await f.repo.decide(f.actors.dispatcher,j.id,{commandId:randomUUID(),quoteId:quote.id,decisions:[{id:'pump',status:'approved'}]});}
  return f.repo.get(f.actors.repair_technician,j.id);
 }
 return {...f,page,context,loaded,job};
}
async function photo(page){const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Take photos',exact:true}).click();await(await chooser).setFiles({name:'work.png',mimeType:'image/png',buffer:await sharp({create:{width:8,height:8,channels:3,background:'green'}}).png().toBuffer()});}

test('Operator-style Team tablet has only Jobs/Parts, a 30/70 workbench and selectable priority cards even for mixed roles',async t=>{
 const f=await setup(t,1024,{mixed:true}),normal=await f.job(),urgent=await f.job({urgent:true});await f.page.goto(f.base+'/repair/workshop');
 const nav=f.page.getByRole('navigation',{name:'Repair Team'});await expect(nav.getByRole('button')).toHaveText([/Jobs/,/Parts/]);
 const left=f.page.locator('[data-team-job-list]'),right=f.page.locator('[data-team-job-detail]');await expect(left).toBeVisible();await expect(right).toBeVisible();
 const a=await left.boundingBox(),b=await right.boundingBox();assert.ok(Math.abs(a.width/(a.width+b.width)-0.3)<0.015);assert.ok(a.x<b.x);
 const card=f.page.locator(`[data-team-job="${urgent.id}"]`);await expect(card).toContainText(urgent.number);await expect(card).toContainText('Repair test truck');await expect(card).toContainText('Urgent');
 await f.page.locator(`[data-team-job="${normal.id}"]`).click();await expect(right).toContainText(normal.number);await expect(right).toContainText(normal.data.defect);await expect(f.page.locator('#repairApp')).not.toHaveAttribute('aria-busy','true');
 if(process.env.REPAIR_TEAM_PREVIEW==='1'){await f.page.screenshot({path:'/app/test-artifacts/team-workbench-tablet.png'});console.log('REPAIR_TEAM_PREVIEW_READY');await new Promise(resolve=>setTimeout(resolve,45000));}
 const search=f.page.getByLabel('Search jobs',{exact:true});await search.pressSequentially(urgent.number);await expect(search).toBeFocused();await expect(f.page.locator(`[data-team-job="${normal.id}"]`)).toHaveCount(0);
 assert.ok(!f.loaded.some(p=>['/repair/office.js','/repair/app.js','/app-sidebar.js'].includes(p)));await expect(f.page.locator('#appSidebar')).toHaveCount(0);
 assert.equal(await f.page.evaluate(()=>window.getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()),'#006f6b');
});

for(const width of [390,820])test(`Team at ${width}px completes with notes/photo and keeps unsaved work across navigation`,async t=>{
 const f=await setup(t,width),job=await f.job({approved:true});await f.page.goto(f.base+'/repair/workshop#'+job.id);
 await f.page.getByRole('button',{name:'Start job',exact:true}).click();await expect.poll(async()=>(await f.repo.get(f.actors.repair_technician,job.id)).data.phase).toBe('repair');await expect(f.page.locator('#repairApp')).not.toHaveAttribute('aria-busy','true');
 await f.page.getByLabel('Actual hours on this update',{exact:true}).fill('2');const notes='Pump replaced and pressure checked';await f.page.getByLabel('Work notes',{exact:true}).fill(notes);
 await f.page.getByRole('navigation',{name:'Repair Team'}).getByRole('button',{name:/Parts/}).click();await f.page.getByRole('navigation',{name:'Repair Team'}).getByRole('button',{name:/Jobs/}).click();
 await expect(f.page.getByLabel('Work notes',{exact:true})).toHaveValue(notes);
 await f.page.getByRole('button',{name:'Complete job',exact:true}).click();await expect(f.page.getByRole('status')).toContainText(/photo/i);assert.notEqual((await f.repo.get(f.actors.repair_technician,job.id)).status,'completed');
 await photo(f.page);await f.page.getByRole('button',{name:'Complete job',exact:true}).click();
 await expect.poll(async()=>(await f.repo.get(f.actors.repair_technician,job.id)).receipt).toBe('pending');const saved=await f.repo.get(f.actors.repair_technician,job.id);assert.equal(saved.work.at(-1).data.done,notes);assert.equal(saved.attachments.length,1);
 await expect(f.page.locator(`[data-team-job="${job.id}"]`)).toHaveCount(0);await expect(f.page.getByRole('status')).toContainText('All jobs completed');assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 await f.page.reload();await expect(f.page.locator(`[data-team-job="${job.id}"]`)).toHaveCount(0);
});

test('Team Parts searches stock and raises a purchase requirement attached to the chosen job',async t=>{
 const f=await setup(t),job=await f.job({approved:true}),sku='TEAM-PUMP-'+randomUUID();await f.repo.savePart(f.actors.repair_office,{sku,name:'Team hydraulic pump',tracked:true});const other=await f.repo.savePart(f.actors.repair_office,{sku:'TEAM-BELT-'+randomUUID(),name:'Team drive belt',tracked:true});
 await f.page.goto(f.base+'/repair/workshop#'+job.id);await f.page.getByRole('navigation',{name:'Repair Team'}).getByRole('button',{name:/Parts/}).click();const search=f.page.getByLabel('Search parts',{exact:true});
 await search.pressSequentially(sku);await expect(search).toBeFocused();await expect(f.page.locator('[data-team-stock]')).toContainText('Team hydraulic pump');await expect(f.page.locator(`[data-stock-part="${other.id}"]`)).toBeHidden();
 await f.page.getByRole('button',{name:'Request purchase',exact:true}).first().click();const form=f.page.locator('form[data-form="part-request"]');await form.getByLabel('Job',{exact:true}).selectOption(job.id);await form.getByLabel('Quantity',{exact:true}).fill('2');await form.getByRole('button',{name:'Request parts',exact:true}).click();
 await expect.poll(async()=>(await f.repo.get(f.actors.repair_technician,job.id)).partRequests.length).toBe(1);await expect(f.page.locator('[data-team-purchases]')).toContainText(job.number);await expect(f.page.locator('[data-team-purchases]')).toContainText('Wait for PO');
 const requests=await f.request('repair_technician','/part-requests');assert.equal(requests.status,200);assert.ok(requests.data.some(r=>r.request_id===job.id&&r.description==='Team hydraulic pump'));
 assert.equal((await f.request('operator','/part-requests')).status,403);assert.equal((await f.request('repair_technician','/purchases')).status,403);
});

test('failed photo upload retains Team notes and image for retry without completing the job',async t=>{
 const f=await setup(t),job=await f.job({approved:true});await f.page.goto(f.base+'/repair/workshop#'+job.id);await f.page.getByRole('button',{name:'Start job',exact:true}).click();await f.page.getByLabel('Actual hours on this update',{exact:true}).fill('2');await f.page.getByLabel('Work notes',{exact:true}).fill('Keep these work notes');await photo(f.page);
 let fail=true;await f.page.route('**/api/repair/attachments?**',route=>{if(fail){fail=false;return route.fulfill({status:503,json:{error:'Photo upload unavailable'}});}return route.continue();});
 await f.page.getByRole('button',{name:'Complete job',exact:true}).click();await expect(f.page.getByRole('status')).toContainText('Photo upload unavailable');await expect(f.page.getByLabel('Work notes',{exact:true})).toHaveValue('Keep these work notes');assert.notEqual((await f.repo.get(f.actors.repair_technician,job.id)).status,'completed');
 await f.page.getByRole('button',{name:'Complete job',exact:true}).click();await expect.poll(async()=>(await f.repo.get(f.actors.repair_technician,job.id)).receipt).toBe('pending');assert.equal((await f.repo.get(f.actors.repair_technician,job.id)).attachments.length,1);
});
