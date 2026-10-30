import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {app} from '../../../src/server.js';
import {config} from '../../../src/config.js';
import {query,closeDb} from '../../../src/db.js';
import {updateOperatorPassword,loginOperator} from '../../../src/auth-repository.js';
import {planningFixture,run} from '../support/bin-planning-fixtures.js';
import {configureBinOrderWorkflow} from '../../../src/mbt/bin-order-workflow-service.js';
import {withBrowserCoverageSources} from '../support/browser-source-coverage.js';
after(closeDb);

test('browser: search planned and completed BIN orders and open the matching date and load', {timeout:90000},async()=>{
  const home=await planningFixture(5700),targets=[];
  for (const [offset,status] of [[5701,'ready'],[5702,'completed']]) {
    const f=await planningFixture(offset),lineId=crypto.randomUUID();
    await query(`INSERT INTO mbt_contract_service_lines(service_line_id,contract_id,line_number,bin_type_id,
      customer_site_profile_id,site_snapshot,pricing_snapshot) SELECT $1,contract_id,1,bin_type_id,
      customer_site_profile_id,site_snapshot,pricing_snapshot FROM mbt_contracts WHERE contract_id=$2`,[lineId,f.contractId]);
    await query('UPDATE mbt_service_visits SET service_line_id=$1 WHERE contract_id=$2',[lineId,f.contractId]);
    const root=(await query('SELECT scheduled_start_at,scheduled_end_at FROM mbt_service_visits WHERE service_visit_id=$1',[f.frontVisitId])).rows[0];
    const result=await configureBinOrderWorkflow({visitId:f.frontVisitId,actor:f.actor,expectedRevision:1,
      idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),
      deliveryAssetId:f.assetId,deliveryWindow:{startAt:root.scheduled_start_at.toISOString(),endAt:root.scheduled_end_at.toISOString()}});
    const part=result.body.parts[0];await run(f,'assign',{visitId:part.visitId,expectedVisitRevision:part.revision});
    if (status==='completed') await query("UPDATE mbt_service_visits SET status='completed',actual_completed_at=now() WHERE service_visit_id=$1",[part.visitId]);
    targets.push({...f,part,status});
  }
  await updateOperatorPassword(home.actor.operatorId,'bin-search-test-password');
  const token=(await loginOperator(home.actor.operatorId,'bin-search-test-password')).token;
  config.mbt.enabled=true;config.mbtPhase3.binDispatchEnabled=true;config.dispatch.driverOrientedPlanning=true;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ('mbt_enabled','mbt_bin_dispatch')");
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});let browser;
  try {
    browser=await chromium.launch({headless:true,executablePath:'/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--disable-dev-shm-usage']});
    const context=await browser.newContext({viewport:{width:1280,height:900}});
    await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),token);
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000);
    await page.coverage.startJSCoverage({resetOnNavigation:false});
    await page.goto(`http://127.0.0.1:${server.address().port}/mbt/planning?planDate=${home.planDate}`);
    for(const target of targets) {
      await page.locator('#orderSearch').fill(target.part.reference);
      const card=page.locator(`.order-card[data-order="${target.part.reference}"]`);
      await expect(card).toHaveCount(1);await expect(card).toContainText(target.planDate);
      await expect(card).toHaveAttribute('draggable','false');
      await expect(card.locator('button,select,input')).toHaveCount(0);
      if(target.status==='completed') await expect(card).toContainText('Completed');
      await card.click();
      try {await expect.poll(()=>page.evaluate(()=>currentPlanDate)).toBe(target.planDate);}
      catch(error) {
        console.error('BIN search navigation diagnostic',await page.evaluate(id=>({date:currentPlanDate,notice:routeNotice,
          selected:selectedOrderId,dirty:localPlanDirty,order:orderById(id),planId:currentPlan?.id,
          elsewhere:isOrderPlannedOutsideCurrentPlan(orderById(id))}),target.part.reference));
        throw error;
      }
      await expect.poll(()=>page.evaluate(()=>selectedLoadId)).toBe(target.binLoadIds[0]);
      await expect.poll(()=>page.evaluate(()=>loadPreviewOpen)).toBe(true);
      await expect(page.locator(`[data-load-card="${target.binLoadIds[0]}"] .stop-card[data-stop]`)).toHaveCount(2);
      if(target.status==='completed') await expect(page.locator('[data-dispatch-order-actions]').getByRole('button',{name:'Change bin',exact:true})).toHaveCount(0);
    }
    assert.deepEqual(errors,[]);
    await writeFile('test-artifacts/bin-planning-search-browser-v8.json',JSON.stringify(await withBrowserCoverageSources(page,await page.coverage.stopJSCoverage())));
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
