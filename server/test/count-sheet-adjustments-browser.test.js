/* global window, document */
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {chromium, expect} from '@playwright/test';
let browser;
const coverage = [];
before(async () => {browser = await chromium.launch({headless:true, args:['--no-sandbox']});});
after(async () => {await writeFile('test-artifacts/count-sheet-adjustments-browser-coverage.json', JSON.stringify(coverage)); await browser?.close();});
const sample = {id:3,title:'Recount sheet',status:'submitted',location_id:1,attempt:1,revision:4,counted:1,total:2,owner_name:'Counter',items:[
  {item_id:1,item_name:'SKU-1',item_description:'Description should be absent',stock_unit:'PCS',count:{quantity:63.95,system_on_hand:86.7,packed_qty:10,actual_on_hand:76.7,adjusting:0,variance:-12.75}},
  {item_id:2,item_name:'SKU-2',item_description:'Second description',stock_unit:'PCS',count:null}
],history:[],attempts:[]};
async function fixture(overrides = {}) {
  const page = await browser.newPage({viewport:{width:1280,height:800}});
  page.setDefaultTimeout(5000); await page.coverage.startJSCoverage();
  await page.setContent('<main id="root"></main>');
  await page.addStyleTag({content:await readFile('public/control-count-sheets.css','utf8')});
  await page.addScriptTag({content:await readFile('public/control-count-sheets.js','utf8')+'\n//# sourceURL=https://count.test/control-count-sheets.js'});
  await page.evaluate(async sheet => {
    window.calls = []; window.rejectSave = false;
    const root = document.getElementById('root');
    const control = window.MBBSControlCountSheets.create({root,escape:v=>String(v ?? '').replaceAll('"','&quot;'),render:()=>{root.innerHTML=control.render();},request:async(path,options)=>{
      const body = options ? JSON.parse(options.body) : null;
      if (options) {window.calls.push({path,body});}
      if (path.endsWith('/config')) {return {yards:[{id:1,name:'3445'}]};}
      if (path.endsWith('/adjust')) {
        if (window.rejectSave) {throw new Error('This sheet changed. Reload before continuing.');}
        for (const row of body.adjustments) {
          const count = sheet.items.find(i=>i.item_id===Number(row.itemId)).count;
          count.adjusting = Number(row.adjusting); count.variance = count.quantity-count.actual_on_hand+count.adjusting;
        }
        sheet.revision++;
      }
      if (/\/(reset|reopen)$/.test(path)) {
        sheet.status='available'; sheet.counted=0; sheet.attempt++; sheet.revision++; sheet.owner_name=null;
        sheet.items.forEach(i=>{i.count=null;}); sheet.attempts=[];
      }
      return structuredClone(path.includes('?') ? [sheet] : sheet);
    }});
    await control.load();
  }, {...structuredClone(sample), ...overrides});
  await page.locator('[data-sheet-action="open"]').click();
  return page;
}
async function finish(page) {coverage.push(...await page.coverage.stopJSCoverage()); await page.close();}

test('A1: each row has Adjusting immediately before Var, omits description, and updates while typing', async () => {
  const page = await fixture();
  try {
    const headers = await page.locator('[data-sheet-detail] th').allTextContents();
    assert.equal(headers[headers.indexOf('Var')-1], 'Adjusting');
    await expect(page.locator('[data-sheet-detail]')).not.toContainText('Description should be absent');
    await expect(page.locator('[data-sheet-adjusting]')).toHaveCount(2);
    await expect(page.locator('[data-sheet-adjusting="2"]')).toBeDisabled();
    const input = page.locator('[data-sheet-adjusting="1"]'), variance = page.locator('[data-sheet-variance="1"]');
    await expect(variance).toHaveText('-12.75');
    await input.fill('-2.75'); await expect(variance).toHaveText('-15.5');
    await input.fill('1.000001'); await expect(variance).toHaveText('-11.749999');
    await input.fill(''); await expect(variance).toHaveText('-12.75');
    await input.fill('-2.75');
    await page.locator('[data-sheet-action="adjust"]').click();
    await expect(input).toHaveValue('-2.75'); await expect(variance).toHaveText('-15.5');
    const calls = await page.evaluate(()=>window.calls);
    assert.deepEqual(calls, [{path:'/api/control/count-sheets/3/adjust',body:{revision:4,adjustments:[{itemId:1,adjusting:'-2.75'}]}}]);
    await page.locator('[data-sheet-action="open"]').click();
    await expect(input).toHaveValue('-2.75');
    for (const width of [1280,768,390]) {
      await page.setViewportSize({width,height:800});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth), true);
    }
  } finally {await finish(page);}
});

test('A3: failed adjustment keeps edits visible with an error; unknown actual stock stays unknown', async () => {
  const page = await fixture();
  try {
    await page.evaluate(()=>{window.rejectSave=true;});
    await page.locator('[data-sheet-adjusting="1"]').fill('2');
    await page.locator('[data-sheet-action="adjust"]').click();
    await expect(page.locator('[role="alert"]')).toContainText('This sheet changed');
    await expect(page.locator('[data-sheet-adjusting="1"]')).toHaveValue('2');
    await expect(page.locator('[data-sheet-variance="1"]')).toHaveText('-10.75');
  } finally {await finish(page);}
  const legacy = structuredClone(sample); legacy.items[0].count.actual_on_hand=null;
  const oldPage=await fixture(legacy);
  try {await expect(oldPage.locator('[data-sheet-variance="1"]')).toHaveText('—');}
  finally {await finish(oldPage);}
});

for (const status of ['in_progress','submitted','cancelled']) {test(`R1: ${status} reset/reopen confirms discarding records and returns same sheet for recount`, async () => {
  const page=await fixture({status});
  try {
    const action=status==='in_progress'?'reset':'reopen';
    let prompt;
    page.once('dialog',async dialog=>{prompt=dialog.message();await dialog.dismiss();});
    await page.locator(`[data-sheet-action="${action}"]`).click();
    assert.match(prompt,/discard/i);
    assert.deepEqual(await page.evaluate(()=>window.calls), []);
    page.once('dialog',dialog=>dialog.accept());
    await page.locator(`[data-sheet-action="${action}"]`).click();
    await expect(page.locator('[data-sheet-status]')).toHaveText('Available');
    await expect(page.locator('[data-sheet-detail] h3')).toHaveText('Recount sheet');
    await expect(page.locator('[data-sheet-variance="1"]')).toHaveText('—');
    assert.deepEqual(await page.evaluate(()=>window.calls), [{path:`/api/control/count-sheets/3/${action}`,body:{revision:4}}]);
  } finally {await finish(page);}
});
}
