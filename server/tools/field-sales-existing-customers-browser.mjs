import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {expect} from '@playwright/test';
import {httpFixture} from '../test/field-sales/http-fixture.js';
import {query,closeDb} from '../src/db.js';

const dir=process.env.FIELD_SALES_ARTIFACT_DIR||'test-artifacts/field-sales/existing-customers';await mkdir(dir,{recursive:true});
const f=await httpFixture({postingEnabled:true}),browser=await chromium.launch({headless:true,args:['--no-sandbox']}),results=[],errors=[],coverage=[];
let page;
try{
 const s=await f.repo.settings();for(const[company,id]of [['MBBS','1'],['MBT','3'],['MBR','7']]){Object.assign(s.data.companies[company],{subsidiaryId:id,salesOrderFormId:'156',currencyId:'1',locationId:'1',taxCodeId:'11',taxBps:1300});delete s.data.companies[company].customerFormId;delete s.data.companies[company].customerStatusId;}
 await f.repo.saveSettings(f.actors.admin.operator,{...s,data:{...s.data,salesOrderPostingEnabled:true}});
 for(const[id,name]of [['987100001','Existing MBBS Builder'],['987100002','Existing Shared Builder']]){await query(`INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES($1::bigint,$1::text,$2,$2,'CAD',true,now(),'test',repeat('a',64)) ON CONFLICT(netsuite_id) DO UPDATE SET display_name=$2,active=true,currency='CAD'`,[id,name]);}
 const cmd=(kind,payload)=>f.repo.command(f.actors.field_sales.operator,{id:randomUUID(),kind,payload});
 const customer=(await cmd('customer.save',{id:randomUUID(),name:'Local prospect '+randomUUID(),representatives:[]})).customer;await cmd('customer.link',{customerId:customer.id,jobsiteId:f.site.id});
 const quote=(await cmd('quote.save',{id:randomUUID(),schemaVersion:3,jobsiteId:f.site.id,fieldSalesCustomerId:customer.id,lines:[['MBBS','92000001'],['MBT','92000002'],['MBR','92000003']].map(([company,itemId])=>({id:randomUUID(),company,itemId,description:'Sample',quantity:'2',unitRate:'25'}))})).quote;
 page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));await page.coverage.startJSCoverage({resetOnNavigation:false});
 await page.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),f.actors.field_sales.token);
 await page.goto(f.base+'/field-sales/#quotes');await page.locator(`[data-open-quote="${quote.id}"]`).click();await page.locator('#confirm-quote').click();
 await expect(page.locator('[data-netsuite-picker]')).toHaveCount(2);await expect(page.locator('#quote-confirm-form')).toContainText('Create customers in NetSuite');
 const mbbs=page.locator('[data-netsuite-search="MBBS"]'),shared=page.locator('[data-netsuite-search="MBT_MBR"]');
 await page.locator('[name=confirmedBy]').fill('Customer contact');await mbbs.fill('Unselected text');await page.locator('#submit-confirmation').click();
 assert.equal((await f.repo.getQuote(quote.id)).confirmation,null);assert.equal(await mbbs.evaluate(el=>el.validity.valid),false);
 results.push('Confirmation requires existing NetSuite choices for MBBS and shared MBT/MBR; arbitrary text cannot submit');
 await mbbs.fill('Existing MBBS');await expect(page.locator('#confirm-ns-MBBS option')).toHaveCount(1);
 await mbbs.fill(await page.locator('#confirm-ns-MBBS option').getAttribute('value'));await page.locator('#submit-confirmation').click();assert.equal((await f.repo.getQuote(quote.id)).confirmation,null);
 await shared.fill('987100002');await expect(page.locator('#confirm-ns-MBT_MBR option')).toHaveCount(1);await shared.fill(await page.locator('#confirm-ns-MBT_MBR option').getAttribute('value'));
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);await page.screenshot({path:dir+'/existing-customer-phone.png',fullPage:true});
 results.push('Existing-customer autocomplete searches names and IDs, distinguishes account groups and fits phone layout');
 await page.locator('#submit-confirmation').click();await expect(page.locator('#copy-quote')).toBeVisible();
 const accepted=await f.repo.getQuote(quote.id),jobs=(await query('SELECT payload FROM field_sales_order_jobs WHERE quote_id=$1',[quote.id])).rows;
 assert.equal(jobs.length,3);for(const{payload:p}of jobs){assert.equal(p.linkedCustomerId,p.company==='MBBS'?'987100001':'987100002');assert.equal(p.config.customerFormId,undefined);}
 assert.equal(accepted.snapshot.totalMinor,16950);assert.deepEqual((await f.repo.getCustomer(customer.id)).netsuiteCustomers,{MBBS:'987100001',MBT_MBR:'987100002'});assert.deepEqual(accepted.snapshot.customer.netsuiteCustomers,{});
 results.push('Confirmation links selected existing accounts atomically, queues three orders and preserves the accepted quote snapshot');
 await page.locator('#copy-quote').click();await page.locator('#save-quote').click();await expect(page.locator('#sync')).toHaveText('All changes saved');await page.locator('#refresh-quote').click();await page.locator('#confirm-quote').click();
 await expect(page.locator('[data-netsuite-search="MBBS"]')).toHaveValue(/987100001/);await expect(page.locator('[data-netsuite-search="MBT_MBR"]')).toHaveValue(/987100002/);
 results.push('Later quotes reuse the customer’s saved NetSuite links without creating accounts');
 await page.locator('button[data-close]').filter({hasText:'Cancel'}).click();
 coverage.push(...await page.coverage.stopJSCoverage());await page.close();page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));await page.coverage.startJSCoverage({resetOnNavigation:false});
 await page.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),f.actors.admin.token);await page.goto(f.base+'/field-sales/#settings');
 await expect(page.locator('[name$=".customerFormId"],[name$=".customerStatusId"]')).toHaveCount(0);await expect(page.locator('#settings-form')).toContainText('Customers are created in NetSuite');
 await page.locator('#integration-check').click();await expect(page.locator('#integration-result')).toContainText('existing NetSuite customers');assert.doesNotMatch(await page.locator('#integration-result').innerText(),/customerFormId|customerStatusId/);
 await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:dir+'/existing-customer-settings.png',fullPage:true});
 results.push('Settings and readiness remove customer-creation fields and explain the existing-customer workflow');
 assert.deepEqual(errors,[]);coverage.push(...await page.coverage.stopJSCoverage());await writeFile(dir+'/existing-customers-browser-v8.json',JSON.stringify(coverage));await writeFile(dir+'/existing-customers-browser.json',JSON.stringify({passed:true,results},null,2));console.log(JSON.stringify({passed:true,results}));
}catch(e){if(page){await page.screenshot({path:dir+'/existing-customer-failure.png',fullPage:true});await writeFile(dir+'/existing-customer-failure.txt',await page.locator('body').innerText());}throw e;}
finally{await browser.close();await f.close();await closeDb();}
