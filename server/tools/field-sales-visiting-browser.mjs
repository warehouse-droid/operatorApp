import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {httpFixture} from '../test/field-sales/http-fixture.js';
import {closeDb} from '../src/db.js';

const folder=process.env.FIELD_SALES_ARTIFACT_DIR||'/tmp/field-sales-visiting';mkdirSync(folder,{recursive:true});
const f=await httpFixture(),browser=await chromium.launch({args:['--no-sandbox']}),results=[],errors=[];
const context=await browser.newContext({viewport:{width:1536,height:1000}}),page=await context.newPage();
page.on('pageerror',e=>errors.push(e.message));
const command=(kind,payload)=>f.repo.command(f.actors.field_sales.operator,{id:randomUUID(),kind,payload});
const payload=r=>({...r.data,id:r.id,revision:r.revision,name:r.name,date:r.date,status:r.status,ownerId:r.owner_id});
const second=(await command('jobsite.save',{id:randomUUID(),name:'Second visiting site',address:'100 Belfield Road',latitude:43.71,longitude:-79.57})).jobsite;
const firstStop=f.route.data.stops[0].id,secondStop=randomUUID();
let route=(await command('route.save',{...payload(f.route),date:'2030-01-01',stops:[...f.route.data.stops,{id:secondStop,jobsiteId:second.id}]})).route;
const card=id=>page.locator(`[data-stop="${id}"]`);
const synced=()=>page.waitForFunction(()=>document.querySelector('#sync')?.textContent==='All changes saved');
const stopEdited=async()=>{await expect(page.locator('#dialog')).not.toHaveAttribute('open','');await synced();};
const visiting=async()=>{await page.locator('[data-page=today]').click();await expect(page.locator('#visit-route')).toHaveValue(route.id);await expect(card(firstStop)).toBeVisible();};
try {
  await page.goto(f.base+'/field-sales/');await page.locator('#login [name=username]').fill(f.actors.field_sales.username);await page.locator('#login [name=password]').fill(f.actors.field_sales.password);await page.locator('#login button').click();await page.locator('#filters').waitFor();
  await visiting();await page.evaluate(()=>navigator.serviceWorker.ready);
  for(const status of ['planned','active','paused','completed']) {
    route=(await command('route.save',{...payload(await f.repo.getRoute(route.id)),status})).route;
    await page.reload();await expect(page.locator('#visit-route')).toHaveValue(route.id);
    await expect(page.locator('#start-route,#pause-route,#finish-route')).toHaveCount(0);
    for(const id of [firstStop,secondStop]) {
      await expect(card(id).getByRole('button',{name:'Record Visit',exact:true})).toBeEnabled();
      await expect(card(id).getByRole('button',{name:'Edit Stop',exact:true})).toBeEnabled();
      await expect(card(id).getByRole('link',{name:'Navigate'})).toBeVisible();
      await expect(card(id).getByRole('button',{name:'Quote',exact:true})).toBeEnabled();
      assert.equal(await card(id).locator('.stop-actions > *').count(),4);
    }
    assert.equal((await f.repo.getRoute(route.id)).status,status,'Viewing a route must not change its saved status');
  }
  route=(await command('route.save',{...payload(await f.repo.getRoute(route.id)),status:'planned'})).route;
  await page.reload();await card(firstStop).getByRole('button',{name:'Record Visit',exact:true}).click();await expect(page.locator('#visit-form')).toBeVisible();
  await expect(card(secondStop)).toBeVisible();await page.locator('#dialog').getByRole('button',{name:'Cancel',exact:true}).click();
  assert.deepEqual(await f.repo.getRoute(route.id),route,'Cancel must leave the route/stop unchanged');
  results.push('four direct actions; every route status is usable; future route survives reload; cancelling visit makes no change');

  await card(secondStop).getByRole('button',{name:'Edit Stop',exact:true}).click();await page.locator('#next-stop').click();await stopEdited();
  assert.deepEqual((await f.repo.getRoute(route.id)).data.stops.map(s=>s.id),[secondStop,firstStop]);
  await card(secondStop).getByRole('button',{name:'Edit Stop',exact:true}).click();await page.locator('#skip-stop').click();await stopEdited();
  assert.equal((await f.repo.getRoute(route.id)).data.stops[0].status,'skipped');
  await card(secondStop).getByRole('button',{name:'Edit Stop',exact:true}).click();await expect(page.locator('#skip-stop')).toHaveText('Restore stop');await page.locator('#skip-stop').click();await stopEdited();
  await card(secondStop).getByRole('button',{name:'Edit Stop',exact:true}).click();
  await page.locator('#stop-edit [name=address]').fill('100 Belfield Road, West gate');await page.locator('#stop-edit [name=stayMinutes]').fill('25');await page.locator('#stop-edit [name=note]').fill('Use the west entrance');await page.locator('[form=stop-edit]').click();await stopEdited();
  const edited=(await f.repo.getRoute(route.id)).data.stops.find(s=>s.id===secondStop);assert.equal(edited.address,'100 Belfield Road, West gate');assert.equal(edited.stayMinutes,25);assert.equal(edited.note,'Use the west entrance');assert.equal(edited.latitude,null);assert.equal(edited.longitude,null);
  assert.equal((await f.repo.getJobsite(second.id)).address,'100 Belfield Road');
  const navigation=new URL(await card(secondStop).getByRole('link',{name:'Navigate'}).getAttribute('href'));assert.equal(navigation.hostname,'www.google.com');assert.equal(navigation.searchParams.get('destination'),edited.address);assert.equal(navigation.searchParams.get('travelmode'),'driving');
  await page.screenshot({path:`${folder}/visiting-desktop.png`,fullPage:true});
  results.push('Edit Stop persists address/time/note; Visit Next, Skip/Restore still work; Navigate uses the adjusted stop address');

  await card(firstStop).getByRole('button',{name:'Record Visit',exact:true}).click();await page.locator('#visit-form [name=outcome]').selectOption('Quote requested');await page.locator('#visit-form [name=note]').fill('Direct visiting action');await page.locator('#visit-submit').click();await expect(card(firstStop)).toHaveClass(/completed/);await synced();
  assert.equal((await f.repo.getRoute(route.id)).status,'planned');assert.equal((await f.repo.getJobsite(f.site.id)).visits.filter(v=>v.note==='Direct visiting action').length,1);
  await expect(card(firstStop).getByRole('button',{name:'Record Visit',exact:true})).toBeDisabled();await expect(card(firstStop).getByRole('button',{name:'Edit Stop',exact:true})).toBeDisabled();
  await card(firstStop).getByRole('button',{name:'Quote',exact:true}).click();await expect(page.locator('#quote-details')).toBeVisible();await expect(page.locator('#view .page-head')).toContainText(f.site.address);
  await page.locator('#quote-details [name=customerName]').fill('Quote from route stop');await page.locator('#item-autocomplete').fill('FS-BLOCK');await page.locator('[data-item]').first().click();await page.locator('#save-quote').click();await expect(page.locator('#pdf-combined')).toBeEnabled();await synced();
  assert.ok((await f.repo.getJobsite(f.site.id)).quotes.some(q=>q.customer_name==='Quote from route stop'));
  await visiting();await expect(card(firstStop).getByRole('link',{name:'Navigate'})).toBeVisible();await expect(page.locator('#add-stop')).toBeEnabled();
  results.push('Record Visit saves once without starting/closing route; completed stop can navigate and quote; saved quote belongs to its jobsite');

  await page.setViewportSize({width:390,height:844});await card(secondStop).getByRole('button',{name:'Quote',exact:true}).click();await page.locator('#quote-details').waitFor();await page.locator('#quote-details [name=customerName]').fill('Second stop prospect');
  await expect.poll(()=>page.evaluate(async()=>{const {ctx}=await import('/field-sales/app.js');return (await ctx.state.workspace.records('editquote:')).find(d=>d?.customerName==='Second stop prospect')?.jobsiteId;})).toBe(second.id);
  await visiting();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await context.setOffline(true);await card(secondStop).getByRole('button',{name:'Edit Stop',exact:true}).click();await page.locator('#stop-edit [name=note]').fill('Changed while offline');await page.locator('[form=stop-edit]').click();await expect(page.locator('#dialog')).not.toHaveAttribute('open','');
  await page.reload();await expect(page.locator('#visit-route')).toHaveValue(route.id);await expect(card(secondStop)).toContainText('Changed while offline');await expect(card(firstStop)).toHaveClass(/completed/);
  await card(secondStop).getByRole('button',{name:'Quote',exact:true}).click();await expect(page.locator('#quote-details')).toBeVisible();await expect(page.locator('#view .page-head')).toContainText(second.address);await visiting();
  await page.screenshot({path:`${folder}/visiting-phone.png`,fullPage:true});await context.setOffline(false);await synced();
  assert.equal((await f.repo.getRoute(route.id)).data.stops.find(s=>s.id===secondStop).note,'Changed while offline');
  await card(secondStop).getByRole('button',{name:'Edit Stop',exact:true}).click();await page.locator('#remove-stop').click();await stopEdited();
  const final=await f.repo.getRoute(route.id);assert.deepEqual(final.data.stops.map(s=>s.id),[firstStop]);assert.equal(final.status,'planned');await expect(page.locator('#add-stop')).toBeEnabled();await expect(page.locator('#finish-route')).toHaveCount(0);
  results.push('phone layout, correct second-jobsite quote, offline edit/quote/reload, reconnection and removal preserve the open route and recorded history');
  assert.deepEqual(errors,[]);
}catch(error){await page.screenshot({path:`${folder}/visiting-failure.png`,fullPage:true});writeFileSync(`${folder}/visiting-failure.html`,await page.content());throw error;}
finally {
  const files=['visiting.js','styles.css','service-worker.js'];
  const source=Object.fromEntries(files.map(name=>[name,createHash('sha256').update(readFileSync(new URL('../public/field-sales/'+name,import.meta.url))).digest('hex')]));
  writeFileSync(`${folder}/visiting-browser-results.json`,JSON.stringify({passed:results.length,results,errors,source},null,2));console.log(JSON.stringify({passed:results.length,results,errors}));
  await context.close();await browser.close();await f.close();await closeDb();
}
