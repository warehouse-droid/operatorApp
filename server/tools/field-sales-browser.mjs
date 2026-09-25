import {mergeProcessCovs} from '@bcoe/v8-coverage';
import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { chromium,expect } from '@playwright/test';
import { httpFixture } from '../test/field-sales/http-fixture.js';
import { query,closeDb } from '../src/db.js';
import sharp from 'sharp';

// Flush before destroying an execution context; Chromium otherwise loses its counts.
const coverageParts=[];
async function reloadWithCoverage(page){coverageParts.push(...await page.coverage.stopJSCoverage());await page.coverage.startJSCoverage({resetOnNavigation:false});await page.reload();}
const folder=process.env.FIELD_SALES_ARTIFACT_DIR||'/tmp/field-sales-artifacts';mkdirSync(folder,{recursive:true});
const f=await httpFixture(),browser=await chromium.launch({args:['--no-sandbox']}),results=[],errors=[];
let activePage;
try {
  const context=await browser.newContext({viewport:{width:1536,height:1000},acceptDownloads:true}),page=await context.newPage();
  activePage=page;await page.coverage.startJSCoverage({resetOnNavigation:false});
  page.on('response',async r=>{if(r.status()>=400&&r.url().includes('/api/')){console.log(r.status(),r.url(),await r.text().catch(()=>''));}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(f.base+'/field-sales/');await page.locator('#login [name=username]').fill(f.actors.field_sales.username);await page.locator('#login [name=password]').fill(f.actors.field_sales.password);await page.locator('#login button').click();
  await page.locator('#filters').waitFor();
  await page.locator('#filters [name=source]').selectOption('manual');await page.locator('#filters [name=search]').fill('Field Test');await page.locator('#filters button[type=submit],#filters button.primary').click();
  await page.locator('#route-select').selectOption(f.route.id);await page.locator('#route-edit').waitFor();
  await page.locator(`[data-site="${f.site.id}"]`).click();await page.locator('#note-form textarea').fill('Speak with the foreman at the north entrance.');await page.locator('#note-form button').click();await page.getByText('Speak with the foreman at the north entrance.',{exact:true}).waitFor();await page.locator('.dialog-head [data-close]').click();
  await page.locator(`[data-add="${f.site.id}"]`).click();await page.waitForFunction(()=>document.querySelector('#sync')?.textContent==='All changes saved');await page.locator('#suggest').click();await page.locator('#apply-order').waitFor();
  assert.equal((await f.repo.getRoute(f.route.id)).data.stops.length,2);
  await page.locator('#apply-order').click();await page.locator('#estimate').click();await page.locator('#estimate-result strong').waitFor();
  await page.screenshot({path:`${folder}/desktop-planner.png`,fullPage:true});results.push('desktop filtering, notes, add stop, optimization preview/apply and road estimate');
  await page.locator(`[data-site="${f.site.id}"]`).click();await page.locator('#site-quote').click();await page.locator('#quote-details').waitFor();await page.locator('[name=customerName]').fill('Field Test Builder');
  for(const [company,search,quantity] of [['MBBS','FS-BLOCK','3'],['MBT','FS-BIN','2']]) {
    await page.locator('#item-autocomplete').fill(search);await page.locator('[data-item]').first().click();await page.waitForFunction(count=>document.querySelectorAll('.quote-line').length===count,company==='MBBS'?1:2);await page.locator('.quote-line').last().locator('[name=quantity]').fill(quantity);
  }
  assert.match(await page.locator('#quote-totals').innerText(),/293\.77/);
  await page.locator('#save-quote').click();await page.waitForFunction(()=>document.querySelector('#sync')?.textContent==='All changes saved');
  await page.locator('#refresh-quote').click();
  const pdfEvent=page.waitForEvent('download');await page.locator('#pdf-combined').click();const pdf=await pdfEvent;await pdf.saveAs(`${folder}/combined-quote.pdf`);
  await page.locator('#publish-quote').click();await page.getByText(/Link an existing NetSuite customer, then save/).waitFor();
  await page.screenshot({path:`${folder}/desktop-quote.png`,fullPage:true});results.push('mixed quote 293.77, actual PDF download, prospect publication blocked');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${folder}/phone-quote.png`,fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await page.locator('[data-page=today]').click();await page.locator('#visit-route').selectOption(f.route.id);await page.locator('[data-record]').first().waitFor();
  await page.evaluate(()=>navigator.serviceWorker.ready);await reloadWithCoverage(page);await page.locator('[data-record]').first().waitFor();
  await context.setOffline(true);
  await page.locator('[data-record]').first().click();await page.locator('#visit-form [name=outcome]').selectOption('Quote requested');await page.locator('#visit-form [name=note]').fill('Offline visit: builder needs MBBS blocks and MBT bin.');await page.locator('#visit-form [name=observedStage]').selectOption('Active construction');await page.locator('#two-weeks').click();await page.locator('#visit-form [name=revisitPriority]').selectOption('3');
  const photo=await sharp({create:{width:120,height:90,channels:3,background:'#668844'}}).png().toBuffer();await page.locator('#visit-photos').setInputFiles({name:'site.png',mimeType:'image/png',buffer:photo});await page.locator('#visit-submit').click();await page.locator('.visit-stop.completed').waitFor();
  await page.locator('#add-stop').click();await page.locator('#manual-stop').click();await page.locator('#site-form [name=name]').fill('Discovered offline');await page.locator('#site-form [name=address]').fill('100 Belfield Road');await page.locator('button[form=site-form]').click();await page.getByRole('heading',{name:'Discovered offline'}).waitFor();
  await reloadWithCoverage(page);await page.getByRole('heading',{name:'Discovered offline'}).waitFor();assert.equal(await page.locator('.visit-stop.completed').count(),1);assert.match(await page.locator('#sync').innerText(),/pending/);
  await page.screenshot({path:`${folder}/phone-offline-visiting.png`,fullPage:true});results.push('phone offline visit + photo + priority follow-up + new jobsite/stop survived reload');
  await page.locator('[data-page=quotes]').click();await page.locator('[data-open-quote]').filter({hasText:'Open'}).first().click();await page.locator('#quote-details').waitFor();await page.locator('#quote-memo').fill('Offline revised scope');await reloadWithCoverage(page);await page.locator('[data-draft]').first().click();assert.equal(await page.locator('[name=note]').inputValue(),'Offline revised scope');await page.locator('#save-quote').click();
  await context.setOffline(false);await page.waitForFunction(()=>document.querySelector('#sync')?.textContent==='All changes saved',null,{timeout:45000});
  const saved=await f.repo.getJobsite(f.site.id);assert.equal(saved.visits.filter(v=>v.note.startsWith('Offline visit:')).length,1);assert.equal(saved.visits.find(v=>v.note.startsWith('Offline visit:')).photos.length,1);
  const stops=(await f.repo.getRoute(f.route.id)).data.stops;assert.equal(stops.length,3);assert.equal(stops.filter(s=>s.status==='completed').length,1);
  const revised=await query(`SELECT snapshot FROM field_sales_quote_revisions WHERE snapshot->>'note'='Offline revised scope'`);assert.ok(revised.rowCount>=1);
  results.push('offline quote edit survived reload and ordered commands/photos reconciled exactly once');
  await page.locator('#refresh-quote').click();await context.setOffline(true);
  await page.locator('[name=note]').fill('Agreed price while disconnected');await page.locator('#save-quote').click();
  await query(`UPDATE field_sales_catalog SET unit_rate='20.99' WHERE company='MBBS' AND item_id='92000001'`);
  await context.setOffline(false);await page.waitForFunction(()=>document.querySelector('#sync')?.textContent==='All changes saved',null,{timeout:45000});
  await expect.poll(async()=>(await query("SELECT 1 FROM field_sales_quote_revisions WHERE snapshot->>'note'='Agreed price while disconnected' LIMIT 1")).rowCount).toBe(1);
  const agreed=(await query("SELECT snapshot FROM field_sales_quote_revisions WHERE snapshot->>'note'='Agreed price while disconnected' ORDER BY created_at DESC LIMIT 1")).rows[0].snapshot;assert.equal(agreed.lines[0].unitRate,'19.99');assert.equal(agreed.lines[0].catalogPrice.unitRate,'20.99');assert.equal(agreed.totalMinor,29377);
  await page.locator('#refresh-quote').click();await context.setOffline(true);await page.locator('[name=note]').fill('Review changed tax policy');await page.locator('#save-quote').click();
  await query(`UPDATE field_sales_settings SET data=jsonb_set(data,'{companies,MBT,taxBps}','1400')`);
  await context.setOffline(false);await page.getByText(/tax policy changed while this draft/).waitFor({timeout:45000});
  await page.locator('#sync').click();await page.locator('[data-fix-quote]').click();await page.getByText('Review the latest draft and current taxes.',{exact:false}).waitFor();assert.match(await page.locator('#quote-totals').innerText(),/295\.77/);await page.locator('#save-quote').click();
  await page.waitForFunction(()=>document.querySelector('#sync')?.textContent==='All changes saved',null,{timeout:45000});
  results.push('entered price and memo sync through catalog changes; tax changes still require review before sync');
  assert.deepEqual(errors,[]);writeFileSync(`${folder}/browser-results.json`,JSON.stringify({passed:results.length,results,errors},null,2));console.log(JSON.stringify({passed:results.length,results,errors}));const coverage=[...coverageParts,...await page.coverage.stopJSCoverage()];mkdirSync(`${folder}/v8`,{recursive:true});writeFileSync(`${folder}/v8/browser-original.json`,JSON.stringify({...mergeProcessCovs(coverage.filter(e=>e.url.includes('/field-sales/')).map((e,i)=>({result:[{url:'file:///app/public'+new URL(e.url).pathname,scriptId:String(i),functions:e.functions}]}))),timestamp:Date.now()}));await context.close();
}catch(error){if(activePage){await activePage.screenshot({path:`${folder}/failure.png`,fullPage:true});writeFileSync(`${folder}/failure.html`,await activePage.content());writeFileSync(`${folder}/pending-at-failure.json`,JSON.stringify(await activePage.evaluate(async()=>{const {ctx}=await import('/field-sales/app.js');return {pending:await ctx.state.workspace.pending(),drafts:await ctx.state.workspace.records('editquote:')};}),null,2));console.log('Browser notice:',await activePage.locator('#notice').innerText(),errors);}writeFileSync(`${folder}/browser-error.txt`,String(error.stack));throw error;}finally{await browser.close();await f.close();await closeDb();}
