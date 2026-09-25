import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {httpFixture} from '../test/field-sales/http-fixture.js';
import {seedRecent} from '../test/field-sales/recent-fixture.js';
import {closeDb} from '../src/db.js';
const folder=process.env.FIELD_SALES_ARTIFACT_DIR||'/tmp/field-sales-recent';mkdirSync(folder,{recursive:true});
const f=await httpFixture(),data=await seedRecent(),browser=await chromium.launch({args:['--no-sandbox']}),results=[],errors=[];
const context=await browser.newContext({viewport:{width:1600,height:1080},serviceWorkers:'block'}),page=await context.newPage();
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/field-sales/map-session',r=>r.fulfill({json:{available:true,googleMapsApiKey:'boundary-only'}}));
await page.addInitScript(()=>{
  const point=(lat,lng)=>({lat:()=>lat,lng:()=>lng});
  class Map {constructor(element){this.element=element;this.listeners={};}getBounds(){return {getSouthWest:()=>point(43.69,-79.6),getNorthEast:()=>point(43.73,-79.55)};}getZoom(){return 13;}getCenter(){return point(43.71,-79.57);}addListener(event,fn){this.listeners[event]=fn;}}
  class Marker {setMap(){}addListener(){}}
  window.google={maps:{Map,Marker,SymbolPath:{CIRCLE:'circle'},event:{clearInstanceListeners(){}}}};
});
const apply=async()=>{await page.locator('#filters button.primary').click();await expect(page.locator('#prospect-results')).toHaveAttribute('aria-busy','false');};
try {
  await page.goto(f.base+'/field-sales/');await page.locator('#login [name=username]').fill(f.actors.field_sales.username);await page.locator('#login [name=password]').fill(f.actors.field_sales.password);await page.locator('#login button').click();
  await page.locator('#filters').waitFor();await expect(page.locator('#filters [name=recencyMonths]')).toHaveValue('12');await page.locator('#filters [name=search]').fill(data.prefix);await apply();
  await expect(page.locator(`[data-site="${data.ids.house}"]`)).toBeVisible();await expect(page.locator(`[data-site="${data.ids.oldDrain}"]`)).toHaveCount(0);
  await expect(page.locator('.lead').filter({has:page.locator(`[data-site="${data.ids.house}"]`)})).toContainText('Issued');await expect(page.locator('#filter-context')).toContainText('12 months');
  await page.locator('#filters details summary').click();await page.locator('#filters [name=recencyMonths]').selectOption('all');await page.locator('#filters [name=includeMinor]').check();await apply();
  await page.locator(`[data-site="${data.ids.oldDrain}"]`).click();await expect(page.locator('.dialog-body')).toContainText('Issued 2022-04-12');await expect(page.locator('.dialog-body')).toContainText('Last imported');await expect(page.locator('.dialog-body')).not.toContainText('Seen ');await page.locator('.dialog-head [data-close]').click();
  results.push('default recent construction; older service work opt-in; explicit issue/import date labels');
  await page.locator('#reset-filters').click();await page.locator('#filters [name=search]').fill(data.prefix);await page.locator('#filters [name=milestone]').selectOption('Notice of Complete Application Issued');await expect(page.locator('#filters [name=source]')).toHaveValue('planning');
  const mapRequest=page.waitForRequest(r=>r.url().includes('/api/field-sales/map?')&&new URL(r.url()).searchParams.get('milestone')==='Notice of Complete Application Issued');await apply();const params=new URL((await mapRequest).url()).searchParams;assert.equal(params.get('recencyMonths'),'12');assert.equal(params.get('source'),'planning');assert.ok(params.get('bounds'));
  await expect(page.locator('#prospect-count')).toHaveText('1 potential jobsites');await expect(page.locator(`[data-site="${data.ids.complete}"]`)).toBeVisible();await expect(page.locator('#filter-context')).toContainText('early planning');
  await page.locator('#filters [name=permitStatus]').fill('Inspection');await expect(page.locator('#filters [name=source]')).toHaveValue('permit');await expect(page.locator('#filters [name=milestone]')).toHaveValue('');await apply();await expect(page.locator('#prospect-count')).toHaveText('1 potential jobsites');await expect(page.locator(`[data-site="${data.ids.foundation}"]`)).toBeVisible();
  results.push('milestone/status automatically choose the source and preserve recency/map criteria');
  await page.locator('#route-select').selectOption(f.route.id);await page.locator('#route-edit').waitFor();await page.locator('#select-all').click();await expect(page.locator('#selection-count')).toHaveText('1 selected');await page.locator('#add-selected').click();await expect(page.locator('#selection-count')).toHaveText('0 selected');await page.waitForFunction(()=>document.querySelector('#sync')?.textContent==='All changes saved');
  assert.deepEqual((await f.repo.getRoute(f.route.id)).data.stops.map(s=>s.jobsiteId),[f.site.id,data.ids.foundation]);
  await page.locator('#filters [name=search]').fill('no matching address');await apply();await expect(page.locator('#prospect-count')).toHaveText('0 potential jobsites');await expect(page.locator('#filter-context')).toContainText('12 months');await expect(page.locator('#filter-context')).toContainText('Inspection');await expect(page.locator('.lead-list')).toContainText('All ages');
  await page.screenshot({path:`${folder}/recent-planner.png`,fullPage:true});
  results.push('bulk route addition uses the filtered evidence; empty results explain active restrictions');assert.deepEqual(errors,[]);
}catch(error){await page.screenshot({path:`${folder}/recent-failure.png`,fullPage:true});writeFileSync(`${folder}/recent-failure.html`,await page.content());throw error;}
finally {
  const files=['public/field-sales/planner.js','public/field-sales/lead-policy.js','public/field-sales/service-worker.js','src/field-sales/repository.js','src/field-sales/lead-filters.js'];
  const source=Object.fromEntries(files.map(name=>[name,createHash('sha256').update(readFileSync(new URL('../'+name,import.meta.url))).digest('hex')]));
  writeFileSync(`${folder}/recent-browser-results.json`,JSON.stringify({passed:results.length,results,errors,source},null,2));console.log(JSON.stringify({passed:results.length,results,errors}));await context.close();await browser.close();await f.close();await closeDb();
}
