import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium,webkit,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {app} from '../../src/server.js';
import {createOperator} from '../../src/auth-repository.js';
import {closeDb} from '../../src/db.js';
import {pdfText} from '../field-sales/pdf-text.js';
import {fields} from './fixtures.js';

const out='test-artifacts/mbr-nullable/browser',results=[];
await mkdir(out,{recursive:true});assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const username='nullable-browser-'+randomUUID(),password='test-nullable-browser';
await createOperator({username,displayName:'Optional Contract Sales',role:'mbr_sales',password});
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
assert.equal(login.status,200);const token=(await login.json()).token;
let browser;
async function check(name,fn) {await fn();results.push({name,status:'passed'});console.log('PASS',name);}
async function api(path,body,method='POST') {
  const response=await fetch(base+'/api/mbr'+path,{method,headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  assert.ok(response.ok);return response.json();
}
async function clear(page) {
  const form=page.locator('#mbrEditor');
  assert.equal(await form.locator('[required]').count(),0,'Every staff contract field must be optional');
  for(const input of await form.locator('input').all()) {await input.fill('');}
  await form.locator('[name=equipmentModel]').selectOption('');
}
async function assertBlank(page) {
  for(const input of await page.locator('#mbrEditor input').all()) {assert.equal(await input.inputValue(),'');}
  await expect(page.locator('[name=equipmentModel]')).toHaveValue('');
  await expect(page.locator('[name=serialNumber]')).toHaveValue('');
  await expect(page.locator('[name=serialNumber]')).toBeDisabled();
}
async function download(page,button,name) {
  const pending=page.waitForEvent('download',{timeout:15000});await button.click();const file=await pending;
  await file.saveAs(`${out}/${name}.pdf`);return pdfText(await readFile(`${out}/${name}.pdf`));
}
try {
  for(const [engine,width] of [[chromium,375],[webkit,390]]) {
    const name=engine.name();browser=await engine.launch({headless:true,args:name==='chromium'?['--no-sandbox']:[]});
    const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
    await context.addInitScript(value=>localStorage.setItem('mbbs.staff.token',value),token);
    const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
    let id;
    await check(name+': entirely blank form saves and reopens with no required controls or invented zero amounts',async()=>{
      await page.goto(base+'/mbr/contracts/new');await expect(page.locator('#mbrEditor')).toBeVisible();await clear(page);
      await page.getByRole('button',{name:'Save contract',exact:true}).click();
      await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeVisible();id=new URL(page.url()).pathname.split('/').at(-1);
      await page.reload();await expect(page.locator('#mbrEditor')).toBeVisible();await assertBlank(page);
      const record=await api('/contracts/'+id,undefined,'GET');assert.ok(Object.values(record.fields).every(value=>value===null));
      const text=await download(page,page.getByRole('button',{name:'Download PDF',exact:true}),name+'-empty-editor');
      assert.ok(!/\b(?:null|undefined)\b|0\.00/u.test(text));assert.ok(text.includes('Unsigned agreement'));
      const a11y=await new AxeBuilder({page}).include('.mbr-wrap').analyze();assert.deepEqual(a11y.violations,[]);
      await page.screenshot({path:`${out}/${name}-empty-editor.png`,fullPage:true});
    });
    await check(name+': blank contract card stays usable and downloads a clean PDF',async()=>{
      await page.goto(base+'/mbr/contracts');const card=page.locator('.mbr-contract-card').filter({has:page.locator(`a[href="/mbr/contracts/${id}"]`)});
      await expect(card).toBeVisible();await expect(card.getByRole('heading',{name:'Untitled contract',exact:true})).toBeVisible();
      assert.ok(!/\b(?:null|undefined)\b/u.test(await card.innerText()));
      const text=await download(page,card.getByRole('button',{name:'Download PDF',exact:true}),name+'-empty-card');
      assert.ok(!/\b(?:null|undefined)\b|0\.00/u.test(text));
      await expect(page).toHaveURL(base+'/mbr/contracts');
    });
    await check(name+': model-only selection saves; adding and clearing its SN preserves dropdown filtering',async()=>{
      await page.goto(base+'/mbr/contracts/'+id);await expect(page.locator('#mbrEditor')).toBeVisible();
      await page.getByLabel('Equipment model',{exact:true}).selectOption('STR1000H');
      await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.locator('#mbrNotice')).toContainText('Contract saved');
      assert.equal((await api('/contracts/'+id,undefined,'GET')).fields.serialNumber,null);
      await page.getByLabel('Serial number',{exact:true}).selectOption('VLGST1KHAT0610007');
      await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.locator('#mbrNotice')).toContainText('Contract saved');
      await page.reload();await expect(page.getByLabel('Serial number',{exact:true})).toHaveValue('VLGST1KHAT0610007');
      await page.getByLabel('Serial number',{exact:true}).selectOption('');
      await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.locator('#mbrNotice')).toContainText('Contract saved');
      assert.equal((await api('/contracts/'+id,undefined,'GET')).fields.serialNumber,null);
    });
    await check(name+': populated contract may clear every field and issue a link with the default deadline',async()=>{
      const populated=await api('/contracts',fields());await page.goto(base+'/mbr/contracts/'+populated.id);
      await expect(page.locator('#mbrEditor')).toBeVisible();await clear(page);
      await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.locator('#mbrNotice')).toContainText('Contract saved');
      await page.getByRole('button',{name:'Generate signing link',exact:true}).click();await expect(page.getByLabel('Customer signing link')).toBeVisible();
      const record=await api('/contracts/'+populated.id,undefined,'GET');assert.equal(record.fields.expiryDays,null);
      assert.ok(Date.parse(record.expiresAt)>Date.now()+2.9*86400000);
      await page.reload();await expect(page.locator('#mbrEditor')).toBeVisible();await assertBlank(page);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
    });
    assert.deepEqual(errors,[]);await context.close();await browser.close();browser=null;
  }
} finally {
  await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));
  await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await closeDb();
}
