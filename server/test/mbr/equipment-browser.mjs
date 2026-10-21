import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium,webkit,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import sharp from 'sharp';
import {app} from '../../src/server.js';
import {createOperator} from '../../src/auth-repository.js';
import {query,closeDb} from '../../src/db.js';
import {pdfText} from '../field-sales/pdf-text.js';
import {fields} from './fixtures.js';

const out='test-artifacts/mbr-equipment/browser';
const roster=JSON.parse(await readFile(new URL('./equipment-roster.json',import.meta.url),'utf8'));
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
await mkdir(out,{recursive:true});
const username='equipment-browser-'+randomUUID(),password='browser-equipment-test';
await createOperator({username,displayName:'Equipment Sales',role:'mbr_sales',password});
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
assert.equal(login.status,200);const token=(await login.json()).token;
const signatureDataUrl='data:image/png;base64,'+(await sharp(Buffer.from('<svg width="700" height="200"><rect width="700" height="200" fill="white"/><path d="M20 120 L60 50 L90 130 L140 70 L230 110" fill="none" stroke="black" stroke-width="5"/></svg>')).png().toBuffer()).toString('base64');
const results=[],coverage=[],createdUnitCodes=[];
let browser;
async function check(name,fn) {await fn();results.push({name,status:'passed'});console.log('PASS',name);}
async function api(path,body,method='POST',publicToken) {
  const response=await fetch(base+'/api/mbr'+path,{method,headers:{...(publicToken?{'x-mbr-contract-token':publicToken}:{authorization:'Bearer '+token}),
    ...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const payload=await response.json();assert.ok(response.ok,JSON.stringify(payload));return payload;
}
async function noOverflow(page) {
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'Page must fit the viewport');
  const result=await new AxeBuilder({page}).include('.mbr-wrap').analyze();assert.deepEqual(result.violations,[]);
}
async function download(page,button,name) {
  const downloaded=page.waitForEvent('download');await button.click();const file=await downloaded;
  await file.saveAs(`${out}/${name}.pdf`);return readFile(`${out}/${name}.pdf`);
}
async function fillContract(page,name) {
  const values=fields({lessee:name});
  for(const key of ['effectiveDate','lessee','rentalStart','rentalEnd','pickupLocation','returnLocation','dailyRate','weeklyRate','monthlyRate','securityDeposit']) {
    await page.locator(`[name=${key}]`).fill(values[key]);
  }
  await page.locator('[name=equipmentModel]').selectOption('STR1000H');
  await page.locator('[name=serialNumber]').selectOption(roster[0][4]);
}
try {
  for(const [engine,width] of [[chromium,375],[webkit,390],[chromium,1280]]) {
    const name=engine.name()+'-'+width,customer='Equipment '+name+' '+randomUUID().slice(0,8);
    browser=await engine.launch({headless:true,args:engine.name()==='chromium'?['--no-sandbox']:[]});
    const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
    await context.addInitScript(value=>{localStorage.setItem('mbbs.staff.token',value);localStorage.setItem('mbbs.staff.role','mbr_sales');localStorage.setItem('mbbs.staff.roles','["mbr_sales"]');},token);
    const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    if(engine.name()==='chromium') {await page.coverage.startJSCoverage({resetOnNavigation:false});}
    await check(name+': all models use codes alone; every SN dropdown matches exactly and clears on model change',async()=>{
      await page.goto(base+'/mbr/contracts/new');
      const model=page.getByLabel('Equipment model',{exact:true}),serial=page.getByLabel('Serial number',{exact:true});
      await expect(model).toBeVisible();await expect(serial).toBeDisabled();
      const expected=[...new Set(roster.map(row=>row[1]))].sort((a,b)=>a.localeCompare(b,'en',{numeric:true}));
      assert.deepEqual(await model.locator('option:not([value=""])').allTextContents(),expected);
      for(const code of expected) {
        await model.selectOption(code);await expect(serial).toBeEnabled();assert.equal(await serial.inputValue(),'');
        const entries=await serial.locator('option:not([value=""])').evaluateAll(options=>options.map(option=>({value:option.value,text:option.textContent})));
        assert.deepEqual(entries.map(entry=>entry.value).sort(),roster.filter(row=>row[1]===code).map(row=>row[4]).sort());
        for(const entry of entries) {assert.ok(entry.text.includes(roster.find(row=>row[4]===entry.value)[3]));}
        await serial.selectOption(entries[0].value);
      }
      await model.selectOption('');await expect(serial).toBeDisabled();assert.equal(await serial.inputValue(),'');
      await noOverflow(page);
    });
    let id;
    await check(name+': saved selection survives reopening; unsaved edits disable editor PDF download',async()=>{
      await fillContract(page,customer);await page.getByRole('button',{name:'Save contract',exact:true}).click();
      await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeVisible();id=new URL(page.url()).pathname.split('/').at(-1);
      await page.reload();await expect(page.locator('[name=equipmentModel]')).toHaveValue('STR1000H');
      await expect(page.locator('[name=serialNumber]')).toHaveValue(roster[0][4]);
      const button=page.getByRole('button',{name:'Download PDF',exact:true});await expect(button).toBeEnabled();
      await page.locator('[name=dailyRate]').fill('321.50');await expect(button).toBeDisabled();
      await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(button).toBeEnabled();
      const text=pdfText(await download(page,button,name+'-editor')).replace(/\s+/gu,' ');
      assert.ok(text.includes('Unsigned agreement'));assert.ok(text.includes('321.50'));assert.ok(text.includes(roster[0][4]));
      await noOverflow(page);await page.screenshot({path:`${out}/${name}-editor.png`,fullPage:true});
    });
    await check(name+': contract-card download uses the correct saved contract without navigating',async()=>{
      await page.goto(base+'/mbr/contracts');await page.getByLabel('Search contracts',{exact:true}).fill(customer);
      await page.getByRole('button',{name:'Search',exact:true}).click();
      const card=page.locator('.mbr-contract-card').filter({hasText:customer});await expect(card).toHaveCount(1);
      const bytes=await download(page,card.getByRole('button',{name:'Download PDF',exact:true}),name+'-card');
      const text=pdfText(bytes).replace(/\s+/gu,' ');assert.ok(text.includes(customer));assert.ok(text.includes('321.50'));
      assert.ok(text.includes('Unsigned agreement'));await expect(page).toHaveURL(base+'/mbr/contracts');
      await noOverflow(page);await page.screenshot({path:`${out}/${name}-cards.png`,fullPage:true});
    });
    await check(name+': completed card downloads the original signed PDF',async()=>{
      const link=await api(`/contracts/${id}/link`,{revision:2});
      const publicToken=new URL(link.url).hash.slice(1);
      await api('/public/sign',{revision:2,protectionPlanAccepted:false,consent:true,signerName:'Equipment Customer',signatureDataUrl,submissionId:randomUUID()},'POST',publicToken);
      await page.reload();await page.getByLabel('Search contracts',{exact:true}).fill(customer);await page.getByRole('button',{name:'Search',exact:true}).click();
      const card=page.locator('.mbr-contract-card').filter({hasText:customer});
      const bytes=await download(page,card.getByRole('button',{name:'Download signed PDF',exact:true}),name+'-signed-card');
      const publicPdf=await fetch(base+'/api/mbr/public/pdf',{headers:{'x-mbr-contract-token':publicToken}});
      assert.ok(bytes.equals(Buffer.from(await publicPdf.arrayBuffer())));
      assert.ok(pdfText(bytes).includes('Electronic signature record'));assert.ok(!pdfText(bytes).includes('Unsigned agreement'));
    });
    await check(name+': setup shows the supplied roster and supports adding, editing and deactivating units',async()=>{
      await page.locator('#mbrSetupLink').click();await expect(page.getByRole('heading',{name:'MBR Setup',exact:true})).toBeVisible();
      for(const row of roster) {await expect(page.locator('.mbr-equipment-table')).toContainText(row[4]);}
      await noOverflow(page);await page.screenshot({path:`${out}/${name}-setup.png`,fullPage:true});
      const form=page.locator('#mbrEquipmentEditor'),unit='BROWSER-'+randomUUID().slice(0,8),sn='SN-'+unit;
      createdUnitCodes.push(unit);
      for(const [key,value] of Object.entries({brand:'Browser',model:'Browser Model',unitCode:unit,serialNumber:sn,description:'Browser-added unit'})) {
        await form.locator(`[name=${key}]`).fill(value);
      }
      await form.getByRole('button',{name:'Add equipment',exact:true}).click();await expect(page.locator('#mbrNotice')).toContainText('Equipment saved');
      await page.getByLabel('Search equipment',{exact:true}).fill(unit);
      await expect(page.locator('.mbr-equipment-table tbody tr')).toHaveCount(1);await page.getByRole('button',{name:'Edit '+unit,exact:true}).click();
      await expect(form.locator('[name=serialNumber]')).toHaveValue(sn);await form.getByLabel('Available for new contracts',{exact:true}).uncheck();
      await form.getByRole('button',{name:'Save equipment',exact:true}).click();await expect(page.locator('.mbr-equipment-table')).toContainText('Inactive');
      await page.reload();await page.getByLabel('Search equipment',{exact:true}).fill(unit);await expect(page.locator('.mbr-equipment-table')).toContainText(sn);
      await page.getByRole('link',{name:'New contract',exact:true}).click();
      await expect(page.locator('[name=equipmentModel]')).toBeVisible();assert.ok(!(await page.locator('[name=equipmentModel] option').allTextContents()).includes('Browser Model'));
    });
    await check(name+': legacy selections stay readable and do not enter another model SN list',async()=>{
      const legacy=await api('/contracts',fields({lessee:'Legacy browser '+name}));
      await query(`UPDATE mbr_contract_revisions SET snapshot=jsonb_set(jsonb_set(snapshot,'{fields,equipmentModel}','"Legacy model"'),'{fields,serialNumber}','"LEGACY-SERIAL"') WHERE contract_id=$1 AND revision=1`,[legacy.id]);
      await page.goto(base+'/mbr/contracts/'+legacy.id);await expect(page.locator('[name=equipmentModel]')).toHaveValue('Legacy model');
      await expect(page.locator('[name=serialNumber]')).toHaveValue('LEGACY-SERIAL');
      await page.locator('[name=equipmentModel]').selectOption('TV1100H');assert.equal(await page.locator('[name=serialNumber]').inputValue(),'');
      assert.ok(!(await page.locator('[name=serialNumber] option').allTextContents()).some(value=>value.includes('LEGACY-SERIAL')));
    });
    await check(name+': setup rejects duplicate VINs without losing form data; search and cancelling edits work',async()=>{
      await page.goto(base+'/mbr/setup');await expect(page.getByRole('heading',{name:'MBR Setup',exact:true})).toBeVisible();
      const count=(await api('/setup/equipment',undefined,'GET')).items.length,form=page.locator('#mbrEquipmentEditor');
      const unit='DUPLICATE-'+randomUUID().slice(0,8);
      for(const [key,value] of Object.entries({brand:'Browser',model:'Duplicate test',unitCode:unit,serialNumber:roster[0][4]})) {
        await form.locator(`[name=${key}]`).fill(value);
      }
      await form.getByRole('button',{name:'Add equipment',exact:true}).click();await expect(page.locator('#mbrNotice')).toContainText('already exists');
      await expect(form.locator('[name=unitCode]')).toHaveValue(unit);
      assert.equal((await api('/setup/equipment',undefined,'GET')).items.length,count);
      await page.getByLabel('Search equipment',{exact:true}).fill('NO-MATCH-'+randomUUID());
      await expect(page.locator('.mbr-equipment-table')).toContainText('No matching equipment');
      await page.getByLabel('Search equipment',{exact:true}).fill(roster[0][3]);
      await page.getByRole('button',{name:'Edit '+roster[0][3],exact:true}).click();
      await form.locator('[name=model]').fill('Unsaved model');await form.getByRole('button',{name:'Cancel edit',exact:true}).click();
      await expect(form.getByRole('button',{name:'Add equipment',exact:true})).toBeVisible();
      assert.equal((await api('/setup/equipment',undefined,'GET')).items.find(item=>item.unitCode===roster[0][3]).model,roster[0][1]);
    });
    assert.deepEqual(errors,[]);
    if(engine.name()==='chromium') {coverage.push(...await page.coverage.stopJSCoverage());}
    await context.close();await browser.close();browser=null;
  }
} finally {
  await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));await writeFile(`${out}/coverage.json`,JSON.stringify(coverage));
  await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await query('DELETE FROM mbr_equipment WHERE unit_code=ANY($1::text[])',[createdUnitCodes]);await closeDb();
}
