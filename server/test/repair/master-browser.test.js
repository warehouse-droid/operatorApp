import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {fixture} from './fixture.js';
import {createRepairDirectory} from '../../src/repair/directory.js';
import {closeDb} from '../../src/db.js';
after(closeDb);
test('Office searches live masters and adds both vehicle and machine through the visible Equipment screen',async t=>{
 const marker=randomUUID().slice(0,8),writes=[],start=Date.now(),vehicles=[],machines=[{id:start,name:'MC-'+marker,alias:'Existing '+marker,serial:'SERIAL-'+marker,subsidiary_id:'7',isinactive:'F'}];
 const adapter={vehicles:async()=>vehicles,machines:async()=>machines,read:async(_type,id)=>({id:String(id),companyName:'Mr Bin Building Supply'}),customers:async()=>[],
  create:async(type,payload)=>{writes.push({type,payload});return {id:String(start+writes.length),name:(type==='customrecord240'?'VEH-':'MC-')+'NEW-'+marker,...payload};}};
 const f=await fixture({directoryFactory:repo=>createRepairDirectory({repo,adapter,enabled:()=>true})}),browser=await chromium.launch({args:['--no-sandbox']});
 t.after(async()=>{await browser.close();await f.close();});const page=await browser.newPage({viewport:{width:820,height:1180}});page.setDefaultTimeout(7000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{localStorage.setItem('mbbs.staff.token','repair_office');localStorage.setItem('mbbs.staff.role','repair_office');});
 await page.route('**/api/auth/me',route=>route.fulfill({json:{operator:f.actors.repair_office}}));
 await page.route(/\/(app-alert-sound|app-notifications|app-event-stream|regular-stock-alert|aggregate-alert|scm-aggregate-alert|scm-special-alert|sales-special-alert|special-delivery-method-alert|delivery-request-alert|stock-request-conversation-alert)\.js/,route=>route.fulfill({contentType:'text/javascript',body:''}));
 await page.route('**/api/navigation/menu-order',route=>route.fulfill({json:{revision:1,orders:{}}}));
 await page.goto(f.base+'/repair/office');await page.getByRole('button',{name:'Equipment',exact:true}).click();
 await page.getByLabel('Search NetSuite equipment').fill('SERIAL-'+marker);await page.getByRole('button',{name:'Search equipment',exact:true}).click();
 await expect(page.locator('#equipmentResults')).toContainText('Existing '+marker);await expect(page.locator('#equipmentResults')).toContainText('Machine Master');
 for(const type of ['vehicle','machine']){
  await page.getByRole('button',{name:'Add '+type,exact:true}).click();const form=page.locator('form[data-form=equipment-master]');
  await form.getByLabel('Equipment name / internal code').fill('Added '+type+' '+marker);await form.getByLabel('Serial / VIN').fill('ADDED-'+type+'-'+marker);await form.getByLabel('Equipment type').selectOption('forklift');
  if(type==='vehicle')await form.getByLabel('Vehicle number').fill('NEW-'+marker);
  await form.getByRole('button',{name:'Save '+type+' to NetSuite',exact:true}).click();
  await expect(page.locator('#equipmentResults')).toContainText('Added '+type+' '+marker);await expect(page.locator('#content')).toContainText('Saved in NetSuite:');
 }
 assert.deepEqual(writes.map(w=>w.type),['customrecord240','customrecord_mrb_machine_master']);assert.equal(writes[0].payload.custrecord77.id,'7143');assert.equal(writes[1].payload.custrecord30.id,'7');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);assert.deepEqual(errors,[]);
});
