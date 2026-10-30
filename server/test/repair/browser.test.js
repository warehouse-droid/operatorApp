import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {fixture} from './fixture.js';
import {closeDb,query} from '../../src/db.js';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
after(closeDb);
test('mobile driver creates a request; workshop diagnosis; office quote; dispatch saves approval in real screens',async()=>{
 const f=await fixture(),browser=await chromium.launch({headless:true,args:['--no-sandbox']});const errors=[];
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{if(!localStorage.getItem('mbbs.driver.token'))localStorage.setItem('mbbs.driver.token','driver');if(!localStorage.getItem('mbbs.staff.token'))localStorage.setItem('mbbs.staff.token','repair_office');});
  await page.goto(`${f.base}/repair/?mode=driver&embedded=1`);await page.getByRole('button',{name:'New repair request',exact:true}).click();
  await page.getByRole('button',{name:'Find equipment',exact:true}).click();await page.locator(`[data-equipment-id="${f.vehicle}"]`).click();await page.getByLabel('Odometer (km)').fill('150000');await page.getByLabel('What needs repairing?',{exact:true}).fill('Front light does not work');await page.getByRole('button',{name:'Submit repair request',exact:true}).click();
  await page.getByText('Front light does not work',{exact:true}).waitFor();const id=await page.locator('[data-request-id]').filter({hasText:'Front light does not work'}).getAttribute('data-request-id');assert.ok(id);
  assert.equal(await page.locator('body').evaluate(el=>el.scrollWidth<=window.innerWidth),true,'mobile has no horizontal overflow');
  await page.evaluate(()=>localStorage.setItem('mbbs.staff.token','repair_technician'));await page.goto(`${f.base}/repair/workshop#${id}`);
  await page.getByRole('button',{name:'Start job',exact:true}).click();await page.getByLabel('Actual hours on this update',{exact:true}).fill('0.5');await page.getByLabel('Work notes',{exact:true}).fill('Checked connector and damaged wire');
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Take photos',exact:true}).click();await(await chooser).setFiles({name:'inspection.png',mimeType:'image/png',buffer:await sharp({create:{width:8,height:8,channels:3,background:'green'}}).png().toBuffer()});
  await page.getByRole('button',{name:'Finish inspection',exact:true}).click();await page.locator('[data-team-job-detail]').getByText('Wait for Quote',{exact:true}).waitFor();
  const inspected=await f.repo.get(f.actors.repair_technician,id);assert.equal(inspected.data.inspectionComplete,true);assert.equal(inspected.attachments.length,1);
  await page.evaluate(()=>localStorage.setItem('mbbs.staff.token','repair_office'));await page.goto(`${f.base}/repair/office#${id}`);await page.getByText('Prepare quote',{exact:true}).click();await page.getByLabel('Description',{exact:true}).fill('Replace wiring');await page.getByLabel('Unit price CAD',{exact:true}).fill('1000');await page.getByRole('button',{name:'Send quote for approval',exact:true}).click();
  await page.getByText('quote pending',{exact:false}).first().waitFor();
  // Office and department now share a URL; changing the fixture account needs a new document.
  await page.evaluate(()=>localStorage.setItem('mbbs.staff.token','dispatcher'));await page.reload();
  await page.getByRole('button',{name:'Accept quote',exact:true}).waitFor();assert.equal(await page.getByText('$1,130.00',{exact:true}).count(),1,'pending quote shows its proposed total without recording approval');
  assert.equal((await f.repo.get(f.actors.dispatcher,id)).quote.status,'pending');await page.getByRole('button',{name:'Accept quote',exact:true}).click();
  await page.getByText('decided',{exact:true}).waitFor();assert.equal(await page.getByText('$1,130.00',{exact:true}).count(),1);assert.deepEqual(errors,[]);
 }finally{await browser.close();await f.close();}
});
test('Operator selects typed equipment and the workshop corrects the same request with a reason',async()=>{
 const f=await fixture(),browser=await chromium.launch({headless:true,args:['--no-sandbox']});const first=randomUUID(),second=randomUUID(),errors=[];
 try{
  for(const [id,type,name] of [[first,'forklift','FORK-TEST'],[second,'loader','LOAD-TEST']])await query("INSERT INTO repair_vehicles(id,company,customer_id,plate,alias,data) VALUES($1,'MBBS','7000',$2,$2,$3)",[id,name,{equipmentType:type,netSuiteVehicleType:type}]);
  const page=await browser.newPage({viewport:{width:390,height:844}});page.on('pageerror',error=>errors.push(error.message));await page.addInitScript(()=>{if(!localStorage.getItem('mbbs.staff.token'))localStorage.setItem('mbbs.staff.token','operator');});
  await page.goto(`${f.base}/repair/?mode=staff&embedded=1`);await page.getByRole('button',{name:'New repair request',exact:true}).click();await page.getByRole('button',{name:'Find equipment',exact:true}).click();await page.locator(`[data-equipment-id="${first}"]`).click();
  assert.equal(await page.getByLabel('Equipment type',{exact:true}).inputValue(),'forklift');await page.getByLabel('Responsible yard',{exact:true}).selectOption('1');await page.getByLabel('Hour meter (hours)').fill('1200');await page.getByLabel('What needs repairing?',{exact:true}).fill('Hydraulic leak');await page.getByRole('button',{name:'Submit repair request',exact:true}).click();await page.getByText('Hydraulic leak',{exact:true}).waitFor();
  const id=await page.locator('[data-request-id]').filter({hasText:'Hydraulic leak'}).getAttribute('data-request-id');await page.evaluate(()=>localStorage.setItem('mbbs.staff.token','repair_technician'));await page.goto(`${f.base}/repair/workshop#${id}`);
  await page.locator('summary').filter({hasText:'Correct equipment / type'}).click();await page.getByLabel('Correct vehicle / equipment',{exact:true}).selectOption(second);assert.equal(await page.getByLabel('Confirmed equipment type',{exact:true}).inputValue(),'loader');
  await page.getByLabel('Reason for equipment correction',{exact:true}).fill('Checked plate: loader, not neighbouring forklift');await page.getByRole('button',{name:'Save equipment correction',exact:true}).click();
  await page.getByRole('heading',{name:'LOAD-TEST',exact:false}).waitFor();const job=await f.repo.get(f.actors.repair_technician,id);assert.equal(job.vehicleId,second);assert.equal(job.data.originalEquipment.vehicleId,first);assert.equal(job.data.equipmentType,'loader');assert.equal(job.status,'re_inspect');assert.deepEqual(errors,[]);
 }finally{await browser.close();await f.close();}
});
