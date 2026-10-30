import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import fc from 'fast-check';
import {fixture} from './fixture.js';
import {query,closeDb} from '../../src/db.js';
import {canRead} from '../../public/repair/domain.js';
after(closeDb);
const input=vehicleId=>({commandId:randomUUID(),vehicleId,meter:'20',meterUnit:'km',defect:'Own repair',condition:'can_operate'});
test('requester navigation replaces embedded personal history in both PWA shells',async()=>{
 for(const name of ['operator','driver']){
  const source=await fs.readFile(`public/${name}.js`,'utf8'),html=await fs.readFile(`public/${name}.html`,'utf8');
  assert.equal(/data-repair-requester|embedded=1/.test(source),false,'No embedded repair iframe in '+name);
  assert.match(source,/Repair requests/);assert.match(source,new RegExp('/'+name+'/repair'));
  assert.doesNotMatch(html,/requester-embed/);
 }
});
test('property: receiving delegation never gives another requester read access',()=>{
 fc.assert(fc.property(fc.uuid(),fc.uuid(),fc.constantFrom('operator','driver'),(id,other,role)=>{
  fc.pre(id!==other);const type=role==='driver'?'driver':'staff';
  assert.equal(canRead({id,role,roles:[role]},{requesterType:type,requesterId:other,data:{recipient:`${type}:${id}`}}),false);
  assert.equal(canRead({id,role,roles:[role]},{requesterType:type,requesterId:id,data:{}}),true);
 }),{numRuns:60});
});
test('requester context restricts mixed authorities and delegated list, detail and evidence',async t=>{
 const f=await fixture();t.after(()=>f.close());f.actors.operator.id=randomUUID();f.actors.other.id=randomUUID();
 await query("UPDATE repair_vehicles SET company='MBBS',data=data||$2 WHERE id=$1",[f.vehicle,{equipmentType:'forklift'}]);
 const own=await f.repo.create(f.actors.operator,{...input(f.vehicle),meterUnit:'hours',yardId:1});
 const other=await f.repo.create(f.actors.other,{...input(f.vehicle),meterUnit:'hours',yardId:1});
 await query("UPDATE repair_requests SET data=data||$2::jsonb WHERE id=$1",[other.id,{recipient:`staff:${f.actors.operator.id}`}]);
 const attachment=await f.repo.addAttachment(f.actors.other,{requestId:other.id,kind:'defect',filename:'private.jpg',mimeType:'image/jpeg',byteSize:1,sha256:'x',storageKey:randomUUID()});
 assert.ok(!(await f.repo.list(f.actors.operator,{mine:true})).some(j=>j.id===other.id));
 assert.equal((await f.request('operator',`/jobs/${other.id}`)).status,403);
 assert.equal((await f.request('operator',`/attachments/${attachment.id}`)).status,403);
 f.actors.operator.roles.push('admin');
 const request=async path=>{const r=await fetch(f.base+'/api/repair'+path,{headers:{Authorization:'Bearer operator','X-Repair-View':'requester'}});return {status:r.status,data:await r.json()};};
 assert.deepEqual((await request('/me')).data.actor.roles,['operator']);
 assert.deepEqual((await request('/jobs')).data.map(j=>j.id),[own.id]);
 assert.equal((await request(`/jobs/${other.id}`)).status,403);
 assert.equal((await request(`/attachments/${attachment.id}`)).status,403);
 assert.equal((await f.request('operator',`/jobs/${other.id}`)).status,200);
});
for(const [mode,role,width] of [['staff','operator',820],['driver','driver',390]])test(`${mode} dedicated requester page has a return button and only own ongoing requests`,async t=>{
 const f=await fixture(),browser=await chromium.launch({args:['--no-sandbox']});t.after(async()=>{await browser.close();await f.close();});
 if(role==='operator')await query("UPDATE repair_vehicles SET company='MBBS',data=data||$2 WHERE id=$1",[f.vehicle,{equipmentType:'forklift'}]);
 const own=await f.repo.create(f.actors[role],{...input(f.vehicle),meterUnit:'hours',yardId:1});
 const other=await f.repo.create({...f.actors[role],id:randomUUID()},{...input(f.vehicle),meterUnit:'hours',yardId:1});
 const page=await browser.newPage({viewport:{width,height:900}});await page.addInitScript(()=>{localStorage.setItem('mbbs.staff.token','operator');localStorage.setItem('mbbs.driver.token','driver');});
 await page.goto(f.base+`/repair/requester.html?mode=${mode}`);
 await expect(page.getByRole('link',{name:`Back to ${role==='driver'?'Driver':'Operator'}`})).toHaveAttribute('href',`/${role}`);
 await expect(page.getByRole('heading',{name:'Ongoing requests'})).toBeVisible();
 await expect(page.getByText(own.requestNumber,{exact:false}).first()).toBeVisible();await expect(page.getByText(other.requestNumber,{exact:false})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'New repair request',exact:true})).toBeVisible();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
});

for(const [role,width] of [['operator',820],['driver',390]])test(`${role} Personal History fits the screen and its Repair requests button opens the separate page`,async t=>{
 const f=await fixture(),browser=await chromium.launch({args:['--no-sandbox']});t.after(async()=>{await browser.close();await f.close();});
 const context=await browser.newContext({viewport:{width,height:1024},serviceWorkers:'block'}),page=await context.newPage();
 await page.addInitScript(role=>{if(role==='operator')localStorage.setItem('mbbs.staff.token','operator');localStorage.setItem('mbbs.operator.locationId','1');localStorage.setItem('mbbs.ui.language','en');window.EventSource=class{addEventListener(){}close(){}};},role);
 await page.route('**/api/**',route=>{
  const path=new URL(route.request().url()).pathname;if(path.startsWith('/api/repair/'))return route.continue();
  const data=path==='/api/auth/me'?{operator:f.actors.operator}:path.endsWith('/bootstrap-needed')?{needed:false}:path.endsWith('/phone-layout-policy')?{enabled:true,revision:1}:path.endsWith('/preferences')?{keyboard:{orderNumberKeypad:false}}:path.endsWith('/current-draft')?null:path.endsWith('/notifications')?{total:0,items:[],salesOrder:{},transferOrder:{}}:[];
  return route.fulfill({json:data});
 });
 await page.goto(f.base+`/${role}.html`);
 if(role==='operator'){await page.getByRole('button',{name:'Personal History',exact:false}).click();}
 else{
  await page.getByRole('heading',{name:'Driver Login',exact:true}).waitFor();await page.evaluate(()=>localStorage.setItem('mbbs.driver.token','driver'));
  await page.evaluate("driver={id:'driver',name:'Receipt driver',samsara_enabled:false};authToken=localStorage.getItem('mbbs.driver.token');driverHistory=[];renderDriverHistory();");
 }
 const history=page.locator(role==='operator'?'.history-shell':'.history-panel');await expect(history).toBeVisible();await expect(history.locator('iframe')).toHaveCount(0);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 const button=page.getByRole('button',{name:'Repair requests',exact:true});await expect(button).toBeVisible();await button.click();
 await expect(page).toHaveURL(new RegExp('/'+role+'/repair$'));await expect(page.getByRole('heading',{name:'Ongoing requests',exact:true})).toBeVisible();
});
