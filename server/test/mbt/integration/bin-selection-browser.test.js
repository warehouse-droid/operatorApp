import {withBrowserCoverageSources} from "../support/browser-source-coverage.js";
import assert from "node:assert/strict";
import test,{after} from "node:test";
import crypto from "node:crypto";
import {writeFileSync} from "node:fs";
import {chromium,expect} from "@playwright/test";
import {app} from "../../../src/server.js";
import {config} from "../../../src/config.js";
import {query,closeDb} from "../../../src/db.js";
import {updateOperatorPassword,loginOperator} from "../../../src/auth-repository.js";
import {planningFixture,run} from "../support/bin-planning-fixtures.js";
import {configureBinOrderWorkflow} from "../../../src/mbt/bin-order-workflow-service.js";
after(closeDb);

test("browser: change the bin on a released stop and show its readable reference and physical bin",{timeout:90000},async()=>{
  const f=await planningFixture(5100),alternate=await planningFixture(5101),lineId=crypto.randomUUID();
  await query(`INSERT INTO mbt_contract_service_lines(service_line_id,contract_id,line_number,bin_type_id,
    customer_site_profile_id,site_snapshot,pricing_snapshot) SELECT $1,contract_id,1,bin_type_id,
    customer_site_profile_id,site_snapshot,pricing_snapshot FROM mbt_contracts WHERE contract_id=$2`,[lineId,f.contractId]);
  await query("UPDATE mbt_service_visits SET service_line_id=$1 WHERE contract_id=$2",[lineId,f.contractId]);
  const configured=await configureBinOrderWorkflow({visitId:f.frontVisitId,expectedRevision:1,actor:f.actor,
    idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),
    deliveryAssetId:f.assetId,deliveryWindow:{startAt:`${f.planDate}T11:00:00Z`,endAt:`${f.planDate}T12:00:00Z`}});
  const part=configured.body.parts[0];
  await run(f,"assign",{visitId:part.visitId,expectedVisitRevision:part.revision}); await run(f,"confirm");
  await updateOperatorPassword(f.actor.operatorId,"bin-selection-browser-password");
  const token=(await loginOperator(f.actor.operatorId,"bin-selection-browser-password")).token;
  config.mbt.enabled=true;config.mbtPhase3.binDispatchEnabled=true;config.dispatch.driverOrientedPlanning=true;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ('mbt_enabled','mbt_bin_dispatch')");
  const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});
  let browser;
  try {
    browser=await chromium.launch({headless:true,executablePath:"/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell",args:["--no-sandbox","--disable-dev-shm-usage"]});
    const context=await browser.newContext({viewport:{width:1600,height:1000}});context.setDefaultTimeout(12000);
    await context.addInitScript(({token,f})=>{
      localStorage.setItem("mbbs.staff.token",token);localStorage.setItem("mbbs.dispatch.planDate",f.planDate);
      sessionStorage.setItem("mbbs.dispatch.sessionId",f.editLease.sessionId);
      sessionStorage.setItem("mbbs.dispatch.editLease.v1",JSON.stringify({planDate:f.planDate,sessionId:f.editLease.sessionId,
        editLeaseToken:f.editLease.token,expiresAt:new Date(Date.now()+600000).toISOString()}));
    },{token,f});
    const page=await context.newPage(),errors=[];await page.coverage.startJSCoverage({resetOnNavigation:false});page.on("pageerror",e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/mbt/planning?planDate=${f.planDate}`);
    await expect.poll(()=>page.evaluate(()=>isDispatchPlanEditor())).toBe(true);
    await page.evaluate(reference=>{selectedOrderId=reference;selectedOrderIds=new Set([reference]);render({save:false});},part.reference);
    const button=page.locator('.selected-order-actions').getByRole("button",{name:"Change bin",exact:true});
    await expect(button).toBeVisible();await button.click();
    const dialog=page.getByRole("dialog",{name:"Change bin"});
    await dialog.getByRole('searchbox',{name:'Search bins'}).fill(alternate.assetCode);
    await expect(dialog.locator('[name="assetId"] option:not([value=""])')).toHaveCount(1);
    await dialog.locator('[name="assetId"]').selectOption(alternate.assetId);
    await expect(dialog).toContainText(alternate.assetCode);
    await dialog.getByRole("button",{name:"Save bin selection",exact:true}).click();
    await expect(dialog).toHaveCount(0);
    const stops=page.locator(`[data-load-card="${f.binLoadIds[0]}"] .stop-card[data-stop]`);
    await expect(stops).toHaveCount(2);
    for (const stop of await stops.all()) {await expect(stop).toContainText(part.reference);await expect(stop).toContainText(alternate.assetCode);}
    const active=(await query(`SELECT a.released_at,v.expected_asset_id FROM mbt_bin_planning_assignments a
      JOIN mbt_service_visits v ON v.service_visit_id=a.service_visit_id WHERE a.service_visit_id=$1 AND a.withdrawn_at IS NULL`,[part.visitId])).rows[0];
    assert.ok(active.released_at);assert.equal(active.expected_asset_id,alternate.assetId);assert.deepEqual(errors,[]);
    writeFileSync("test-artifacts/bin-selection-browser-v8.json",JSON.stringify(await withBrowserCoverageSources(page,await page.coverage.stopJSCoverage())));
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
