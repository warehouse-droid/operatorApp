import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
import {app} from '../../../src/server.js';
import {config} from '../../../src/config.js';
import {query,closeDb} from '../../../src/db.js';
import {updateOperatorPassword,loginOperator} from '../../../src/auth-repository.js';
import {editFixture,visitState} from '../support/bin-workflow-edit-fixtures.js';
import {linkedIntent} from '../support/bin-linked-delivery-fixtures.js';
import {run,storedPlan} from '../support/bin-planning-fixtures.js';
import {withBrowserCoverageSources} from '../support/browser-source-coverage.js';
after(closeDb);
const collected=[];
for(const planned of [false,true,'collection']) test(`browser edit locks: ${planned==='collection'?'planned collection retains its receiving order while replacement changes':planned?'planned delivery leaves collection route editable':'both unplanned linked parts unlock all route controls'}`,{timeout:90000},async()=>{
  const collectionPlanned=planned==='collection';
  const f=await editFixture({sequence:collectionPlanned?'collection_first':'delivery_first'});
  if(planned) await run(f,'assign',await linkedIntent(collectionPlanned?f.collection:f.delivery));
  const before=await visitState(collectionPlanned?f.collection.visitId:f.delivery.visitId),plan=await storedPlan(f.planId);
  await updateOperatorPassword(f.actor.operatorId,'edit-lock-browser-password');
  const token=(await loginOperator(f.actor.operatorId,'edit-lock-browser-password')).token;
  config.mbt.enabled=true;config.mbtPhase3.binDispatchEnabled=true;config.dispatch.driverOrientedPlanning=true;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ('mbt_enabled','mbt_bin_dispatch')");
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});let browser;
  try {
    browser=await chromium.launch({headless:true,executablePath:'/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--disable-dev-shm-usage']});
    const context=await browser.newContext({viewport:{width:1500,height:1000}});context.setDefaultTimeout(10000);
    await context.addInitScript(({token,f})=>{
      localStorage.setItem('mbbs.staff.token',token);localStorage.setItem('mbbs.dispatch.planDate',f.planDate);
      sessionStorage.setItem('mbbs.dispatch.sessionId',f.editLease.sessionId);
      sessionStorage.setItem('mbbs.dispatch.editLease.v1',JSON.stringify({planDate:f.planDate,sessionId:f.editLease.sessionId,editLeaseToken:f.editLease.token,expiresAt:new Date(Date.now()+600000).toISOString()}));
    },{token,f});
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.coverage.startJSCoverage({resetOnNavigation:false});
    await page.goto(`http://127.0.0.1:${server.address().port}/mbt/planning?planDate=${f.planDate}`);
    await expect.poll(()=>page.evaluate(()=>isDispatchPlanEditor())).toBe(true);
    const open=()=>page.evaluate(id=>window.BinOrderWorkflowUI.open(id,{headers:()=>dispatchAuthHeaders(),onSaved:async()=>{}}),f.collection.visitId);
    await open();const dialog=page.getByRole('dialog',{name:`Plan ${f.collection.reference.replace(/C$/,'')}`});
    await expect(dialog.locator('[name="sequence"]'))[planned?'toBeDisabled':'toBeEnabled']();
    await expect(dialog.locator('[name="reuse"]'))[planned?'toBeDisabled':'toBeEnabled']();
    await expect(dialog.locator('[name="dumpSiteId"]'))[collectionPlanned?'toBeDisabled':'toBeEnabled']();
    await expect(dialog.locator('[name="destinationKind"]'))[collectionPlanned?'toBeDisabled':'toBeEnabled']();
    await expect(dialog.locator('[name="nextOrderId"]')).toHaveValue(f.target.frontVisitId);
    if(collectionPlanned) {
      await expect(dialog.locator('[name="deliveryAssetId"]')).toBeEnabled();
      await dialog.locator('[name="deliveryAssetId"]').selectOption(f.target.assetId);
    } else {
      await dialog.locator('[name="dumpSiteId"]').selectOption(f.dumpIds[1]);
      await dialog.locator('[name="destinationKind"]').selectOption('yard');
      await dialog.locator('[name="yardId"]').selectOption('00000000-0000-4000-8000-000000012441');
    }
    await dialog.getByRole('button',{name:'Save route',exact:true}).click();await expect(dialog).toHaveCount(0);
    if(collectionPlanned) {
      assert.deepEqual(await visitState(f.collection.visitId),before);assert.deepEqual(await storedPlan(f.planId),plan);
      assert.equal((await visitState(f.delivery.visitId)).visit.expected_asset_id,f.target.assetId);
    } else if(planned) {
      assert.deepEqual(await visitState(f.delivery.visitId),before);assert.deepEqual(await storedPlan(f.planId),plan);
      await run(f,'assign',await linkedIntent(f.collection));await open();
      await expect(dialog.locator('[name="sequence"]')).toBeDisabled();
      await expect(dialog.locator('[name="dumpSiteId"]')).toBeDisabled();
      await expect(dialog.locator('[name="destinationKind"]')).toBeDisabled();
      await dialog.getByRole('button',{name:'Close workflow'}).click();
      await run(f,'cancel',await linkedIntent(f.collection));await run(f,'cancel',await linkedIntent(f.delivery));
      await open();await expect(dialog.locator('[name="sequence"]')).toBeEnabled();await expect(dialog.locator('[name="dumpSiteId"]')).toBeEnabled();
    }
    assert.deepEqual(errors,[]);
    collected.push(...await withBrowserCoverageSources(page,await page.coverage.stopJSCoverage()));
    writeFileSync('test-artifacts/bin-workflow-edit-browser-v8.json',JSON.stringify(collected));
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
