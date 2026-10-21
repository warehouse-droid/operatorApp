/* global window,document */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
let browser;
const coverage=[];
before(async()=>{browser=await chromium.launch({headless:true,args:['--no-sandbox']});});
after(async()=>{await writeFile('test-artifacts/inventory-count-review-browser-coverage.json',JSON.stringify(coverage));await browser.close();});
const sheet={id:3,title:'HUNT 20261002',status:'submitted',location_id:1,attempt:1,counted:1,total:1,owner_name:'Counter',
  items:[{item_name:'BWS-HUNT70S-RDM-SM',stock_unit:'SQFT',count:{quantity:63.95,system_on_hand:767.24,packed_qty:690.54,actual_on_hand:76.7,variance:-12.75,inventory_synced_at:'2026-10-03T00:00:00Z',comparison_basis:'reconstructed_current'}}],attempts:[],history:[]};
test('P4: Count Sheet review shows five quantities and labels current reconstruction separately',async()=>{
  const page=await browser.newPage();page.setDefaultTimeout(6000);await page.coverage.startJSCoverage();
  try {
    await page.setContent('<main id="root"></main>');
    await page.addScriptTag({content:await readFile('public/control-count-sheets.js','utf8')+'\n//# sourceURL=https://count.test/control-count-sheets.js'});
    await page.evaluate(async data=>{
      const root=document.getElementById('root');
      const control=window.MBBSControlCountSheets.create({root,escape:v=>String(v??''),render:()=>{root.innerHTML=control.render();},
        request:async path=>path.endsWith('/config')?{yards:[{id:1,name:'3445'}]}:path.includes('?')?[data]:data});
      await control.load();
    },sheet);
    await page.locator('[data-sheet-action="open"]').click();
    const headings=await page.locator('[data-sheet-detail] thead th').allTextContents();
    assert.deepEqual(headings.filter(h=>['On hand','Packed','Actual on hand','Counted','Var'].includes(h)),['On hand','Packed','Actual on hand','Counted','Var']);
    const row=page.locator('[data-sheet-detail] tbody tr');
    for(const value of ['767.24','690.54','76.7','63.95','-12.75']) {await expect(row).toContainText(value);}
    await expect(row).toContainText('Current reconstruction');
  } finally {coverage.push(...await page.coverage.stopJSCoverage());await page.close();}
});
test('P4: Cycle Count review shows the five quantities while the operator draft hides variance',async()=>{
  const page=await browser.newPage();page.setDefaultTimeout(6000);await page.coverage.startJSCoverage();
  try {
    await page.setContent('<main id="root"></main>');
    for(const [file,name,end,setup] of [
      ['public/control.js','renderCycleCountSection','renderFulfillmentSection',`const cycleRecords=[{id:1,lines:[{item_name:'SM',system_on_hand_qty:767.24,system_packed_qty:690.54,actual_on_hand_qty:76.7,counted_total_qty:63.95,variance_qty:-12.75}]}];const valueText=v=>v??'';const formatDate=()=>'';`],
      ['public/operator.js','renderCycleSummary','deliveryPoolTitle',`const cycleDraft={lines:[{id:1,item_id:2278,item_name:'SM',counted_total_qty:63.95,variance_qty:-12.75}]};const selectedInventoryItem=null;const displayQty=v=>v??0;const displayUnit=v=>v;const displaySignedQty=v=>v;`]
    ]) {
      const source=await readFile(file,'utf8'),start=source.indexOf(`function ${name}(`),finish=source.indexOf(`function ${end}(`,start);
      const body=source.slice(start,finish),padding='\n'.repeat(source.slice(0,start).split('\n').length-1);
      await page.addScriptTag({content:`(()=>{const t=(_key,fallback)=>fallback;const escapeHtml=v=>String(v??'');${setup}${padding}${body}\ndocument.getElementById('root').innerHTML=${name}();})();\n//# sourceURL=https://count.test/${file.split('/').at(-1)}`});
      if(name==='renderCycleCountSection') {
        await page.locator('details').evaluate(node=>{node.open=true;});
        const headings=await page.locator('th').allTextContents();
        assert.deepEqual(headings.filter(h=>['On hand','Packed','Actual on hand','Counted','Var'].includes(h)),['On hand','Packed','Actual on hand','Counted','Var']);
        for(const value of ['767.24','690.54','76.7','63.95','-12.75']) {await expect(page.locator('tbody')).toContainText(value);}
      } else {
        await expect(page.locator('#root')).toContainText('63.95');
        await expect(page.locator('#root')).not.toContainText('-12.75');await expect(page.locator('#root')).not.toContainText('Var');
      }
    }
  } finally {coverage.push(...await page.coverage.stopJSCoverage());await page.close();}
});
