import assert from "node:assert/strict";
import test,{after} from "node:test";
import crypto from "node:crypto";
import {writeFile} from "node:fs/promises";
import { chromium,expect } from "@playwright/test";
import { app } from "../../../src/server.js";
import { config } from "../../../src/config.js";
import { query,closeDb,withTransaction } from "../../../src/db.js";
import { updateOperatorPassword,loginOperator } from "../../../src/auth-repository.js";
import { planningFixture,storedPlan } from "../support/bin-planning-fixtures.js";
import { getBinOrderWorkflow } from "../../../src/mbt/bin-order-workflow-service.js";
import { recordAssetMovement } from "../../../src/mbt/asset-service.js";
after(closeDb);

test("browser: dispatcher configures a readable BIN delivery, assigns it and retains actual pickup details", {timeout:90000},async()=>{
  const f=await planningFixture(4400),lineId=crypto.randomUUID();
  await query(`INSERT INTO mbt_contract_service_lines(service_line_id,contract_id,line_number,bin_type_id,
    customer_site_profile_id,site_snapshot,pricing_snapshot) SELECT $1,contract_id,1,bin_type_id,
    customer_site_profile_id,site_snapshot,pricing_snapshot FROM mbt_contracts WHERE contract_id=$2`,[lineId,f.contractId]);
  await query("UPDATE mbt_service_visits SET service_line_id=$1 WHERE contract_id=$2",[lineId,f.contractId]);
  const order=await getBinOrderWorkflow(f.frontVisitId);
  await query("UPDATE operators SET roles=ARRAY['dispatcher','mbt_frontdesk'] WHERE id=$1",[f.actor.operatorId]);
  await updateOperatorPassword(f.actor.operatorId,"bin-workflow-test-password");
  const token=(await loginOperator(f.actor.operatorId,"bin-workflow-test-password")).token;
  config.mbt.enabled=true;config.mbtPhase3.binDispatchEnabled=true;config.dispatch.driverOrientedPlanning=true;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ('mbt_enabled','mbt_bin_dispatch')");
  const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});
  let browser;
  try {
    browser=await chromium.launch({headless:true,executablePath:"/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell",
      args:["--no-sandbox","--disable-dev-shm-usage"]});
    const context=await browser.newContext({viewport:{width:1600,height:1000}});
    context.setDefaultTimeout(12000);
    await context.addInitScript(({token,f})=>{
      localStorage.setItem("mbbs.staff.token",token);localStorage.setItem("mbbs.dispatch.planDate",f.planDate);
      sessionStorage.setItem("mbbs.dispatch.sessionId",f.editLease.sessionId);
      sessionStorage.setItem("mbbs.dispatch.editLease.v1",JSON.stringify({planDate:f.planDate,sessionId:f.editLease.sessionId,
        editLeaseToken:f.editLease.token,expiresAt:new Date(Date.now()+600000).toISOString()}));
    },{token,f});
    const page=await context.newPage(),errors=[],coverage=[];
    await page.coverage.startJSCoverage({resetOnNavigation:false});
    const checkpointCoverage=async()=>{
      coverage.push(...await page.coverage.stopJSCoverage());
      await page.coverage.startJSCoverage({resetOnNavigation:false});
    };
    page.on("pageerror",e=>errors.push(e.message));
    const origin=`http://127.0.0.1:${server.address().port}`;
    const denied=await fetch(`${origin}/api/mbt/planning/workflows/${f.frontVisitId}`);
    assert.ok([401,403].includes(denied.status));
    await page.goto(`${origin}/mbt/planning?planDate=${f.planDate}`);
    await expect.poll(()=>page.evaluate(()=>isDispatchPlanEditor())).toBe(true);
    const card=page.locator(`.order-card[data-order="${order.reference}"]`);
    await expect(card.getByRole("button",{name:"Configure delivery"})).toBeVisible();
    await card.getByRole("button",{name:"Configure delivery"}).click();
    const dialog=page.getByRole("dialog",{name:`Configure ${order.reference}`});
    await dialog.locator('[name="deliveryAssetId"]').selectOption(f.assetId);
    await expect(dialog.locator("[data-source]")).not.toContainText("undefined");
    await expect(dialog.locator("[data-source]")).not.toContainText("Unknown");
    await page.screenshot({path:"test-artifacts/bin-workflow-configure.png",fullPage:true});
    await dialog.getByRole("button",{name:"Save workflow",exact:true}).click();
    await expect(dialog).toHaveCount(0);
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(f.assetCode);
    const load=page.locator(`[data-load-card="${f.binLoadIds[0]}"]`);
    await card.dragTo(load.locator(".stop-list"));
    await expect(load.locator(".stop-card[data-stop]")).toHaveCount(2);
    const saved=await page.evaluate(async()=>{await saveCurrentPlanNow();return {dirty:localPlanDirty,notice:routeNotice};});
    assert.equal(saved.dirty,false,saved.notice);
    const plan=await storedPlan(f.planId);
    const stops=plan.trucks.flatMap(t=>t.loads).flatMap(l=>l.stops).filter(s=>s.reference===order.reference);
    assert.equal(stops.length,2);
    assert.ok(stops.every(s=>s.planningAddress && s.planningAddress!=="undefined"));
    await page.screenshot({path:"test-artifacts/bin-workflow-planned.png",fullPage:true});
    await checkpointCoverage();
    await page.reload();
    await expect(page.locator(`[data-load-card="${f.binLoadIds[0]}"] .stop-card[data-stop]`)).toHaveCount(2);
    const c=await planningFixture(4401),collectionLine=crypto.randomUUID();
    await query(`INSERT INTO mbt_contract_service_lines(service_line_id,contract_id,line_number,bin_type_id,
      customer_site_profile_id,site_snapshot,pricing_snapshot) SELECT $1,contract_id,1,bin_type_id,
      customer_site_profile_id,site_snapshot,pricing_snapshot FROM mbt_contracts WHERE contract_id=$2`,[collectionLine,c.contractId]);
    await query("UPDATE mbt_service_visits SET service_line_id=$1 WHERE contract_id=$2",[collectionLine,c.contractId]);
    await withTransaction(()=>recordAssetMovement({query,ambientTransaction:true},{assetId:c.assetId,movementType:"deliver_bin_expected",
      afterStatus:"at_customer",afterLocation:{kind:"customer_site",reference:"100 Test Route",customerSiteProfileId:c.siteProfileId},
      contractId:c.contractId,visitId:c.frontVisitId,source:"workflow-browser",actorType:"system",actorId:"test",
      occurredAt:`${c.planDate}T10:00:00Z`}));
    await query("UPDATE mbt_service_visits SET status='completed',actual_completed_at=$2 WHERE service_visit_id=$1",[c.frontVisitId,`${c.planDate}T10:00:00Z`]);
    await query("UPDATE mbt_bin_rental_numbers SET current_asset_id=$2 WHERE service_line_id=$1",[collectionLine,c.assetId]);
    const receiving=await planningFixture(4402),receivingLine=crypto.randomUUID();
    await query(`INSERT INTO mbt_contract_service_lines(service_line_id,contract_id,line_number,bin_type_id,
      customer_site_profile_id,site_snapshot,pricing_snapshot) SELECT $1,contract_id,1,bin_type_id,
      customer_site_profile_id,site_snapshot,pricing_snapshot FROM mbt_contracts WHERE contract_id=$2`,[receivingLine,receiving.contractId]);
    await query("UPDATE mbt_service_visits SET service_line_id=$1 WHERE contract_id=$2",[receivingLine,receiving.contractId]);
    const dumpId=crypto.randomUUID(),materialId=crypto.randomUUID();
    await query("INSERT INTO mbt_materials(material_id,material_code,display_name,created_by,updated_by) VALUES ($1,$2,'Browser fill','test','test')",[materialId,materialId]);
    await query(`INSERT INTO mbt_dump_sites(dump_site_id,dump_site_code,display_name,address_line_1,created_by,updated_by)
      VALUES ($1,$2,'Browser dump','500 Dump Road','test','test')`,[dumpId,dumpId]);
    await query(`INSERT INTO mbt_dump_site_materials(dump_site_material_id,dump_site_id,material_id,accepted,created_by,updated_by)
      VALUES ($1,$2,$3,true,'test','test')`,[crypto.randomUUID(),dumpId,materialId]);
    const openWorkflow=async id=>page.evaluate(async({id,token})=>window.BinOrderWorkflowUI.open(id,{
      headers:()=>({Authorization:`Bearer ${token}`}),onSaved:async()=>{}}),{id,token});
    await openWorkflow(c.successorVisitId);
    const collectionDialog=page.getByRole("dialog");
    await expect(collectionDialog).toContainText(c.assetCode);
    await collectionDialog.locator('[name="dumpChoice"]').selectOption(`${dumpId}|${materialId}`);
    const yard=await collectionDialog.locator('[name="yardId"] option').last().getAttribute("value");
    await collectionDialog.locator('[name="yardId"]').selectOption(yard);
    await collectionDialog.getByRole("button",{name:"Save workflow",exact:true}).click();
    await expect(collectionDialog).toHaveCount(0);
    await openWorkflow(c.successorVisitId);
    await expect(collectionDialog.locator('[name="yardId"]')).toHaveValue(yard);
    await expect(collectionDialog.locator('[name="dumpChoice"]')).toHaveValue(`${dumpId}|${materialId}`);
    await collectionDialog.locator('[name="destinationKind"]').selectOption("delivery");
    await collectionDialog.locator('[name="nextOrderId"]').selectOption(receiving.frontVisitId);
    await collectionDialog.getByRole("button",{name:"Save workflow",exact:true}).click();
    await expect(collectionDialog).toHaveCount(0);
    await openWorkflow(receiving.frontVisitId);
    await expect(page.getByRole("dialog").locator('[name="deliveryAssetId"]')).toHaveValue(c.assetId);
    await expect(page.getByRole("dialog").locator("[data-source]")).toContainText("After dumping:");
    await page.getByRole("dialog").getByRole("button",{name:"Save workflow",exact:true}).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("linked to another rental");
    await expect(page.getByRole("dialog").locator('[name="deliveryAssetId"]')).toHaveValue(c.assetId);
    await page.getByRole("dialog").getByRole("button",{name:"Close workflow"}).click();
    const exchangeId=crypto.randomUUID();
    await query(`INSERT INTO mbt_service_visits(service_visit_id,contract_id,service_line_id,visit_number,visit_reference,
      service_template_version_id,service_action,status,customer_site_profile_id,bin_type_id,expected_asset_id,
      scheduled_start_at,scheduled_end_at,customer_snapshot,site_snapshot,service_snapshot,created_by,updated_by)
      SELECT $1,contract_id,service_line_id,50,$2,service_template_version_id,'exchange_bin','ready',
      customer_site_profile_id,bin_type_id,$3,scheduled_start_at,scheduled_end_at,
      customer_snapshot,site_snapshot,service_snapshot,'test','test' FROM mbt_service_visits WHERE service_visit_id=$4`,
    [exchangeId,`browser-${exchangeId}`,c.assetId,c.frontVisitId]);
    await openWorkflow(exchangeId);
    const exchangeDialog=page.getByRole("dialog");
    await exchangeDialog.locator('[name="sequence"]').selectOption("collection_first");
    await exchangeDialog.locator('[name="reuse"]').selectOption("same_bin");
    await expect(exchangeDialog.locator("[data-delivery-bin]")).toBeHidden();
    await expect(exchangeDialog.locator("[data-destination]")).toBeHidden();
    await expect(exchangeDialog.locator("[data-sequence-help]")).toContainText("same Toronto calendar day");
    await exchangeDialog.locator('[name="dumpChoice"]').selectOption(`${dumpId}|${materialId}`);
    await page.screenshot({path:"test-artifacts/bin-workflow-exchange-configure.png",fullPage:true});
    await exchangeDialog.getByRole("button",{name:"Save workflow",exact:true}).click();
    await expect(exchangeDialog).toHaveCount(0);
    const exchange=await getBinOrderWorkflow(exchangeId);
    assert.equal(exchange.parts.length,2);
    assert.ok(exchange.parts.every(p=>p.assetId===c.assetId));
    assert.match(exchange.parts.find(p=>p.role==="delivery").reference,/X-1D$/);
    await checkpointCoverage();
    await page.reload();
    const exchangeDelivery=exchange.parts.find(p=>p.role==="delivery");
    const replacement=page.locator(`.order-card[data-order="${exchangeDelivery.reference}"]`);
    await expect(replacement).toBeVisible();
    await expect(replacement).toContainText("After dumping:");
    await replacement.getByRole("button",{name:"Details",exact:true}).click();
    const details=page.locator(".bin-visit-details");
    await expect(details).toContainText(exchangeDelivery.reference);
    await expect(details).toContainText("Required steps");
    await details.getByRole("button",{name:"Record physical bin handoff"}).click();
    await expect(page.getByText("No bin from this workflow is currently recorded aboard a truck.",{exact:true})).toBeVisible();
    await details.getByRole("button",{name:"Close",exact:true}).click();
    await withTransaction(()=>recordAssetMovement({query,ambientTransaction:true},{assetId:f.assetId,movementType:"collect_empty_bin_outgoing",
      afterStatus:"on_truck",afterLocation:{kind:"truck",truckId:f.binTruckId,reference:"Empty bin loaded"},
      truckId:f.binTruckId,source:"workflow-browser",actorType:"system",actorId:"test",occurredAt:`${f.planDate}T12:00:00Z`}));
    await page.locator(`[data-load-card="${f.binLoadIds[0]}"] .stop-card[data-stop]`).first().click();
    await page.locator('.selected-order-actions [data-action="bin-details"]').click();
    await details.getByRole("button",{name:"Record physical bin handoff"}).click();
    const handoff=page.getByRole("dialog",{name:"Record physical bin handoff"});
    await handoff.locator('[name="toTruckId"]').selectOption(c.binTruckId);
    await handoff.locator('[name="scannedBinCode"]').fill("WRONG-BIN");
    await handoff.locator('[name="place"]').fill("Transfer yard");
    await handoff.locator('[name="reason"]').fill("Replacement truck took the empty bin");
    await handoff.locator('[name="confirmed"]').check();
    await handoff.getByRole("button",{name:"Record handoff",exact:true}).click();
    await expect(handoff.getByRole("alert")).toContainText("exact physical bin");
    await handoff.locator('[name="scannedBinCode"]').fill(f.assetCode);
    await handoff.getByRole("button",{name:"Record handoff",exact:true}).click();
    await expect(handoff).toHaveCount(0);
    await expect(details).toHaveCount(0);
    assert.equal(String((await query("SELECT truck_id FROM mbt_bin_asset_state WHERE asset_id=$1",[f.assetId])).rows[0].truck_id),c.binTruckId);
    config.mbtPhase3.frontdeskOperationsEnabled=true;
    await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='mbt_frontdesk_operations'");
    const customer=(await query(`SELECT n.netsuite_id::text AS id,n.display_name FROM mbt_contracts c
      JOIN netsuite_customers n ON n.netsuite_id=c.customer_netsuite_id WHERE c.contract_id=$1`,[c.contractId])).rows[0];
    await checkpointCoverage();
    await page.goto(`${origin}/mbt/frontdesk`);
    await expect(page.locator("#frontdeskMessage")).toContainText("Front Desk is ready");
    await page.locator("#customerSearch").fill(customer.display_name);
    await page.locator(`[data-customer-id="${customer.id}"]`).click();
    await page.locator("#contractMaster").getByRole("button",{name:new RegExp(c.contractNumber)}).click();
    await expect(page.locator("#contractCard")).toContainText(`Current physical bin: ${c.assetCode}`);
    await expect(page.locator("#contractCard")).toContainText(exchange.reference+"C");
    await expect(page.locator("#contractCard")).toContainText("Pending collection:");
    await expect(page.locator("#contractCard").getByRole("button",{name:"Exchange bin",exact:true})).toBeDisabled();
    await page.locator("#contractCard").screenshot({path:"test-artifacts/bin-workflow-frontdesk.png"});
    const driverContext=await browser.newContext({viewport:{width:420,height:900}});
    const driverPage=await driverContext.newPage();
    driverPage.on("pageerror",e=>errors.push(e.message));
    await driverPage.coverage.startJSCoverage({resetOnNavigation:false});
    await driverPage.goto(`${origin}/driver`);
    await driverPage.waitForFunction(()=>typeof renderDriverBinSummary==="function" && window.DriverBinUI);
    await driverPage.evaluate(({reference,assetCode,assetId})=>{
      const asset={assetId,assetCode,binTypeCode:"14YD"};
      const content=renderDriverBinSummary({jobId:"presentation-check",status:"pending",mbt:{
        schemaVersion:"mbt-driver-bin-job-v1",displayReference:reference,visitReference:"internal-visit-id",
        actionCode:"deliver_bin",binTypeCode:"14YD",exactAssets:{expected:asset,outgoing:asset,incoming:null},
        evidenceRequirements:[]}});
      const element=document.createElement("main");element.id="workflow-driver-preview";element.innerHTML=content;
      document.body.append(element);
    },{reference:order.reference,assetCode:f.assetCode,assetId:f.assetId});
    const preview=driverPage.locator("#workflow-driver-preview");
    await expect(preview).toContainText(order.reference);
    await expect(preview).toContainText(f.assetCode);
    await expect(preview).not.toContainText("internal-visit-id");
    await expect(preview.locator("[data-bin-asset-role]")).toHaveCount(1);
    await preview.screenshot({path:"test-artifacts/bin-workflow-driver-summary.png"});
    assert.deepEqual(errors,[]);
    await writeFile("test-artifacts/workflow-browser-v8.json",JSON.stringify([
      ...coverage,...await page.coverage.stopJSCoverage(),...await driverPage.coverage.stopJSCoverage()]));
    await driverContext.close();
    await context.close();
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});
