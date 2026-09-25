/* global localStorage */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {app} from '../src/server.js';
import {closeDb} from '../src/db.js';
import {createOperator,loginOperator} from '../src/auth-repository.js';
let server,base,browser,token;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  const username=`damage-control-browser-${crypto.randomUUID()}`,password=crypto.randomUUID();
  await createOperator({username,password,displayName:'Damage Manager',role:'yard_manager',yardLocationIds:[1],operatorYardLocationIds:[]});
  token=(await loginOperator(username,password)).token;
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});await mkdir('test-artifacts/control-damage',{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server.close(resolve));await closeDb();});
async function open({loseResponse=false,uncertain=false,empty=false,reports=[],existingUnit=false}={}) {
  const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
  await context.addInitScript(value=>localStorage.setItem('mbbs.staff.token',value),token);
  const page=await context.newPage();page.setDefaultTimeout(7000);
  await page.coverage.startJSCoverage({resetOnNavigation:false});
  let transfer={id:'998187',ref:'IT00551',memo:'3445 2026 Sep Damage',source:'3445',destination:'3445 : 3445 Damage',revision:'a'.repeat(64),lines:[
    {line:1,itemId:'1256',itemName:'Original SKU',quantity:3,unitId:'191',unit:'PCS',reasonId:7,reason:'R3 - Chipping / Crack',photos:['r2://operator/test-damage.jpg'],operatorName:'Operator One'},
    {line:2,itemId:'5020',itemName:'Remove SKU',quantity:2,unitId:'191',unit:'PCS',reasonId:8,reason:'R4 - Surface',photos:[]}]};
  if(existingUnit) {transfer.lines[0].unitId='188';transfer.lines[0].unit='SQFT';}
  const submissions=[],months=[],history=[];let checks=0,failed=false;
  await page.route('**/api/photo-upload/preview**',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=','base64')}));
  await page.route('**/api/control/damage/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname;
    if(path.endsWith('/config')) return route.fulfill({json:{yards:[{id:1,name:'3445'}],month:'2026-09',reasons:[{id:5,label:'R1 - Broken'},{id:7,label:'R3 - Chipping / Crack'},{id:8,label:'R4 - Surface'}]}});
    if(path.endsWith('/review')) {months.push(url.searchParams.get('month'));return route.fulfill({json:{month:url.searchParams.get('month'),transfers:empty?[]:[transfer],reports,history,syncError:null}});}
    if(path.endsWith('/catalog')) return route.fulfill({json:[{item_id:5020,item_name:'New SKU',item_description:'New item'}]});
    if(path.includes('/items/')) return route.fulfill({json:{item_id:path.split('/').at(-1),item_name:path.endsWith('/1256')?'Original SKU':'New SKU',sales_unit_id:191,sales_unit:'PCS',units:existingUnit?[{id:'191',label:'PCS'}]:[{id:'191',label:'PCS'},{id:'188',label:'SQFT'}]}});
    if(path.endsWith('/adjustments') && route.request().method()==='POST') {
      const payload=route.request().postDataJSON();submissions.push(payload);
      if(loseResponse && !failed) {failed=true;return route.abort('failed');}
      const before=transfer.lines.map(line=>({line:line.line,item:{id:line.itemId,refName:line.itemName},adjustQtyBy:line.quantity,units:line.unitId,custcol_atlas_rc_so:{id:String(line.reasonId)}}));
      transfer={...transfer,revision:'b'.repeat(64),lines:transfer.lines.filter(line=>!payload.changes.some(change=>change.action==='remove' && change.line===line.line)).map(line=>{
        const edit=payload.changes.find(change=>change.action==='update' && change.line===line.line);return edit?{...line,...edit,itemId:String(edit.itemId),unitId:String(edit.unitId)}:line;
      })};
      for(const change of payload.changes.filter(row=>row.action==='add')) transfer.lines.push({...change,line:10,itemId:String(change.itemId),itemName:'New SKU',unitId:String(change.unitId),unit:'PCS',reason:'R1 - Broken',photos:[]});
      history.unshift({id:payload.requestId,status:'posted',actor_name:'Damage Manager',created_at:'2026-09-23T20:00:00Z',plan:{note:payload.note,before,labels:{items:{'1256':'Original SKU','5020':'New SKU'},units:{'191':'PCS'}},updated:payload.changes.filter(row=>row.action==='update').map(row=>({...row,item:{id:String(row.itemId)},adjustQtyBy:row.quantity,units:String(row.unitId)})),added:payload.changes.filter(row=>row.action==='add').map(row=>({...row,item:{id:String(row.itemId)},adjustQtyBy:row.quantity,units:String(row.unitId)})),removed:payload.changes.filter(row=>row.action==='remove').map(row=>row.line)}});
      return route.fulfill({status:202,json:{id:payload.requestId,status:'pending'}});
    }
    if(path.endsWith('/retry') && path.includes('/reports/')) {reports=[];return route.fulfill({json:{status:'posted'}});}
    if(path.endsWith('/retry') && path.includes('/adjustments/')) {uncertain=false;return route.fulfill({json:{id:submissions.at(-1).requestId,status:'posted'}});}
    if(path.includes('/adjustments/')) {checks++;return route.fulfill({json:{id:submissions.at(-1).requestId,status:checks<2?'pending':uncertain?'attention':'posted',safe_to_retry:false,last_error:uncertain?'Connection interrupted; recheck status.':null}});}
    return route.fulfill({status:404,json:{error:'Unknown test route'}});
  });
  await page.goto(base+'/control/damage-stock');
  return {page,context,submissions,months};
}
test('CB1: manager reviews photos, edits/adds/removes draft lines and waits for NetSuite confirmation',async()=>{
  const {page,context,submissions,months}=await open();
  try {
    await expect(page.locator('[data-control-damage-title]')).toHaveText('Damage stock');
    await expect(page.locator('[data-control-damage-transfer]')).toContainText('IT00551');
    const ratio=await page.locator('.control-damage-grid').evaluate(element=>{const [left,right]=[...element.children].map(child=>child.getBoundingClientRect().width);return left/(left+right);});assert.ok(Math.abs(ratio-0.4)<0.01);
    await page.locator('[data-cd-action="select"][data-key="line-1"]').click();
    await expect(page.locator('.control-damage-photos img')).toHaveCount(1);
    await page.locator('[data-cd-action="edit"]').click();
    await page.locator('[data-cd-quantity]').fill('6');await page.locator('[data-cd-reason]').selectOption('8');
    await page.locator('[data-cd-action="apply-line"]').click();
    await page.locator('[data-cd-action="select"][data-key="line-2"]').click();await page.locator('[data-cd-action="remove"]').click();
    await page.locator('[data-cd-action="add"]').click();await page.locator('[data-cd-search]').fill('New');
    await page.locator('[data-cd-action="choose-sku"]').click();await page.locator('[data-cd-quantity]').fill('4');await page.locator('[data-cd-reason]').selectOption('5');
    await page.locator('[data-cd-action="apply-line"]').click();assert.equal(submissions.length,0);
    await page.locator('[data-cd-note]').fill('Warehouse inspection correction');await page.locator('[data-cd-action="save"]').click();
    await expect(page.locator('[data-cd-posting-status]')).toContainText('Saved to NetSuite',{timeout:12000});
    assert.equal(submissions.length,1);assert.deepEqual(submissions[0].changes.map(row=>row.action).sort(),['add','remove','update']);
    assert.equal(submissions[0].changes.find(row=>row.action==='update').quantity,6);
    await expect(page.locator('[data-control-damage-history]')).toContainText('Warehouse inspection correction');
    await expect(page.locator('[data-control-damage-history]')).toContainText('1 edited, 1 added, 1 removed');
    await page.locator('[data-control-damage-history] details summary').click();
    await expect(page.locator('[data-control-damage-history] li').first()).toContainText('3 PCS → Original SKU · 6 PCS');
    await page.screenshot({path:'test-artifacts/control-damage/editor.png',fullPage:true});
    await page.locator('[data-cd-month]').fill('2026-08');await page.locator('[data-cd-month]').dispatchEvent('change');
    await expect.poll(()=>months.at(-1)).toBe('2026-08');
  } finally {await writeFile(`test-artifacts/control-damage/browser-${crypto.randomUUID()}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}
});
test('CB2: a lost save response retains the exact request ID and draft for retry',async()=>{
  const {page,context,submissions}=await open({loseResponse:true});
  try {
    await page.locator('[data-cd-action="edit"]').click();await page.locator('[data-cd-quantity]').fill('7');await page.locator('[data-cd-action="apply-line"]').click();
    await page.locator('[data-cd-note]').fill('Retry the same correction');await page.locator('[data-cd-action="save"]').click();
    await expect(page.locator('[data-cd-error]')).toBeVisible();await page.locator('[data-cd-action="save"]').click();
    await expect(page.locator('[data-cd-posting-status]')).toContainText('Saved to NetSuite',{timeout:12000});
    assert.equal(submissions.length,2);assert.deepEqual(submissions[0],submissions[1]);
  } finally {await writeFile(`test-artifacts/control-damage/browser-${crypto.randomUUID()}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}
});

test('CB3: draft edits can be undone and cancelled without a NetSuite request',async()=>{
 const {page,context,submissions}=await open();
 try {
  await page.locator('[data-cd-action="remove"]').click();await expect(page.locator('[data-cd-action="select"]').first()).toContainText('Will be removed');
  await page.locator('[data-cd-action="undo"]').click();await expect(page.locator('[data-cd-action="select"]').first()).not.toContainText('Will be removed');
  await page.locator('[data-cd-action="edit"]').click();await page.locator('[data-cd-action="cancel-line"]').click();
  await page.locator('[data-cd-action="edit"]').click();await page.locator('[data-cd-quantity]').fill('11');await page.locator('[data-cd-action="apply-line"]').click();
  await expect(page.locator('[data-cd-month]')).toBeDisabled();
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('mbbs-control-section',{detail:{section:'dashboard'}})));
  await expect(page).toHaveURL(/\/control$/);await page.goBack();
  await expect(page.locator('.control-damage-quantity')).toHaveText('11 PCS');
  await page.locator('[data-cd-action="discard"]').click();
  await expect(page.locator('.control-damage-quantity')).toHaveText('3 PCS');await page.locator('[data-cd-action="refresh"]').click();
  assert.equal(submissions.length,0);
 } finally {await writeFile(`test-artifacts/control-damage/browser-${crypto.randomUUID()}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}
});
test('CB4: an uncertain outcome blocks editing until a read-only status recheck confirms the save',async()=>{
 const {page,context,submissions}=await open({uncertain:true});
 try {
  await page.locator('[data-cd-action="edit"]').click();await page.locator('[data-cd-quantity]').fill('8');await page.locator('[data-cd-action="apply-line"]').click();
  await page.locator('[data-cd-note]').fill('Inspect interrupted update');await page.locator('[data-cd-action="save"]').click();
  await expect(page.locator('[data-cd-posting-status]')).toContainText('Needs attention',{timeout:12000});
  await expect(page.locator('[data-cd-action="add"]')).toBeDisabled();
  await page.locator('[data-cd-posting-status] [data-cd-action="retry"]').click();
  await expect(page.locator('[data-cd-posting-status]')).toContainText('Saved to NetSuite');assert.equal(submissions.length,1);
 } finally {await writeFile(`test-artifacts/control-damage/browser-${crypto.randomUUID()}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}
});
test('CB5: operator report attention remains visible when there is no monthly transfer and can be rechecked',async()=>{
 const {page,context,submissions}=await open({empty:true,reports:[{id:'saved-report',item_name:'Saved SKU',quantity:2,unit:'PCS',status:'attention',safe_to_retry:false,last_error:'Recheck NetSuite',photos:[]}]});
 try {
  await expect(page.locator('.control-damage')).toContainText('No damage Inventory Transfer for this month');
  await expect(page.locator('.control-damage-report-history')).toContainText('Saved SKU');
  await page.locator('[data-cd-action="retry-report"]').click();await expect(page.locator('.control-damage-report-history')).toHaveCount(0);
  assert.equal(submissions.length,0);
 } finally {await writeFile(`test-artifacts/control-damage/browser-${crypto.randomUUID()}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}
});

test('CB6: changing quantity preserves the existing IT unit when it is not an item default',async()=>{
 const {page,context,submissions}=await open({existingUnit:true});
 try {
  await page.locator('[data-cd-action="edit"]').click();await expect(page.locator('[data-cd-unit]')).toHaveValue('188');
  await page.locator('[data-cd-quantity]').fill('9');await page.locator('[data-cd-action="apply-line"]').click();
  await page.locator('[data-cd-note]').fill('Retain the transfer unit');await page.locator('[data-cd-action="save"]').click();
  await expect(page.locator('[data-cd-posting-status]')).toContainText('Saved to NetSuite',{timeout:12000});
  assert.equal(submissions[0].changes[0].unitId,188);
 } finally {await writeFile(`test-artifacts/control-damage/browser-${crypto.randomUUID()}.json`,JSON.stringify(await page.coverage.stopJSCoverage()));await context.close();}
});
