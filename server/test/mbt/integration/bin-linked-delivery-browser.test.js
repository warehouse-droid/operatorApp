import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
import {app} from '../../../src/server.js';
import {config} from '../../../src/config.js';
import {query,closeDb} from '../../../src/db.js';
import {updateOperatorPassword,loginOperator} from '../../../src/auth-repository.js';
import {linkedFixture} from '../support/bin-linked-delivery-fixtures.js';
import {storedPlan} from '../support/bin-planning-fixtures.js';
import {withBrowserCoverageSources} from '../support/browser-source-coverage.js';
after(closeDb);
async function dragAcrossTimeline(page,sourceCard,targetCard) {
  let source,target;
  await expect(async()=>{
    await sourceCard.scrollIntoViewIfNeeded();source=await sourceCard.boundingBox();
    assert.ok(source,'The drag source must be attached and visible.');
  }).toPass({timeout:10000});
  await page.mouse.move(source.x+source.width*.6,source.y+Math.min(25,source.height/2));
  await page.mouse.down();await page.mouse.move(source.x+source.width*.6+10,source.y+30,{steps:5});
  await expect(async()=>{
    await targetCard.scrollIntoViewIfNeeded();target=await targetCard.boundingBox();
    assert.ok(target,'The drop target must be attached and visible.');
  }).toPass({timeout:10000});
  await page.mouse.move(target.x+target.width*.6,target.y+Math.min(20,target.height/2),{steps:8});
  await page.mouse.move(target.x+target.width*.6+2,target.y+Math.min(22,target.height/2));await page.mouse.up();
}
test('browser: dragging collection includes linked cargo delivery and distinguishes bin source from material pickup',{timeout:90000},async()=>{
  const f=await linkedFixture();
  // A receiving customer's earlier request must never sort delivery before collection/dumping.
  await query('UPDATE mbt_service_visits SET scheduled_start_at=$2,scheduled_end_at=$3 WHERE service_visit_id=$1',
    [f.delivery.visitId,`${f.planDate}T07:00:00Z`,`${f.planDate}T08:00:00Z`]);
  await query('UPDATE mbt_service_visits SET scheduled_start_at=$2,scheduled_end_at=$3 WHERE service_visit_id=$1',
    [f.collection.visitId,`${f.planDate}T09:00:00Z`,`${f.planDate}T10:00:00Z`]);
  await updateOperatorPassword(f.actor.operatorId,'linked-browser-password');
  await query("UPDATE mbt_service_visits SET status='cancelled',cancelled_at=now(),cancellation_reason='Test unavailable receiving order',revision=revision+1 WHERE service_visit_id=$1",[f.delivery.visitId]);
  const token=(await loginOperator(f.actor.operatorId,'linked-browser-password')).token;
  config.mbt.enabled=true;config.mbtPhase3.binDispatchEnabled=true;config.dispatch.driverOrientedPlanning=true;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ('mbt_enabled','mbt_bin_dispatch')");
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});let browser;
  try {
    browser=await chromium.launch({headless:true,executablePath:'/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--disable-dev-shm-usage']});
    const context=await browser.newContext({viewport:{width:1600,height:1000}});context.setDefaultTimeout(10000);
    await context.addInitScript(({token,f})=>{
      localStorage.setItem('mbbs.staff.token',token);localStorage.setItem('mbbs.dispatch.planDate',f.planDate);
      sessionStorage.setItem('mbbs.dispatch.sessionId',f.editLease.sessionId);
      sessionStorage.setItem('mbbs.dispatch.editLease.v1',JSON.stringify({planDate:f.planDate,sessionId:f.editLease.sessionId,editLeaseToken:f.editLease.token,expiresAt:new Date(Date.now()+600000).toISOString()}));
    },{token,f});
    const page=await context.newPage(),errors=[],coverage=[];page.on('pageerror',error=>errors.push(error.message));
    await page.coverage.startJSCoverage({resetOnNavigation:false});
    await page.goto(`http://127.0.0.1:${server.address().port}/mbt/planning?planDate=${f.planDate}`);
    await expect.poll(()=>page.evaluate(()=>isDispatchPlanEditor())).toBe(true);
    await page.locator('.order-type-tabs').getByRole('button',{name:'Collection',exact:true}).click();
    const collection=page.locator(`.order-card[data-order="${f.collection.reference}"]`);
    await expect(collection).toBeVisible();
    const unavailable=await page.evaluate(({ref,load})=>({added:addOrderToLoad(ref,load),notice:routeNotice}),{ref:f.collection.reference,load:f.binLoadIds[0]});
    assert.equal(unavailable.added,false);assert.match(unavailable.notice,/linked delivery.*unavailable/i);
    await query("UPDATE mbt_service_visits SET status='ready',cancelled_at=NULL,cancellation_reason=NULL,revision=revision+1 WHERE service_visit_id=$1",[f.delivery.visitId]);
    coverage.push(...await withBrowserCoverageSources(page,await page.coverage.stopJSCoverage()));
    await page.coverage.startJSCoverage({resetOnNavigation:false});
    await page.reload();await expect.poll(()=>page.evaluate(()=>isDispatchPlanEditor())).toBe(true);
    const pickup=await page.evaluate(ref=>orderById(ref).pickupLocations,f.delivery.reference);
    assert.ok(pickup.some(value=>value.includes('After dumping: 3445 Kennedy Road')));
    assert.ok(pickup.some(value=>value.includes('Material pickup:')&&value.includes('150')));
    assert.equal(await page.evaluate(({ref,load})=>addOrderToLoad(ref,load),{ref:f.delivery.reference,load:f.binLoadIds[0]}),false);
    await page.getByRole('textbox',{name:'Search orders',exact:true}).fill(f.collection.reference);
    await expect(collection).toBeVisible();
    const load=page.locator(`[data-load-card="${f.binLoadIds[0]}"]`);
    await collection.dragTo(load.locator('.stop-list'));
    await expect(load.locator('.stop-card[data-stop]')).toHaveCount(4);
    const saved=await page.evaluate(async()=>{await saveCurrentPlanNow();return {dirty:localPlanDirty,notice:routeNotice};});
    assert.equal(saved.dirty,false,saved.notice);
    const plan=await storedPlan(f.planId);assert.deepEqual(plan.trucks[0].loads[0].stops.map(s=>s.actionCode),['pickup_bin','dump_bin','cargo_pickup_1','deliver_bin']);
    const optimized=await page.evaluate(async id=>{
      selectedLoadId=id;optimizeSelectedRoute();
      const actions=findLoad(id).load.stops.map(s=>s.actionCode);
      await saveCurrentPlanNow();if(localPlanDirty) throw new Error('The optimized route did not finish saving.');
      return actions;
    },f.binLoadIds[0]);
    coverage.push(...await withBrowserCoverageSources(page,await page.coverage.stopJSCoverage()));
    await page.coverage.startJSCoverage({resetOnNavigation:false});
    await page.reload();await expect.poll(()=>page.evaluate(()=>isDispatchPlanEditor())).toBe(true);
    await page.waitForLoadState('networkidle');
    await expect(load.locator('.stop-card[data-stop]')).toHaveCount(4);
    const target=page.locator(`[data-load-card="${f.binLoadIds[1]}"] .stop-list`);
    await dragAcrossTimeline(page,load.locator('.stop-card[data-stop]').last(),target);
    await expect(target.locator('.stop-card[data-stop]')).toHaveCount(4);
    assert.equal((await page.evaluate(async()=>{await saveCurrentPlanNow();return {dirty:localPlanDirty};})).dirty,false);
    await target.locator('[data-action="remove-stop"]').first().click();
    await expect(target.locator('.stop-card[data-stop]')).toHaveCount(0);
    const replanned=await page.evaluate(({ref,load})=>{
      const added=addOrderToLoad(ref,load);render({save:false});return {added,actions:findLoad(load).load.stops.map(s=>s.actionCode)};
    },{ref:f.collection.reference,load:f.binLoadIds[1]});
    if(replanned.added) await target.locator('[data-action="remove-stop"]').first().click();
    assert.equal((await page.evaluate(async()=>{await saveCurrentPlanNow();return {dirty:localPlanDirty};})).dirty,false);
    const actions=['pickup_bin','dump_bin','cargo_pickup_1','deliver_bin'];
    assert.deepEqual({optimized,replanned},{optimized:actions,replanned:{added:true,actions}});
    assert.deepEqual(errors,[]);
    coverage.push(...await withBrowserCoverageSources(page,await page.coverage.stopJSCoverage()));
    writeFileSync('test-artifacts/bin-linked-browser-v8.json',JSON.stringify(coverage));
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
