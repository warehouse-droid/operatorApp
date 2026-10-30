import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
import {app} from '../../../src/server.js';
import {config} from '../../../src/config.js';
import {query,closeDb} from '../../../src/db.js';
import {updateOperatorPassword,loginOperator} from '../../../src/auth-repository.js';
import {upsertDispatchOrderCatalog} from '../../../src/dispatch-order-catalog-repository.js';
import {transportFixture} from '../support/bin-transport-fixtures.js';
import {withBrowserCoverageSources} from '../support/browser-source-coverage.js';
after(closeDb);

test('Transport errors browser: 17,350 lb mixed aggregate shows missing capacity and preserves route for recovery',{timeout:90000},async()=>{
  const f=await transportFixture();
  await upsertDispatchOrderCatalog({orders:[{...f.order,items:[
    {itemId:9913,lineRowId:'loose-1',lineId:1,itemName:'Aggregate-Crusher Run',quantity:9,unit:'Yard',lineWeight:12150},
    {itemId:9910,lineRowId:'machine-2',lineId:2,itemName:'Aggregate-HPB',quantity:4,unit:'Yard',lineWeight:5200}
  ]}],source:'test'});
  await query('UPDATE mbt_bin_types SET maximum_payload_kg=NULL WHERE bin_type_id=(SELECT bin_type_id FROM mbt_bin_assets WHERE asset_id=$1)',[f.assetId]);
  await updateOperatorPassword(f.actor.operatorId,'transport-errors-browser-password');
  const token=(await loginOperator(f.actor.operatorId,'transport-errors-browser-password')).token;
  config.mbt.enabled=true;config.mbtPhase3.binDispatchEnabled=true;config.dispatch.driverOrientedPlanning=true;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ('mbt_enabled','mbt_bin_dispatch')");
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});let browser;
  try {
    browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const context=await browser.newContext({viewport:{width:1500,height:1000}});context.setDefaultTimeout(10000);
    await context.addInitScript(({token,f})=>{
      localStorage.setItem('mbbs.staff.token',token);localStorage.setItem('mbbs.dispatch.planDate',f.planDate);
      sessionStorage.setItem('mbbs.dispatch.sessionId',f.editLease.sessionId);
      sessionStorage.setItem('mbbs.dispatch.editLease.v1',JSON.stringify({planDate:f.planDate,sessionId:f.editLease.sessionId,editLeaseToken:f.editLease.token,expiresAt:new Date(Date.now()+600000).toISOString()}));
    },{token,f});
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.coverage.startJSCoverage({resetOnNavigation:false});
    await page.goto(`http://127.0.0.1:${server.address().port}/mbt/planning?planDate=${f.planDate}`);
    await expect.poll(()=>page.evaluate(()=>isDispatchPlanEditor())).toBe(true);
    // This disposable catalog fixture has no NetSuite list entry. Open the real
    // editor by reference; its authenticated options/save endpoints remain real.
    await page.evaluate(ref=>BinTransportUI.open(ref,{headers:dispatchAuthHeaders,planDate:currentPlanDate,
      canEdit:isDispatchPlanEditor(),onSaved:async()=>{}}),f.sourceRef);
    const dialog=page.getByRole('dialog',{name:'Plan transport'});
    await dialog.locator('[name="assetId"]').selectOption(f.assetId);
    await dialog.locator('[data-line-key="loose-1"]').fill('9');
    await dialog.locator('[data-line-key="machine-2"]').fill('4');
    await dialog.locator('[name="pickupYard"]').selectOption({label:'150'});
    await dialog.locator('[name="returnKind"]').selectOption('delivery');
    await dialog.locator('[name="deliveryVisitId"]').selectOption(f.part.visitId);
    await dialog.getByRole('button',{name:'Save route',exact:true}).click();
    await expect(dialog.locator('[data-message]')).toContainText('maximum payload');
    await expect(dialog.locator('[data-message]')).toContainText('not configured');
    await expect(dialog.locator('[data-weight-summary]')).toContainText('17,350 lb');
    await expect(dialog.locator('[data-weight-summary]')).toContainText('not configured');
    await expect(dialog.locator('[name="deliveryVisitId"]')).toHaveValue(f.part.visitId);
    await expect(dialog.locator('[data-line-key="loose-1"]')).toHaveValue('9');
    await expect(dialog.locator('[data-line-key="machine-2"]')).toHaveValue('4');
    await dialog.locator('[data-line-key="loose-1"]').fill('4.5');
    await dialog.locator('[data-line-key="machine-2"]').fill('2');
    await expect(dialog.locator('[data-weight-summary]')).toContainText('8,675 lb');
    await dialog.locator('[data-line-key="loose-1"]').fill('9');
    await dialog.locator('[data-line-key="machine-2"]').fill('4');
    await query('UPDATE mbt_bin_types SET maximum_payload_kg=27215 WHERE bin_type_id=(SELECT bin_type_id FROM mbt_bin_assets WHERE asset_id=$1)',[f.assetId]);
    await dialog.getByRole('button',{name:'Save route',exact:true}).click();await expect(dialog).toHaveCount(0);
    const trip=(await query('SELECT * FROM mbt_transport_trips WHERE source_key=lower($1)',[f.sourceRef])).rows[0];
    assert.equal(Number(trip.weight_lbs),17350);assert.equal(trip.route.returnDestination.visitId,f.part.visitId);
    assert.deepEqual(trip.allocations.map(line=>line.quantity),['9','4']);assert.deepEqual(errors,[]);
    writeFileSync('test-artifacts/transport-errors-browser-v8.json',JSON.stringify(await withBrowserCoverageSources(page,await page.coverage.stopJSCoverage())));
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
