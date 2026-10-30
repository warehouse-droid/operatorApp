import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {chromium,expect} from '@playwright/test';
import {fixture,startedAction} from './fixture.js';
import {query,closeDb} from '../../src/db.js';
after(closeDb);
const cmd=revision=>({commandId:randomUUID(),revision});
async function setup(t){const f=await fixture({postingAdapter:{bill:async()=>({billId:'910',billRef:'BILL-910'})}}),browser=await chromium.launch({args:['--no-sandbox']});t.after(async()=>{await browser.close();await f.close();});return {...f,browser};}
async function pageFor(f,role,width=1280){const page=await f.browser.newPage({viewport:{width,height:1024}});page.setDefaultTimeout(7000);
 await page.addInitScript(role=>{localStorage.setItem('mbbs.staff.token',role);localStorage.setItem('mbbs.driver.token',role);localStorage.setItem('mbbs.staff.role',role);localStorage.setItem('mbbs.staff.roles',JSON.stringify([role]));localStorage.setItem('mbbs.ui.language','en');},role);
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;if(path.startsWith('/api/repair/'))return route.continue();return route.fulfill({json:path==='/api/auth/me'?{operator:f.actors[role]}:{requests:[],alerts:[],count:0,total:0,revision:1,orders:{}}});});return page;}
async function ready(f){let job=await f.repo.create(f.actors.driver,{...cmd(),vehicleId:f.vehicle,meter:'1',meterUnit:'km',defect:'Office purchase browser',condition:'can_operate'});job=await startedAction(f.repo,f.actors.repair_technician,job.id,{...cmd(job.revision),action:'inspection_complete',done:'Replace pump'});const q=await f.repo.quote(f.actors.repair_office,job.id,{...cmd(job.revision),lines:[{id:'work',kind:'labor',description:'Repair pump',quantity:'1',unitPrice:'100'}]});await f.repo.decide(f.actors.dispatcher,job.id,{...cmd(),quoteId:q.id,decisions:[{id:'work',status:'approved'}]});return f.repo.get(f.actors.repair_office,job.id);}
const png=()=>sharp({create:{width:3,height:3,channels:3,background:'green'}}).png().toBuffer();

test('office PO screen follows four steps and repair team receives parts on a phone',async t=>{
 const f=await setup(t),job=await ready(f),part=await f.repo.savePart(f.actors.repair_office,{sku:randomUUID(),name:'Browser pump',tracked:true});const page=await pageFor(f,'repair_office');await page.goto(f.base+'/repair/#'+job.id);
 const parts=page.locator('[data-job-parts]');await expect(parts.getByRole('button',{name:'Request parts',exact:true})).toHaveCount(0);
 await parts.getByRole('button',{name:'Add purchase order',exact:true}).click();const form=parts.locator('form[data-form=issue-po]');await expect(form).toBeVisible();
 await parts.getByLabel('Find supplier in NetSuite').fill('Industrial');await parts.getByRole('button',{name:'Search suppliers',exact:true}).click();await expect(page.locator('#repairApp')).not.toHaveAttribute('aria-busy','true');
 await form.getByLabel('Supplier',{exact:true}).selectOption('12821');await form.getByLabel('Expected arrival',{exact:true}).fill('2026-12-01');
 const line=form.locator('.po-line').last();await line.getByLabel('Part',{exact:true}).selectOption(part.id);await line.getByLabel('What needs purchasing').fill('Replacement browser pump');await line.getByLabel('Order quantity',{exact:true}).fill('2');await line.getByLabel('Unit cost CAD',{exact:true}).fill('80');
 await form.getByRole('button',{name:'Place local PO',exact:true}).click();await expect(page.locator('[data-parts-status]')).toHaveText('Wait for Parts');
 const po=(await f.repo.get(f.actors.repair_office,job.id)).purchaseOrders[0];assert.ok(po);assert.equal(Number((await query('SELECT count(*) FROM repair_part_requests WHERE job_id=$1',[job.id])).rows[0].count),0);
 await expect(parts.getByText('PO placed',{exact:true})).toBeVisible();await expect(parts.locator('form[data-form=receive-job-purchase]')).toHaveCount(0);
 const team=await pageFor(f,'repair_technician',390);await team.goto(f.base+'/repair/workshop#'+job.id);const incoming=team.locator(`[data-incoming-line="${po.lines[0].id}"]`);await expect(incoming).toContainText(po.data.poNumber);
 await incoming.getByLabel('Quantity received now').fill('2');await incoming.getByRole('button',{name:'Receive parts',exact:true}).click();await expect.poll(async()=>(await f.repo.getPurchase(f.actors.repair_office,po.id)).stage).toBe('parts_received');
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await parts.getByRole('button',{name:'Update invoice',exact:true}).click();
 const invoice=page.locator('form[data-form=po-invoice]');await expect(invoice).toBeVisible();await invoice.getByLabel('Supplier invoice / receipt number').fill('INV-'+randomUUID());
 await invoice.getByLabel('Original invoice / receipt').setInputFiles({name:'invoice.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF')});
 await invoice.getByLabel('Purchase photos').setInputFiles({name:'purchase.png',mimeType:'image/png',buffer:await png()});await invoice.getByRole('button',{name:'Save invoice',exact:true}).click();
 const oldPosting=(await query('SELECT data FROM repair_settings')).rows[0].data.postingEnabled;t.after(()=>query("UPDATE repair_settings SET data=jsonb_set(data,'{postingEnabled}',$1::jsonb)",[JSON.stringify(oldPosting)]));await query("UPDATE repair_settings SET data=jsonb_set(data,'{postingEnabled}','true')");await expect(page.getByRole('button',{name:'Post Bill to NetSuite',exact:true})).toBeVisible();await page.getByRole('button',{name:'Post Bill to NetSuite',exact:true}).click();await expect(page.getByText('BILL-910',{exact:true})).toBeVisible();
 const saved=await f.repo.getPurchase(f.actors.repair_office,po.id);assert.equal(saved.billState,'done');assert.equal(saved.stage,'bill_posted');assert.equal(saved.lines[0].receivedMilli,2000);
 await page.locator('summary').filter({hasText:'Link an existing Vendor Bill'}).click();await expect(page.getByLabel('Vendor Bill internal ID',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Verify & link Bill',exact:true})).toBeVisible();
 assert.equal(await team.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
});

test('office has one metadata Save and expanded cancel/link immediately before work history',async t=>{
 const f=await setup(t),job=await ready(f),page=await pageFor(f,'repair_office');await page.goto(f.base+'/repair/#'+job.id);
 const details=page.locator('[data-job-details]');await expect(details.getByRole('button',{name:'Save',exact:true})).toHaveCount(1);await expect(details.locator('form')).toHaveCount(1);
 const usage=page.locator('form[data-form=use-part]');await expect(usage).toBeVisible();await expect(usage.getByLabel('Approved scope',{exact:true})).toHaveCount(0);await expect(usage.getByLabel('Movement',{exact:true})).toHaveCount(0);
 await details.getByLabel('Priority',{exact:true}).selectOption('urgent');await details.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(async()=>(await f.repo.get(f.actors.repair_office,job.id)).priority).toBe('urgent');assert.equal((await f.repo.get(f.actors.repair_office,job.id)).quote.status,'decided');
 const cancel=page.locator('[data-job-action=cancel]'),link=page.locator('[data-job-action=link]');await expect(cancel.getByLabel('Cancellation reason')).toBeVisible();await expect(link.getByLabel('NetSuite internal record ID')).toBeVisible();
 assert.equal(await cancel.evaluate(el=>el.tagName),'SECTION');assert.equal(await link.evaluate(el=>el.tagName),'SECTION');
 assert.equal(await link.evaluate(el=>el.previousElementSibling?.matches('[data-job-action=cancel]')&&el.nextElementSibling?.querySelector('h2')?.textContent==='Work history'),true);
});

test('office and Team preview original images in app without forcing a download',async t=>{
 const f=await setup(t);let job=await ready(f);job=await f.repo.action(f.actors.repair_technician,job.id,{...cmd(job.revision),action:'start_repair'});const bytes=await png();const upload=await fetch(f.base+`/api/repair/attachments?requestId=${job.id}&kind=work&filename=preview-pump.png&mimeType=image%2Fpng`,{method:'POST',headers:{Authorization:'Bearer repair_technician','Content-Type':'application/octet-stream'},body:bytes});assert.equal(upload.status,200);const attachment=await upload.json();
 for(const [role,path] of [['repair_office','/repair/#'],['repair_technician','/repair/workshop#'],['driver','/repair/requester.html?mode=driver#']]){
  const page=await pageFor(f,role,820),downloads=[];page.on('download',d=>downloads.push(d));await page.goto(f.base+path+job.id);
  if(role==='repair_technician')await page.locator('details').filter({has:page.locator('summary').filter({hasText:'Job photos'})}).locator('summary').click();
  await page.locator(`[${role==='repair_office'?'data-download':role==='driver'?'data-preview-photo':'data-team-photo'}="${attachment.id}"]`).click();const dialog=page.getByRole('dialog',{name:'Image preview',exact:true});await expect(dialog).toBeVisible();await expect.poll(()=>dialog.locator('img').evaluate(el=>el.naturalWidth)).toBe(3);
  assert.equal(downloads.length,0);assert.ok(page.url().includes(job.id));await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
 }
});

test('Team searches parts and submits photos before any quotation',async t=>{
 const f=await setup(t),job=await f.repo.create(f.actors.driver,{...cmd(),vehicleId:f.vehicle,meter:'1',meterUnit:'km',defect:'Initial inspection',condition:'can_operate'}),part=await f.repo.savePart(f.actors.repair_office,{sku:'SEAL-'+randomUUID(),name:'Inspection seal',tracked:true});
 const page=await pageFor(f,'repair_technician',390);await page.goto(f.base+'/repair/workshop#'+job.id);await page.getByRole('button',{name:'Request job parts',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Request parts',exact:true});
 await expect(dialog.getByLabel('Approved work',{exact:true})).toHaveCount(0);await dialog.getByLabel('Search parts',{exact:true}).fill('Inspection seal');await dialog.getByLabel('Part',{exact:true}).selectOption(part.id);
 await dialog.getByLabel('Parts photos').setInputFiles({name:'needed-seal.png',mimeType:'image/png',buffer:await png()});await dialog.getByRole('button',{name:'Request parts',exact:true}).click();await expect(dialog).toHaveCount(0);
 const request=(await f.repo.partRequests(f.actors.repair_office)).find(r=>r.job_id===job.id);assert.ok(request);assert.equal(request.quote_id,null);assert.equal(request.attachments.length,1);
 const photo=(await query('SELECT part_request_id,job_id FROM repair_attachments WHERE id=$1',[request.attachments[0].id])).rows[0];assert.equal(photo.part_request_id,request.id);assert.equal(photo.job_id,job.id);
});

test('parts request survives a failed photo upload and retries only unsaved photos',async t=>{
 const f=await setup(t),job=await f.repo.create(f.actors.driver,{...cmd(),vehicleId:f.vehicle,meter:'1',meterUnit:'km',defect:'Retry inspection parts',condition:'can_operate'}),page=await pageFor(f,'repair_technician',390);
 let uploads=0;await page.route('**/api/repair/attachments?**',route=>{if(++uploads===2)return route.fulfill({status:503,json:{error:'Photo upload temporarily unavailable'}});return route.continue();});
 await page.goto(f.base+'/repair/workshop#'+job.id);await page.getByRole('button',{name:'Request job parts',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Request parts',exact:true});
 await dialog.getByLabel('What needs purchasing').fill('Two photos of the missing seal');await dialog.getByLabel('Parts photos').setInputFiles([{name:'first.png',mimeType:'image/png',buffer:await png()},{name:'second.png',mimeType:'image/png',buffer:await png()}]);await dialog.getByRole('button',{name:'Request parts',exact:true}).click();
 await expect(page.locator('#repairMessage')).toContainText('Retry the remaining photos');await expect(dialog).toBeVisible();assert.equal((await f.repo.partRequests(f.actors.repair_office)).filter(r=>r.job_id===job.id).length,1);
 await dialog.getByRole('button',{name:'Retry photos',exact:true}).click();await expect(dialog).toHaveCount(0);assert.equal(uploads,3);
 const requests=(await f.repo.partRequests(f.actors.repair_office)).filter(r=>r.job_id===job.id);assert.equal(requests.length,1);assert.equal(requests[0].attachments.length,2);
});
