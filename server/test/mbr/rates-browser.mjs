import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium,webkit,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {app} from '../../src/server.js';
import {createOperator} from '../../src/auth-repository.js';
import {query,closeDb} from '../../src/db.js';
import {pdfText} from '../field-sales/pdf-text.js';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const out='test-artifacts/mbr-rates/browser',results=[];
await mkdir(out,{recursive:true});
const fixture=JSON.parse(await readFile(new URL('./rates-fixture.json',import.meta.url),'utf8'));
const originalRates=(await query('SELECT * FROM mbr_model_rates ORDER BY model')).rows;
const username='rates-browser-'+randomUUID(),password='rates-browser-only';
await createOperator({username,displayName:'Model Rate Sales',role:'mbr_sales',password});
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
assert.equal(login.status,200);const token=(await login.json()).token;
let browser;
async function check(name,fn) {await fn();results.push({name,status:'passed'});console.log('PASS',name);}
async function api(path,body,method='GET') {
  const response=await fetch(base+'/api/mbr'+path,{method,headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  assert.ok(response.ok,path);return response.json();
}
async function amounts(page,values) {
  for(const [index,key] of ['daily','weekly','monthly'].entries()) {
    await expect(page.locator(`#mbrEditor [name=${key}Rate]`)).toHaveValue(values[index]===null?'':Number(values[index]).toFixed(2));
    await expect(page.locator(`#mbrEditor [name=${key}Rate]`)).toBeEditable();
  }
}
try {
  for(const [engine,width] of [[chromium,1280],[chromium,375],[webkit,390]]) {
    const name=engine.name()+'-'+width;
    browser=await engine.launch({headless:true,args:engine.name()==='chromium'?['--no-sandbox']:[]});
    const context=await browser.newContext({viewport:{width,height:950},serviceWorkers:'block'});
    await context.addInitScript(value=>localStorage.setItem('mbbs.staff.token',value),token);
    const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await check(name+': every listed model fills its exact rates; unpriced and cleared models erase old rates',async()=>{
      await page.goto(base+'/mbr/contracts/new');await expect(page.locator('#mbrEditor')).toBeVisible();
      for(const [model,...rates] of fixture) {
        await page.getByLabel('Equipment model',{exact:true}).selectOption(model);await amounts(page,rates);
      }
      await page.getByLabel('Equipment model',{exact:true}).selectOption('STR1000H');
      await page.getByLabel('Serial number',{exact:true}).selectOption('VLGST1KHAT0610007');
      await page.getByLabel('Daily rate (CAD)',{exact:true}).fill('222.22');
      await page.getByLabel('Serial number',{exact:true}).selectOption('VLGST1KHPT0610033');
      await amounts(page,[222.22,1000,3000]);
      await page.getByLabel('Equipment model',{exact:true}).selectOption('AX18');await amounts(page,[null,null,null]);
      await expect(page.getByLabel('Serial number',{exact:true})).toHaveValue('');
      await page.getByLabel('Daily rate (CAD)',{exact:true}).fill('91.15');
      await page.getByLabel('Equipment model',{exact:true}).selectOption('');await amounts(page,[null,null,null]);
    });
    let id;
    await check(name+': sales override or clear copied rates, save and reopen with identical contract prices and PDF',async()=>{
      await page.getByLabel('Equipment model',{exact:true}).selectOption('ER620H');
      await page.getByLabel('Daily rate (CAD)',{exact:true}).fill('123.45');
      await page.getByLabel('Weekly rate (CAD)',{exact:true}).fill('');
      await page.getByLabel('Monthly rate (CAD)',{exact:true}).fill('0');
      await page.getByRole('button',{name:'Save contract',exact:true}).click();
      await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeVisible();
      id=new URL(page.url()).pathname.split('/').at(-1);await page.reload();await amounts(page,[123.45,null,0]);
      await page.getByLabel('Daily rate (CAD)',{exact:true}).fill('87.65');
      await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.locator('#mbrNotice')).toContainText('Contract saved');
      await page.reload();await amounts(page,[87.65,null,0]);
      const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download PDF',exact:true}).click();
      const file=await pending;await file.saveAs(`${out}/${name}-overridden.pdf`);
      const text=pdfText(await readFile(`${out}/${name}-overridden.pdf`));assert.ok(text.includes('87.65'));assert.ok(!text.includes('280.00'));
    });
    await check(name+': Setup maintains model defaults and never reprices a saved contract',async()=>{
      await page.goto(base+'/mbr/setup');const section=page.locator('#mbrModelRates');
      await expect(section).toBeVisible();
      for(const [model,...rates] of fixture) {
        const row=section.getByRole('row').filter({has:page.getByRole('cell',{name:model,exact:true})});
        await expect(row).toBeVisible();
        for(const rate of rates) {assert.ok((await row.innerText()).includes(rate.toLocaleString('en-CA',{style:'currency',currency:'CAD'})));}
      }
      const edit=section.getByRole('button',{name:'Edit rates for ER620H',exact:true});await edit.click();
      const form=page.locator('#mbrRatesEditor');
      await form.getByLabel('Daily rate (CAD)',{exact:true}).fill('-1');
      await form.getByRole('button',{name:'Save rates',exact:true}).click();
      await expect(page.locator('#mbrNotice')).toContainText('Enter a valid CAD amount');
      await expect(form.getByLabel('Daily rate (CAD)',{exact:true})).toHaveValue('-1');
      await form.getByRole('button',{name:'Cancel',exact:true}).click();await expect(form).toBeHidden();
      await edit.click();
      await expect(form.getByLabel('Daily rate (CAD)',{exact:true})).toHaveValue('280.00');
      await form.getByLabel('Daily rate (CAD)',{exact:true}).fill('281.25');
      await form.getByLabel('Weekly rate (CAD)',{exact:true}).fill('');
      await form.getByLabel('Monthly rate (CAD)',{exact:true}).fill('0');
      await form.getByRole('button',{name:'Save rates',exact:true}).click();await expect(page.locator('#mbrNotice')).toContainText('Rates saved');
      await page.reload();await section.getByRole('button',{name:'Edit rates for ER620H',exact:true}).click();
      await expect(form.getByLabel('Daily rate (CAD)',{exact:true})).toHaveValue('281.25');
      await expect(form.getByLabel('Weekly rate (CAD)',{exact:true})).toHaveValue('');
      await expect(form.getByLabel('Monthly rate (CAD)',{exact:true})).toHaveValue('0.00');
      const a11y=await new AxeBuilder({page}).include('.mbr-wrap').analyze();assert.deepEqual(a11y.violations,[]);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
      await page.screenshot({path:`${out}/${name}-setup.png`,fullPage:true});
      await page.goto(base+'/mbr/contracts/'+id);await amounts(page,[87.65,null,0]);
      await page.goto(base+'/mbr/contracts/new');await expect(page.locator('#mbrEditor')).toBeVisible();
      await page.getByLabel('Equipment model',{exact:true}).selectOption('ER620H');await amounts(page,[281.25,null,0]);
      await page.screenshot({path:`${out}/${name}-prefilled.png`,fullPage:true});
      await page.getByLabel('Equipment model',{exact:true}).selectOption('AX18');await amounts(page,[null,null,null]);
      await page.getByRole('button',{name:'Save contract',exact:true}).click();
      await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeVisible();
      const unknown=await api('/contracts/'+new URL(page.url()).pathname.split('/').at(-1));
      for(const key of ['dailyRateMinor','weeklyRateMinor','monthlyRateMinor']) {assert.equal(unknown.fields[key],null);}
      const row=(await api('/setup/rates')).items.find(item=>item.model==='ER620H');
      await api('/setup/rates',{model:'ER620H',revision:row.revision,dailyRate:'280',weeklyRate:'1250',monthlyRate:'3300'},'PATCH');
    });
    assert.deepEqual(errors,[]);await context.close();await browser.close();browser=null;
  }
} finally {
  await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));
  await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  for(const row of originalRates) {
    await query(`UPDATE mbr_model_rates SET daily_rate_minor=$2,weekly_rate_minor=$3,monthly_rate_minor=$4,
      revision=$5,updated_by=$6,updated_at=$7 WHERE model=$1`,
    [row.model,row.daily_rate_minor,row.weekly_rate_minor,row.monthly_rate_minor,row.revision,row.updated_by,row.updated_at]);
  }
  await closeDb();
}
