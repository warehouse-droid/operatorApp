import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {chromium,expect} from '@playwright/test';
import {fixture,startedAction} from './fixture.js';
import {query,closeDb} from '../../src/db.js';
after(closeDb);
const cmd=revision=>({commandId:randomUUID(),revision});
async function ready(f,company='MBT',type='truck'){
 await query('UPDATE repair_vehicles SET company=$2,data=data||$3::jsonb WHERE id=$1',[f.vehicle,company,{equipmentType:type}]);
 const owner=company==='MBT'?f.actors.driver:company==='MBBS'?f.actors.operator:f.actors.repair_office;
 let job=await f.repo.create(owner,{...cmd(),vehicleId:f.vehicle,meter:'10',meterUnit:'hours',yardId:1,condition:'out_of_service',defect:'Failed pump'});
 job=await startedAction(f.repo,f.actors.repair_technician,job.id,{...cmd(job.revision),action:'inspection_complete',done:'Needs new pump'});
 const quote=await f.repo.quote(f.actors.repair_office,job.id,{...cmd(job.revision),lines:[{id:'labor',kind:'labor',description:'Replace pump',quantity:'1',unitPrice:'50'}]});
 const approver=company==='EXTERNAL'?{id:'customer',role:'repair_customer',requestId:job.id}:f.actors[company==='MBR'?'mbr_sales':company==='MBBS'?'yard_manager':'dispatcher'];
 if(company==='EXTERNAL'){const link=await f.repo.quoteLink(f.actors.repair_office,job.id,quote.id);const {hash}=await import('../../src/repair/repository.js');approver.tokenHash=hash(link.token);}
 await f.repo.decide(approver,job.id,{...cmd(),quoteId:quote.id,decisions:[{id:'labor',status:'approved'}]});
 return f.repo.get(f.actors.repair_technician,job.id);
}
test('equipment assignment APIs separate Control/Dispatch, reject stale changes and preserve assignment audit',async t=>{
 const f=await fixture();t.after(()=>f.close());
 const operator=randomUUID();await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles) VALUES($1,$1,'Assignment operator','test','test','operator',ARRAY['operator'])",[operator]);
 await query("UPDATE repair_vehicles SET company='MBBS',data=data||'{\"equipmentType\":\"forklift\"}' WHERE id=$1",[f.vehicle]);
 const job=await f.repo.create(f.actors.operator,{...cmd(),vehicleId:f.vehicle,meter:'1',meterUnit:'hours',yardId:1,condition:'out_of_service',defect:'Forklift repair'});
 const response=await fetch(f.base+'/api/repair/equipment-assignments?scope=control',{headers:{Authorization:'Bearer yard_manager'}});assert.equal(response.status,200);
 const result=await response.json(),item=result.equipment.find(e=>e.id===f.vehicle);assert.ok(item);assert.ok(result.people.some(p=>p.id===operator));assert.ok(item.requests.some(r=>r.id===job.id));
 assert.equal((await f.request('dispatcher','/equipment-assignments?scope=control')).status,403);
 assert.equal((await f.request('operator','/equipment-assignments?scope=control')).status,403);
 const body={...cmd(job.revision),scope:'control',recipientId:operator};
 const saved=await f.request('yard_manager',`/jobs/${job.id}/recipient`,body);assert.equal(saved.status,200);assert.equal(saved.data.recipient,`staff:${operator}`);
 assert.deepEqual((await f.request('yard_manager',`/jobs/${job.id}/recipient`,body)).data,saved.data);
 assert.equal((await f.request('yard_manager',`/jobs/${job.id}/recipient`,{...body,...cmd(job.revision)})).status,409);
 assert.equal((await f.request('dispatcher',`/jobs/${job.id}/recipient`,{...cmd(saved.data.revision),scope:'dispatch',recipientId:operator})).status,403);
 assert.equal(Number((await query("SELECT count(*) FROM repair_events WHERE kind='receipt_assignment' AND request_id=$1",[job.id])).rows[0].count),1);
});
test('receipt assignment includes a classified repair when its imported equipment master has no type',async t=>{
 const f=await fixture();t.after(()=>f.close());
 await query("UPDATE repair_vehicles SET company='MBBS',data=data||'{\"equipmentType\":\"unknown\"}' WHERE id=$1",[f.vehicle]);
 let job=await f.repo.create(f.actors.operator,{...cmd(),vehicleId:f.vehicle,equipmentType:'forklift',yardId:1,meter:'1',meterUnit:'hours',condition:'out_of_service',defect:'Imported machine needs repair'});
 job=await f.repo.action(f.actors.repair_office,job.id,{...cmd(job.revision),action:'equipment',vehicleId:f.vehicle,equipmentType:'forklift',yardId:1,reason:'Verified this machine is a forklift'});
 const control=await f.request('yard_manager','/equipment-assignments?scope=control');assert.equal(control.status,200);assert.ok(control.data.equipment.some(e=>e.id===f.vehicle&&e.requests.some(r=>r.id===job.id)));
 const dispatch=await f.request('dispatcher','/equipment-assignments?scope=dispatch');assert.equal(dispatch.status,200);assert.ok(!dispatch.data.equipment.some(e=>e.requests.some(r=>r.id===job.id)));
});
test('rental repair closes directly when the team completes it',async t=>{
 const f=await fixture();t.after(()=>f.close());const job=await ready(f,'MBR','forklift');
 const completed=await startedAction(f.repo,f.actors.repair_technician,job.id,{...cmd(job.revision),action:'complete',done:'Rental equipment repaired'});
 assert.equal(completed.receipt,'accepted');assert.equal((await f.repo.get(f.actors.repair_office,job.id)).request.stage,'closed');
 assert.equal(completed.data.handover.method,'repair_team');
});
test('Repair Team can close an existing completed rental awaiting the old receipt flow',async t=>{
 const f=await fixture();t.after(()=>f.close());let job=await ready(f,'MBR','loader');
 job=await startedAction(f.repo,f.actors.repair_technician,job.id,{...cmd(job.revision),action:'complete',done:'Rental repaired'});
 await query("UPDATE repair_requests SET receipt='pending',data=data-'handover' WHERE id=$1",[job.id]);
 job=await f.repo.get(f.actors.repair_technician,job.id);
 await assert.rejects(f.repo.action(f.actors.repair_office,job.id,{...cmd(job.revision),action:'complete_rental'}),/access/i);
 const closed=await f.repo.action(f.actors.repair_technician,job.id,{...cmd(job.revision),action:'complete_rental'});assert.equal(closed.receipt,'accepted');assert.equal(closed.data.handover.method,'repair_team');
 await assert.rejects(f.repo.action(f.actors.repair_technician,job.id,{...cmd(closed.revision),action:'complete_rental'}),/not ready/i);
});
test('internal forklift and truck completion still wait for their Operator or Driver receipt',async t=>{
 const f=await fixture();t.after(()=>f.close());
 for(const [company,type,role] of [['MBBS','forklift','operator'],['MBT','truck','driver']]){
  const job=await ready(f,company,type),complete=await startedAction(f.repo,f.actors.repair_technician,job.id,{...cmd(job.revision),action:'complete',done:'Company equipment repaired'});
  assert.equal(complete.receipt,'pending');assert.equal((await f.repo.get(f.actors[role],job.id)).permissions.receive,true);
  await assert.rejects(f.repo.action(f.actors.repair_technician,job.id,{...cmd(complete.revision),action:'receive',decision:'accepted'}),/access/i);
 }
});
test('external completion issues a private expiring customer link and prevents office confirmation',async t=>{
 const f=await fixture();t.after(()=>f.close());let job=await ready(f,'EXTERNAL');
 assert.equal((await fetch(f.base+`/api/repair/jobs/${job.id}/handover-link`,{method:'POST',headers:{Authorization:'Bearer repair_office','Content-Type':'application/json'},body:'{}'})).status,409);
 job=await startedAction(f.repo,f.actors.repair_technician,job.id,{...cmd(job.revision),action:'complete',done:'Truck repaired'});
 assert.equal((await f.repo.get(f.actors.repair_office,job.id)).permissions.receive,false);
 await assert.rejects(f.repo.action(f.actors.repair_office,job.id,{...cmd(job.revision),action:'delegate',recipientType:'driver',recipientId:'1',reason:'Test bypass'}),/customer confirmation link/i);
 const link=await f.request('repair_technician',`/jobs/${job.id}/handover-link`,{});assert.equal(link.status,200);assert.match(link.data.token,/^[\w-]{43}$/u);
 const publicGet=token=>fetch(f.base+'/api/repair/public/handover',{headers:{Authorization:`Bearer ${token}`}});
 const view=await publicGet(link.data.token);assert.equal(view.status,200);const details=await view.json();assert.equal(details.job.id,job.id);assert.doesNotMatch(JSON.stringify(details),/inspectionFeeMinor|tokenHash|unitMinor|customer_id/);
 const rotated=await f.request('repair_office',`/jobs/${job.id}/handover-link`,{});assert.equal(rotated.status,200);assert.equal((await publicGet(link.data.token)).status,404);
 await query("UPDATE repair_requests SET data=jsonb_set(data,'{handoverAccess,expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1",[job.id]);
 assert.equal((await publicGet(rotated.data.token)).status,410);
});

test('delegated receipt is restricted, photographed and revocable without exposing another request',async t=>{
 const f=await fixture();t.after(()=>f.close());
 const person=(await query("INSERT INTO dispatch_drivers(name,login) VALUES('Receipt driver',$1) RETURNING id",[randomUUID()])).rows[0];
 f.actors.receiving={id:String(person.id),role:'driver',roles:['driver']};
 let job=await ready(f);job=await startedAction(f.repo,f.actors.repair_technician,job.id,{...cmd(job.revision),action:'complete',done:'Ready to hand over'});
 const assigned=await f.request('dispatcher',`/jobs/${job.id}/recipient`,{...cmd(job.revision),scope:'dispatch',recipientId:String(person.id)});assert.equal(assigned.status,200);
 assert.equal((await f.repo.get(f.actors.driver,job.id)).permissions.receive,false);
 assert.equal((await f.request('receiving',`/jobs/${job.id}`)).status,403);
 assert.ok(!(await f.repo.list(f.actors.receiving,{mine:true})).some(j=>j.id===job.id));
 const view=await f.request('receiving',`/receipts/${job.id}`);assert.equal(view.status,200);assert.doesNotMatch(JSON.stringify(view.data),/unitMinor|quote|inspectionFeeMinor/);
 assert.ok((await f.request('receiving','/receipts')).data.some(r=>r.id===job.id));
 const input={...cmd(view.data.revision),action:'receive',decision:'accepted'};
 assert.equal((await f.request('receiving',`/jobs/${job.id}/actions`,input)).status,400);
 const bytes=await sharp({create:{width:3,height:3,channels:3,background:'green'}}).png().toBuffer();
 const photo=await fetch(`${f.base}/api/repair/attachments?requestId=${job.id}&kind=handover&filename=received.png&mimeType=image%2Fpng`,{method:'POST',headers:{Authorization:'Bearer receiving','Content-Type':'application/octet-stream'},body:bytes});assert.equal(photo.status,200);
 const body={...input,attachmentIds:[(await photo.json()).id]};assert.equal((await f.request('receiving',`/jobs/${job.id}/actions`,body)).status,200);assert.equal((await f.request('receiving',`/jobs/${job.id}/actions`,body)).status,200);
 assert.equal((await f.repo.get(f.actors.driver,job.id)).receipt,'accepted');assert.ok(!(await f.request('receiving','/receipts')).data.some(r=>r.id===job.id));
});

test('customer handover accepts and rejects with scoped photos, replay and origin protection',async t=>{
 const f=await fixture();t.after(()=>f.close());
 const bytes=await sharp({create:{width:3,height:3,channels:3,background:'blue'}}).png().toBuffer();
 for(const decision of ['accepted','rejected']){
  let job=await ready(f,'EXTERNAL');job=await startedAction(f.repo,f.actors.repair_technician,job.id,{...cmd(job.revision),action:'complete',done:'Public handover repair'});
  const link=(await f.request('repair_office',`/jobs/${job.id}/handover-link`,{})).data;
  const headers={Authorization:`Bearer ${link.token}`,'Content-Type':'application/json'};
  const url=f.base+'/api/repair/public/handover';
  const view=await (await fetch(url,{headers})).json();
  const publicActor=await f.repo.handoverActor(link.token);await assert.rejects(f.repo.verifyHandoverActor({...publicActor,tokenHash:'test-wrong-token-hash'},job.id),/access/i);
  const input={...cmd(view.revision),decision,receiver:'Customer test',reason:decision==='rejected'?'Still leaking':''};
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://unrelated.example'},body:JSON.stringify(input)})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify(input)})).status,400);
  const photo=await fetch(url+'/photos?filename=receipt.png&mimeType=image%2Fpng&requestId='+randomUUID(),{method:'POST',headers:{Authorization:headers.Authorization,'Content-Type':'application/octet-stream'},body:bytes});assert.equal(photo.status,200);input.attachmentIds=[(await photo.json()).id];
  assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify(input)})).status,200);
  const saved=await f.repo.get(f.actors.repair_office,job.id);assert.equal(saved.receipt,decision);assert.equal(saved.data.handover.receiver,'Customer test');
  if(decision==='accepted')assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify(input)})).status,200);
  else {assert.equal(saved.status,'re_inspect');assert.equal((await fetch(url,{headers})).status,404);assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify(input)})).status,200,'retrying the same rejected receipt only acknowledges the saved decision');}
  assert.equal((await f.request('repair_office',`/jobs/${job.id}/actions`,{...cmd(saved.revision),action:'receive',decision:'accepted',receiver:'Office',attachmentIds:input.attachmentIds})).status,403);
 }
});

test('Control receipt assignment widget searches equipment and saves an active Operator',async t=>{
 const f=await fixture(),browser=await chromium.launch({args:['--no-sandbox']});t.after(async()=>{await browser.close();await f.close();});
 const id=randomUUID();await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles) VALUES($1,$1,'Chosen receipt operator','test','test','operator',ARRAY['operator'])",[id]);
 const job=await ready(f,'MBBS','loader');
 const page=await browser.newPage({viewport:{width:820,height:1024}});await page.addInitScript(()=>localStorage.setItem('mbbs.staff.token','yard_manager'));
 await page.route('**/control',route=>route.fulfill({contentType:'text/html',body:'<main id="controlApp"><header class="topbar"><div class="actions"></div></header></main><link rel="stylesheet" href="/repair/equipment-panel.css"><script type="module" src="/repair/equipment-panel.js"></script>'}));
 await page.goto(f.base+'/control');await page.getByRole('button',{name:'Equipment receipt assignments'}).click();
 const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();await dialog.getByRole('searchbox').fill(job.requestNumber);
 const form=dialog.locator(`form[data-receipt-request="${job.id}"]`);await form.getByLabel('Receive by').selectOption(id);await form.getByRole('button',{name:'Save assignment'}).click();
 await expect(dialog.getByRole('status')).toHaveText('Receipt assignment saved.');assert.equal((await f.repo.get(f.actors.repair_office,job.id)).data.recipient,`staff:${id}`);
 await dialog.getByRole('button',{name:'Close',exact:true}).click();await expect(dialog).toHaveCount(0);
});

test('Office provides a customer link after completed jobs leave Repair Team',async t=>{
 const f=await fixture(),browser=await chromium.launch({args:['--no-sandbox']});t.after(async()=>{await browser.close();await f.close();});
 let job=await ready(f,'EXTERNAL');job=await startedAction(f.repo,f.actors.repair_technician,job.id,{...cmd(job.revision),action:'complete',done:'Ready for customer inspection'});
 const team=await browser.newPage({viewport:{width:820,height:1024}});await team.addInitScript(()=>localStorage.setItem('mbbs.staff.token','repair_office'));
 const replies=[];team.on('response',response=>{if(response.url().includes('/handover-link'))replies.push({status:response.status(),url:response.url()});});await team.goto(f.base+'/repair/#'+job.id);await expect(team.locator('#appSidebar')).toBeVisible();await team.evaluate(()=>document.addEventListener('click',event=>{window.repairLastClick=event.target.outerHTML;},true));await team.getByRole('button',{name:'Create customer confirmation link'}).click();
 const field=team.getByLabel('Customer confirmation link (valid 30 days)');try{await expect(field).toBeVisible();}catch(error){error.message+=' '+JSON.stringify({replies,page:await team.evaluate(()=>({message:document.querySelector('#repairMessage')?.textContent,click:window.repairLastClick,sidebar:document.body.className,target:document.querySelector('#customerHandoverLink')?.outerHTML}))});throw error;}const url=await field.inputValue();
 const customer=await browser.newPage({viewport:{width:390,height:844}});
 await customer.goto(url);await customer.getByLabel('Your name').fill('Customer receiver');
 const png=await sharp({create:{width:3,height:3,channels:3,background:'white'}}).png().toBuffer();await customer.getByLabel('Handover photo').setInputFiles({name:'received.png',mimeType:'image/png',buffer:png});
 assert.equal(await customer.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 await customer.getByRole('button',{name:'Confirm receipt',exact:true}).click();try{await expect(customer.getByRole('heading',{name:'Equipment received',exact:true})).toBeVisible();}catch(error){error.message+=' '+JSON.stringify(await customer.evaluate(()=>({message:document.querySelector('#repairMessage')?.textContent,invalid:[...document.querySelectorAll('form input,form select,form textarea')].filter(e=>!e.checkValidity()).map(e=>({name:e.name,error:e.validationMessage}))})));throw error;}
 assert.equal((await f.repo.get(f.actors.repair_office,job.id)).receipt,'accepted');
});

test('one request has one receipt only after every job finishes for company, rental and external equipment',async t=>{
 const f=await fixture();t.after(()=>f.close());
 for(const company of ['MBBS','MBT','MBR','EXTERNAL']){
  let first=await ready(f,company,company==='MBBS'?'forklift':'truck');
  const extra=await f.repo.quote(f.actors.repair_office,first.id,{...cmd(first.revision),mode:'additional',title:'Second problem',lines:[{id:'extra',kind:'labor',description:'Second repair',quantity:'1',unitPrice:'20'}]});
  first=await f.repo.get(f.actors.repair_technician,first.id);first=await startedAction(f.repo,f.actors.repair_technician,first.id,{...cmd(first.revision),action:'complete',done:'First job finished'});
  assert.equal(first.receipt,'none');assert.notEqual((await f.repo.get(f.actors.repair_office,first.id)).request.stage,'completed');
  await assert.rejects(f.repo.handoverView(f.actors.repair_office,first.id),/not ready/i);
  if(company==='EXTERNAL')await assert.rejects(f.repo.handoverLink(f.actors.repair_office,extra.jobId),/every job/i);
  const approver=company==='EXTERNAL'?{id:'customer',role:'repair_customer',requestId:extra.jobId}:f.actors[company==='MBR'?'mbr_sales':company==='MBBS'?'yard_manager':'dispatcher'];
  if(company==='EXTERNAL'){const link=await f.repo.quoteLink(f.actors.repair_office,extra.jobId,extra.id);const {hash}=await import('../../src/repair/repository.js');approver.tokenHash=hash(link.token);}
  await f.repo.decide(approver,extra.jobId,{...cmd(),quoteId:extra.id,decisions:[{id:'extra',status:'approved'}]});
  let second=await f.repo.get(f.actors.repair_technician,extra.jobId);second=await startedAction(f.repo,f.actors.repair_technician,second.id,{...cmd(second.revision),action:'complete',done:'Second job finished'});
  assert.equal(second.receipt,company==='MBR'?'accepted':'pending');
  if(company!=='MBR'){
   const link=company==='EXTERNAL'?await f.repo.handoverLink(f.actors.repair_technician,extra.jobId):null;
   const receiver=link?await f.repo.handoverActor(link.token):f.actors[company==='MBBS'?'operator':'driver'];
   const handover=await f.repo.handoverView(receiver,first.id),photo=await f.repo.addAttachment(receiver,{requestId:first.id,kind:'handover',filename:'received.jpg',mimeType:'image/jpeg',byteSize:1,sha256:'x',storageKey:randomUUID()});
   await f.repo.action(receiver,first.id,{...cmd(handover.revision),action:'receive',decision:'accepted',receiver:'Customer',attachmentIds:[photo.id]});
   const again=await f.repo.get(f.actors.repair_office,first.id);
   await assert.rejects(f.repo.action(receiver,first.id,{...cmd(again.revision),action:'receive',decision:'accepted',receiver:'Customer',attachmentIds:[photo.id]}),/not awaiting/i);
   assert.equal(Number((await query("SELECT count(*) FROM repair_events WHERE request_id=$1 AND kind='receive'",[first.id])).rows[0].count),1);
  }
  const parent=(await query('SELECT receipt,data FROM repair_requests WHERE id=$1',[first.id])).rows[0];assert.equal(parent.receipt,'accepted');assert.ok(parent.data.handover);
  assert.equal(Number((await query("SELECT count(*) FROM repair_jobs WHERE request_id=$1 AND data ? 'handover'",[first.id])).rows[0].count),0);
 }
});
