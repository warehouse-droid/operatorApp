import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { query, closeDb, withTransaction } from "../../../src/db.js";
import { getBinOrderWorkflow, configureBinOrderWorkflow, getBinOrderWorkflowOptions } from "../../../src/mbt/bin-order-workflow-service.js";
import { createBinDispatchFixture, binDispatchPlanDate } from "../support/bin-dispatch-fixtures.js";
import { assignMbtBinFrontLeg } from "../../../src/mbt/bin-dispatch-service.js";
import { materializeMbtDriverBinJob, startMbtDriverBinJob, completeMbtDriverBinJob } from "../../../src/mbt/driver-bin-execution-service.js";
import { availableDriverExecutionPlanDate, driverBinEvent, enabledDriverBinBoundary } from "../support/driver-bin-fixtures.js";
import { recordAssetMovement } from "../../../src/mbt/asset-service.js";
import { getMbtBinPlanning } from "../../../src/mbt/bin-planning-read.js";
import { assertFrontdeskBinDelivered } from "../../../src/mbt/frontdesk-bin-readiness.js";
import { planningFixture,run as runPlanning,storedPlan } from "../support/bin-planning-fixtures.js";
import { recordBinWorkflowHandoff } from "../../../src/mbt/bin-order-workflow-handoff.js";
import { extendFrontdeskServiceLine } from "../../../src/mbt/frontdesk-service.js";
import { finishBinWorkflowStep } from "../../../src/mbt/bin-order-workflow-execution.js";
import { assertBinWorkflowPlanDependencies } from "../../../src/mbt/bin-order-workflow-planning.js";
after(closeDb);

let fixtureNumber = 0;
async function fixture(label, planDate = binDispatchPlanDate(fixtureNumber++)) {
  const f = await createBinDispatchFixture({label,planDate,pilotExpiresAt:new Date(Date.now()+172_800_000)});
  return attachRental(f);
}
async function attachRental(f) {
  const serviceLineId = crypto.randomUUID();
  await query(`INSERT INTO mbt_contract_service_lines
    (service_line_id,contract_id,line_number,bin_type_id,customer_site_profile_id,site_snapshot,pricing_snapshot)
    SELECT $1,contract_id,1,bin_type_id,customer_site_profile_id,site_snapshot,pricing_snapshot
    FROM mbt_contracts WHERE contract_id=$2`, [serviceLineId,f.contractId]);
  await query("UPDATE mbt_service_visits SET service_line_id=$1 WHERE contract_id=$2",[serviceLineId,f.contractId]);
  return {...f,serviceLineId};
}
function command(f, overrides = {}) {
  return {visitId:f.frontVisitId,expectedRevision:1,actor:{operatorId:"workflow-dispatcher",roles:["dispatcher"]},
    idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),
    reason:"Plan approved BIN workflow",deliveryAssetId:f.assetId,
    deliveryWindow:{startAt:`${f.planDate}T12:00:00Z`,endAt:`${f.planDate}T14:00:00Z`},...overrides};
}

test("BIN workflow: root references are stable and different rentals receive different numbers", async () => {
  const first = await fixture("references-a");
  const second = await fixture("references-b");
  const a = await getBinOrderWorkflow(first.frontVisitId);
  const b = await getBinOrderWorkflow(second.frontVisitId);
  const c = await getBinOrderWorkflow(first.successorVisitId);
  assert.match(a.reference,/^BIN\d{5,}D$/);
  assert.notEqual(a.reference,b.reference);
  assert.equal(c.reference,a.reference.slice(0,-1)+"C");
  const legacy = await query("SELECT visit_reference FROM mbt_service_visits WHERE service_visit_id=$1",[first.frontVisitId]);
  assert.equal(legacy.rows[0].visit_reference,first.frontReference);
});

test("BIN workflow: configuration creates one execution delivery with confirmed source and preserves billing owner", async () => {
  const f = await fixture("delivery");
  const request = command(f);
  const result = await configureBinOrderWorkflow(request);
  assert.equal(result.body.parts.length,1);
  const part = result.body.parts[0];
  assert.equal(part.role,"delivery");
  assert.equal(part.assetId,f.assetId);
  assert.equal(part.steps[0].location.kind,"yard");
  assert.ok(part.steps[0].location.address && part.steps[0].location.address !== "undefined");
  const child = (await query("SELECT * FROM mbt_service_visits WHERE service_visit_id=$1",[part.visitId])).rows[0];
  assert.equal(child.billing_ownership,"none");
  assert.equal(child.service_snapshot.binWorkflow.orderId,f.frontVisitId);
  assert.equal(child.status,"ready");
  const replay = await configureBinOrderWorkflow(request);
  assert.equal(replay.replayed,true);
  assert.equal(replay.body.parts[0].visitId,part.visitId);
});

test("BIN workflow: stale configuration rolls back without duplicate parts", async () => {
  const f = await fixture("stale");
  const before = (await query("SELECT count(*)::int AS n FROM mbt_service_visits WHERE contract_id=$1",[f.contractId])).rows[0].n;
  await assert.rejects(configureBinOrderWorkflow(command(f,{expectedRevision:99})), /changed|revision/i);
  const afterCount = (await query("SELECT count(*)::int AS n FROM mbt_service_visits WHERE contract_id=$1",[f.contractId])).rows[0].n;
  assert.equal(afterCount,before);
});

async function assignedDelivery(label) {
  const f = await fixture(label,await availableDriverExecutionPlanDate());
  const configured = await configureBinOrderWorkflow(command(f));
  const part = configured.body.parts[0];
  return {...await assignedPart(f,part),configured};
}

async function assignedPart(f, part, loadIndex = 0) {
  const state = (await query("SELECT revision FROM mbt_bin_asset_state WHERE asset_id=$1",[part.assetId])).rows[0];
  const plan = (await query("SELECT revision FROM dispatch_plans WHERE id=$1",[f.planId])).rows[0];
  const assignment = await assignMbtBinFrontLeg({...command(f),planId:f.planId,planDate:f.planDate,
    loadId:f.binLoadIds[loadIndex],visitId:part.visitId,expectedVisitRevision:part.revision,expectedPlanRevision:Number(plan.revision),
    assetAssignments:[{assetId:part.assetId,reservationSlot:"outgoing",expectedStateRevision:Number(state.revision)}]},
    {capability:enabledDriverBinBoundary});
  const truck = (await query("SELECT plate FROM dispatch_trucks WHERE id=$1",[f.binTruckId])).rows[0];
  const jobs = [];
  for (const [index,stop] of assignment.body.stops.entries()) {
    jobs.push(await materializeMbtDriverBinJob({jobId:`wf:${f.planId}:${stop.id}`,planId:f.planId,planDate:f.planDate,
      driverLogin:f.driverLogin,truckId:f.binTruckId,truckPlate:truck.plate,loadId:f.binLoadIds[loadIndex],
      stopId:stop.id,stopType:stop.type === "pickup" ? "pickup" : "dropoff",location:stop.yardCode || "",
      address:stop.yardCode || "",orderRefs:[],orders:[],orderTypes:["BIN"],
      sequence:{truckIndex:0,loadIndex:0,stopIndex:index},mbt:stop.mbt,mbtDispatchStop:stop},
      {clientVersion:"2026.10.20.1",minimumClientVersion:"2026.08.03.1"}));
  }
  return {f,part,jobs,assignment};
}

test("BIN workflow: driver receives the readable action reference, bin number and resolved pickup address", async () => {
  const {f,part,jobs} = await assignedDelivery("driver-presentation");
  assert.equal(jobs[0].mbt.displayReference,part.reference);
  assert.equal(jobs[0].mbt.exactAssets.expected.assetCode,f.assetCode);
  assert.ok(jobs[0].address && jobs[0].address !== "undefined");
  assert.equal(jobs[0].address,part.steps[0].location.address);
  assert.match(jobs[0].mbt.executionSnapshotHash,/^[a-f0-9]{64}$/);
});

async function atCustomer(f) {
  await withTransaction(()=>recordAssetMovement({query,ambientTransaction:true}, {assetId:f.assetId,movementType:"deliver_bin_expected",afterStatus:"at_customer",
    afterLocation:{kind:"customer_site",reference:"100 Test Route",customerSiteProfileId:f.siteProfileId},
    contractId:f.contractId,visitId:f.frontVisitId,source:"workflow-test",actorType:"system",actorId:"test",
    occurredAt:`${f.planDate}T10:00:00Z`}));
  await query("UPDATE mbt_service_visits SET status='completed',actual_completed_at=$2 WHERE service_visit_id=$1",[f.frontVisitId,`${f.planDate}T10:00:00Z`]);
  await query("UPDATE mbt_bin_rental_numbers SET current_asset_id=$2 WHERE service_line_id=$1",[f.serviceLineId,f.assetId]);
}

async function dumping() {
  const dumpSiteId=crypto.randomUUID(),materialId=crypto.randomUUID();
  await query(`INSERT INTO mbt_materials(material_id,material_code,display_name,created_by,updated_by)
    VALUES ($1,$2,'Clean fill','test','test')`,[materialId,`MAT-${materialId}`]);
  await query(`INSERT INTO mbt_dump_sites(dump_site_id,dump_site_code,display_name,address_line_1,city,region,created_by,updated_by)
    VALUES ($1,$2,'Test dump','500 Dump Road','Toronto','ON','test','test')`,[dumpSiteId,`DP-${dumpSiteId}`]);
  await query(`INSERT INTO mbt_dump_site_materials(dump_site_material_id,dump_site_id,material_id,accepted,created_by,updated_by)
    VALUES ($1,$2,$3,true,'test','test')`,[crypto.randomUUID(),dumpSiteId,materialId]);
  return {dumpSiteId,materialId};
}

async function exchangeRoot(f) {
  const id=crypto.randomUUID();
  await query(`INSERT INTO mbt_service_visits(service_visit_id,contract_id,service_line_id,visit_number,visit_reference,
    service_template_version_id,service_action,status,customer_site_profile_id,bin_type_id,expected_asset_id,
    scheduled_start_at,scheduled_end_at,customer_snapshot,site_snapshot,service_snapshot,created_by,updated_by)
    SELECT $1,contract_id,service_line_id,(SELECT max(visit_number)+1 FROM mbt_service_visits WHERE contract_id=$2),$3,
      service_template_version_id,'exchange_bin','ready',customer_site_profile_id,bin_type_id,$4,
      scheduled_start_at,scheduled_end_at,customer_snapshot,site_snapshot,service_snapshot,'test','test'
    FROM mbt_service_visits WHERE service_visit_id=$5`,[id,f.contractId,`legacy-exchange-${id}`,f.assetId,f.frontVisitId]);
  return id;
}

test("BIN workflow: a same-bin exchange can reserve both connected parts without moving the physical bin", async () => {
  const f=await fixture("same-bin-claims",await availableDriverExecutionPlanDate());
  await atCustomer(f);
  const id=await exchangeRoot(f);
  const configured=await configureBinOrderWorkflow(command(f,{visitId:id,sequence:"collection_first",reuse:"same_bin",
    collectionWindow:{startAt:`${f.planDate}T12:00:00Z`,endAt:`${f.planDate}T13:00:00Z`},
    deliveryWindow:{startAt:`${f.planDate}T13:00:00Z`,endAt:`${f.planDate}T14:00:00Z`},...await dumping()}));
  const collection=configured.body.parts.find(p=>p.role==="collection");
  const delivery=configured.body.parts.find(p=>p.role==="delivery");
  assert.match(collection.reference,/X-1C$/);
  assert.match(delivery.reference,/X-1D$/);
  await assignedPart(f,collection);
  const assigned=await assignedPart(f,delivery);
  assert.equal(assigned.jobs.length,1);
  const state=(await query("SELECT lifecycle_status,location_kind FROM mbt_bin_asset_state WHERE asset_id=$1",[f.assetId])).rows[0];
  assert.deepEqual(state,{lifecycle_status:"at_customer",location_kind:"customer_site"});
  const claims=(await query("SELECT count(*)::int AS n FROM mbt_bin_workflow_claims WHERE asset_id=$1 AND released_at IS NULL",[f.assetId])).rows[0];
  assert.equal(claims.n,2);
  const event=driverBinEvent(f,assigned.jobs[0],"job_started",1);
  await assert.rejects(startMbtDriverBinJob({event,job:assigned.jobs[0],manifest:{manifestId:event.manifestId,schemaVersion:2}},
    {capability:enabledDriverBinBoundary}), /prerequisite|completed/i);
});

async function perform(f, job, sequence, extra = {}) {
  const manifestId=crypto.randomUUID(),manifest={manifestId,schemaVersion:2,planId:f.planId,planRevision:10};
  const time=extra.occurredAt ? {occurredAt:extra.occurredAt,receivedAt:extra.occurredAt} : {};
  await startMbtDriverBinJob({job,manifest,event:driverBinEvent(f,job,"job_started",sequence,{}, {manifestId,...time})},
    {capability:enabledDriverBinBoundary});
  const photoReference=`r2://driver-stop-photo/workflow-${crypto.randomUUID()}.jpg`;
  const dumpingAction=job.mbt.actionCode==="dump_bin";
  const event=driverBinEvent(f,job,"job_completed",sequence+1,{mbt:{schemaVersion:"mbt-driver-bin-event-v1",
    actionCode:job.mbt.actionCode,scans:[{evidenceCode:"bin_scan",assetRole:"expected",
      assetId:job.mbt.exactAssets.expected.assetId,scannedValue:job.mbt.exactAssets.expected.assetCode}],
    photoEvidence:[{evidenceCode:dumpingAction ? "dump_receipt_photo" : "bin_photo",ordinal:0}],
    ...(dumpingAction ? {receipt:{dumpSiteId:extra.dumpSiteId,materialId:extra.materialId,ticketNumber:`T-${crypto.randomUUID()}`,
      weight:"1000",quantity:"1",unitOfMeasure:"TON",subtotalMinor:10000,taxMinor:1300,totalMinor:11300,
      currency:"CAD",receiptPhotoOrdinal:0}} : {})}},{manifestId,...time,photos:[{photoId:crypto.randomUUID(),ordinal:0,
        objectReference:photoReference,sha256:"b".repeat(64),mimeType:"image/jpeg",byteSize:1024,durableReceipt:true}]});
  const input={event,job,manifest,photoReferences:[photoReference]};
  if (extra.capture) extra.capture(input);
  return completeMbtDriverBinJob(input,{capability:enabledDriverBinBoundary,hooks:extra.hooks});
}

test("BIN workflow: same-bin pickup, dump and redelivery retain truck custody and one billable exchange", async () => {
  const f=await fixture("same-bin-execution",await availableDriverExecutionPlanDate());
  await atCustomer(f);
  const id=await exchangeRoot(f),dump=await dumping();
  const configured=await configureBinOrderWorkflow(command(f,{visitId:id,sequence:"collection_first",reuse:"same_bin",
    collectionWindow:{startAt:`${f.planDate}T12:00:00Z`,endAt:`${f.planDate}T13:00:00Z`},
    deliveryWindow:{startAt:`${f.planDate}T13:00:00Z`,endAt:`${f.planDate}T14:00:00Z`},...dump}));
  const c=await assignedPart(f,configured.body.parts.find(p=>p.role==="collection"));
  const d=await assignedPart(f,configured.body.parts.find(p=>p.role==="delivery"));
  await perform(f,c.jobs[0],10);
  await perform(f,c.jobs[1],20,dump);
  assert.match(c.jobs[1].mbt.displayReference,/X-1DP$/);
  const empty=(await query("SELECT lifecycle_status,truck_id FROM mbt_bin_asset_state WHERE asset_id=$1",[f.assetId])).rows[0];
  assert.equal(empty.lifecycle_status,"on_truck");
  assert.equal(String(empty.truck_id),f.binTruckId);
  assert.equal((await getBinOrderWorkflow(id)).status,"in_progress");
  await perform(f,d.jobs[0],30);
  const final=await getBinOrderWorkflow(id);
  assert.equal(final.status,"completed");
  assert.equal(final.currentAssetId,f.assetId);
  assert.equal((await query("SELECT count(*)::int AS n FROM mbt_driver_bin_billing_triggers WHERE contract_id=$1 AND service_visit_id<>$2",[f.contractId,id])).rows[0].n,0);
});

test("BIN workflow: final collection dumps and returns to the selected approved yard", async () => {
  const f=await fixture("final-return",await availableDriverExecutionPlanDate());
  await atCustomer(f);
  const dump=await dumping();
  const yard=(await query("SELECT yard_id FROM mbt_yards WHERE active AND yard_id<>$1 LIMIT 1",
    ["00000000-0000-4000-8000-000000012441"])).rows[0];
  assert.ok(yard);
  const configured=await configureBinOrderWorkflow(command(f,{visitId:f.successorVisitId,
    collectionWindow:{startAt:`${f.planDate}T14:00:00Z`,endAt:`${f.planDate}T18:00:00Z`},
    destination:{kind:"yard",yardId:yard.yard_id},...dump}));
  const c=await assignedPart(f,configured.body.parts[0]);
  assert.equal(c.jobs[1].mbt.displayReference,configured.body.reference+"-DP");
  assert.equal(c.jobs[2].mbt.displayReference,configured.body.reference.slice(0,-1)+"-R");
  for (const [i,job] of c.jobs.entries()) {await perform(f,job,40+i*10,dump);}
  const state=(await query("SELECT lifecycle_status,yard_id FROM mbt_bin_asset_state WHERE asset_id=$1",[f.assetId])).rows[0];
  assert.equal(state.lifecycle_status,"available");
  assert.equal(state.yard_id,yard.yard_id);
  assert.equal((await query("SELECT status FROM mbt_contract_service_lines WHERE service_line_id=$1",[f.serviceLineId])).rows[0].status,"closed");
});

test("BIN workflow: final collection feeds the next rental's delivery once with its own BIN number", async () => {
  const f=await fixture("reuse-source",await availableDriverExecutionPlanDate());
  const next=await fixture("reuse-next",await availableDriverExecutionPlanDate());
  await atCustomer(f);
  const dump=await dumping();
  const result=await configureBinOrderWorkflow(command(f,{visitId:f.successorVisitId,
    collectionWindow:{startAt:`${f.planDate}T14:00:00Z`,endAt:`${f.planDate}T16:00:00Z`},
    destination:{kind:"delivery",orderId:next.frontVisitId,deliveryWindow:{
      startAt:`${f.planDate}T16:00:00Z`,endAt:`${f.planDate}T18:00:00Z`}},...dump}));
  const target=await getBinOrderWorkflow(next.frontVisitId);
  assert.notEqual(target.rentalNumber,result.body.rentalNumber);
  assert.match(target.parts[0].reference,/^BIN\d{5,}D$/);
  assert.equal(target.parts[0].assetId,f.assetId);
  assert.deepEqual(target.parts[0].steps.map(s=>s.actionCode),["deliver_bin"]);
  const c=await assignedPart(f,result.body.parts[0]);
  const d=await assignedPart(f,target.parts[0]);
  await perform(f,c.jobs[0],80,dump);
  await perform(f,c.jobs[1],90,dump);
  assert.equal((await getBinOrderWorkflow(f.successorVisitId)).status,"in_progress");
  assert.equal((await query("SELECT count(*)::int AS n FROM mbt_bin_workflow_claims WHERE visit_id=$1 AND released_at IS NULL",
    [c.part.visitId])).rows[0].n,1,"The collection's obligation retains its bin until the shared delivery finishes");
  await perform(f,d.jobs[0],100);
  assert.equal((await getBinOrderWorkflow(f.successorVisitId)).status,"completed");
  assert.equal((await getBinOrderWorkflow(next.frontVisitId)).status,"completed");
  assert.equal((await getBinOrderWorkflow(next.frontVisitId)).currentAssetId,f.assetId);
  assert.equal((await query("SELECT count(*)::int AS n FROM mbt_bin_workflow_claims WHERE asset_id=$1 AND released_at IS NULL",[f.assetId])).rows[0].n,0);
});

test("BIN workflow: multiple open exchanges retain all old bins and final closure waits for recovery", async () => {
  const f=await fixture("multi-exchanges",await availableDriverExecutionPlanDate());
  const b=await fixture("spare-b",await availableDriverExecutionPlanDate());
  const c=await fixture("spare-c",await availableDriverExecutionPlanDate());
  await atCustomer(f);
  const dump=await dumping(),yardId="00000000-0000-4000-8000-000000012441";
  const collections=[];
  let sequence=200;
  for (const [oldBin,newBin] of [[f,b],[b,c]]) {
    const id=await exchangeRoot({...f,assetId:oldBin.assetId});
    const result=await configureBinOrderWorkflow(command(f,{visitId:id,sequence:"delivery_first",reuse:"different_bin",
      collectionAssetId:oldBin.assetId,deliveryAssetId:newBin.assetId,
      collectionWindow:{startAt:`${f.planDate}T16:00:00Z`,endAt:`${f.planDate}T18:00:00Z`},
      destination:{kind:"yard",yardId},...dump}));
    const d=await assignedPart(f,result.body.parts.find(p=>p.role==="delivery"));
    for (const job of d.jobs) {await perform(f,job,sequence+=10);}
    assert.equal((await getBinOrderWorkflow(id)).status,"in_progress");
    await assertFrontdeskBinDelivered(f.serviceLineId);
    collections.push(result.body.parts.find(p=>p.role==="collection"));
  }
  assert.notEqual(collections[0].assetId,collections[1].assetId);
  assert.match(collections[0].reference,/X-1C$/);
  assert.match(collections[1].reference,/X-2C$/);
  const final=await configureBinOrderWorkflow(command(f,{visitId:f.successorVisitId,
    collectionWindow:{startAt:`${f.planDate}T18:00:00Z`,endAt:`${f.planDate}T20:00:00Z`},
    destination:{kind:"yard",yardId},...dump}));
  assert.equal(final.body.parts[0].assetId,c.assetId);
  const finalAssignment=await assignedPart(f,final.body.parts[0]);
  for (const job of finalAssignment.jobs) {await perform(f,job,sequence+=10,dump);}
  assert.equal((await getBinOrderWorkflow(f.successorVisitId)).recoveryPending,true);
  assert.notEqual((await query("SELECT status FROM mbt_contract_service_lines WHERE service_line_id=$1",[f.serviceLineId])).rows[0].status,"closed");
  for (const part of collections) {
    const a=await assignedPart(f,part);
    for (const job of a.jobs) {await perform(f,job,sequence+=10,dump);}
  }
  const done=await getBinOrderWorkflow(f.successorVisitId);
  assert.equal(done.status,"completed");
  assert.equal(done.recoveryPending,false);
  assert.equal(done.currentAssetId,null);
});

test("BIN workflow: drafts can be edited, Toronto windows are explicit, and issued instructions stay frozen", async () => {
  const f=await fixture("draft-edit",await availableDriverExecutionPlanDate());
  const first=await configureBinOrderWorkflow(command(f));
  const date=f.planDate;
  const changed=await configureBinOrderWorkflow(command(f,{expectedRevision:first.body.revision,
    deliveryWindow:{startLocal:`${date}T09:00`,endLocal:`${date}T11:00`}}));
  assert.equal(changed.body.parts[0].visitId,first.body.parts[0].visitId);
  const local=new Intl.DateTimeFormat("en-GB",{timeZone:"America/Toronto",hour:"2-digit",minute:"2-digit"})
    .format(new Date(changed.body.parts[0].window.startAt));
  assert.equal(local,"09:00");
  await assignedPart(f,changed.body.parts[0]);
  await assert.rejects(configureBinOrderWorkflow(command(f,{expectedRevision:changed.body.revision})),/unassigned|unplan|issued/i);
});

test("BIN workflow: planning pool exposes required configuration and both independently assignable parts", async () => {
  const f=await fixture("pool",await availableDriverExecutionPlanDate());
  const before=await getMbtBinPlanning({planDate:f.planDate,search:f.contractNumber},{capability:enabledDriverBinBoundary});
  assert.equal(before.pool.items.length,2);
  assert.ok(before.pool.items.every(item=>item.workflow.configurationRequired && !item.mbt.frontLeg.dispatchable));
  await assert.rejects(assignMbtBinFrontLeg({...command(f),planId:f.planId,planDate:f.planDate,
    loadId:f.binLoadIds[0],visitId:f.frontVisitId,expectedVisitRevision:1,expectedPlanRevision:1,
    assetAssignments:[{assetId:f.assetId,reservationSlot:"outgoing",expectedStateRevision:1}]},
    {capability:enabledDriverBinBoundary,planning:true}),/Configure this BIN order/i);
  const d=await configureBinOrderWorkflow(command(f));
  const dump=await dumping();
  const c=await configureBinOrderWorkflow(command(f,{visitId:f.successorVisitId,
    collectionWindow:{startAt:`${f.planDate}T18:00:00Z`,endAt:`${f.planDate}T20:00:00Z`},
    destination:{kind:"yard",yardId:"00000000-0000-4000-8000-000000012441"},...dump}));
  const after=await getMbtBinPlanning({planDate:f.planDate,search:f.contractNumber},{capability:enabledDriverBinBoundary});
  assert.equal(after.pool.items.length,2);
  assert.ok(after.pool.items.every(item=>item.mbt.frontLeg.dispatchable));
  assert.equal(c.body.parts[0].assetId,d.body.parts[0].assetId);
  assert.equal((await query("SELECT prerequisite_visit_id FROM mbt_bin_workflow_dependencies WHERE dependent_visit_id=$1",[c.body.parts[0].visitId])).rows[0].prerequisite_visit_id,d.body.parts[0].visitId);
});

test("BIN workflow: simultaneous configuration commits once and unrelated rental reservations lose the race", async () => {
  const f=await fixture("configure-race",await availableDriverExecutionPlanDate());
  const results=await Promise.allSettled([configureBinOrderWorkflow(command(f)),configureBinOrderWorkflow(command(f))]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  const part=results.find(r=>r.status==="fulfilled").value.body.parts[0];
  const next=await fixture("unrelated-race",await availableDriverExecutionPlanDate());
  const configured=await configureBinOrderWorkflow(command(next,{deliveryAssetId:f.assetId}));
  await assignedPart(f,part);
  await assert.rejects(assignedPart(next,configured.body.parts[0]),/unrelated|reserved/i);
  const count=(await query("SELECT count(*)::int AS n FROM mbt_bin_workflow_claims WHERE asset_id=$1 AND released_at IS NULL",[f.assetId])).rows[0];
  assert.equal(count.n,1);
});

test("BIN workflow: the real planner confirms a same-bin route with one slot and rejects reversed dependencies", async () => {
  const f=await attachRental(await planningFixture(4500));
  await atCustomer(f);
  const id=await exchangeRoot(f),dump=await dumping();
  const configured=await configureBinOrderWorkflow(command(f,{visitId:id,sequence:"collection_first",reuse:"same_bin",
    collectionWindow:{startAt:`${f.planDate}T12:00:00Z`,endAt:`${f.planDate}T13:00:00Z`},
    deliveryWindow:{startAt:`${f.planDate}T13:00:00Z`,endAt:`${f.planDate}T14:00:00Z`},...dump}));
  const c=configured.body.parts.find(p=>p.role==="collection"),d=configured.body.parts.find(p=>p.role==="delivery");
  await runPlanning(f,"assign",{visitId:c.visitId,expectedVisitRevision:c.revision,assetAssignments:[]});
  await runPlanning(f,"assign",{visitId:d.visitId,expectedVisitRevision:d.revision,assetAssignments:[]});
  const before=await storedPlan(f.planId);
  const revision=Number((await query("SELECT revision FROM mbt_service_visits WHERE service_visit_id=$1",[d.visitId])).rows[0].revision);
  await assert.rejects(runPlanning(f,"sequence",{visitId:d.visitId,expectedVisitRevision:revision,direction:-1}),/aboard|follow|route/i);
  assert.equal((await storedPlan(f.planId)).revision,before.revision);
  await runPlanning(f,"confirm");
  const released=(await query(`SELECT count(*)::int AS n FROM mbt_bin_planning_assignments
    WHERE service_visit_id=ANY($1::uuid[]) AND withdrawn_at IS NULL AND released_at IS NOT NULL`,[[c.visitId,d.visitId]])).rows[0];
  assert.equal(released.n,2);
});

test("BIN workflow: custody changes only through a confirmed, idempotent physical handoff",async()=>{
  const {f,part,jobs}=await assignedDelivery("handoff-source");
  const other=await fixture("handoff-truck",await availableDriverExecutionPlanDate());
  await perform(f,jobs[0],2);
  const asset=(await query("SELECT revision FROM mbt_bin_asset_state WHERE asset_id=$1",[f.assetId])).rows[0];
  const request={...command(f),visitId:part.visitId,assetId:f.assetId,fromTruckId:f.binTruckId,toTruckId:other.binTruckId,
    expectedStateRevision:Number(asset.revision),scannedBinCode:f.assetCode,place:"Test transfer yard",
    reason:"Truck replacement after actual handoff",confirmed:true};
  await assert.rejects(recordBinWorkflowHandoff({...request,confirmed:false}),/Confirm/i);
  await assert.rejects(recordBinWorkflowHandoff({...request,actor:{operatorId:"driver",roles:["driver"]}}),/access/i);
  await assert.rejects(recordBinWorkflowHandoff({...request,scannedBinCode:"WRONG-BIN"}),/exact physical bin/i);
  await assert.rejects(recordBinWorkflowHandoff({...request,fromTruckId:other.binTruckId}),/custody changed/i);
  await assert.rejects(recordBinWorkflowHandoff({...request,toTruckId:other.flatbedTruckId}),/compatible/i);
  const first=await recordBinWorkflowHandoff(request),replay=await recordBinWorkflowHandoff(request);
  assert.equal(replay.replayed,true);
  assert.deepEqual(replay.body,first.body);
  assert.equal(String((await query("SELECT truck_id FROM mbt_bin_asset_state WHERE asset_id=$1",[f.assetId])).rows[0].truck_id),other.binTruckId);
  await assert.rejects(perform(f,jobs[1],10),/location/i);
});

test("BIN workflow: a draft final collection follows a newly planned replacement while the exchange retains the old bin",async()=>{
  const f=await fixture("retarget-final",await availableDriverExecutionPlanDate());
  const spare=await fixture("retarget-spare",await availableDriverExecutionPlanDate());
  await atCustomer(f);
  const dump=await dumping(),destination={kind:"yard",yardId:"00000000-0000-4000-8000-000000012441"};
  const final=await configureBinOrderWorkflow(command(f,{visitId:f.successorVisitId,destination,...dump,
    collectionWindow:{startAt:`${f.planDate}T18:00:00Z`,endAt:`${f.planDate}T20:00:00Z`}}));
  const id=await exchangeRoot(f);
  const exchange=await configureBinOrderWorkflow(command(f,{visitId:id,sequence:"delivery_first",reuse:"different_bin",
    deliveryAssetId:spare.assetId,destination,...dump,
    collectionWindow:{startAt:`${f.planDate}T16:00:00Z`,endAt:`${f.planDate}T18:00:00Z`}}));
  assert.equal(exchange.body.parts.find(p=>p.role==="collection").assetId,f.assetId);
  const updated=await getBinOrderWorkflow(f.successorVisitId);
  assert.equal(updated.parts[0].visitId,final.body.parts[0].visitId);
  assert.equal(updated.parts[0].assetId,spare.assetId);
  assert.equal((await query("SELECT prerequisite_visit_id FROM mbt_bin_workflow_dependencies WHERE dependent_visit_id=$1",
    [updated.parts[0].visitId])).rows[0].prerequisite_visit_id,exchange.body.parts.find(p=>p.role==="delivery").visitId);
});

test("BIN workflow: completed driver delivery updates the parent and current bin exactly once", async () => {
  const {f,part,jobs} = await assignedDelivery("driver-lifecycle");
  const manifestId = crypto.randomUUID();
  const manifest = {manifestId,schemaVersion:2,planId:f.planId,planRevision:2};
  let sequence = 0;
  for (const job of jobs) {
    const start = driverBinEvent(f,job,"job_started",++sequence,{}, {manifestId});
    await startMbtDriverBinJob({event:start,job,manifest},{capability:enabledDriverBinBoundary});
    const photoReference = `r2://driver-stop-photo/bin-workflow-${crypto.randomUUID()}.jpg`;
    const event = driverBinEvent(f,job,"job_completed",++sequence,{mbt:{schemaVersion:"mbt-driver-bin-event-v1",
      actionCode:job.mbt.actionCode,scans:[{evidenceCode:"bin_scan",assetRole:"expected",assetId:f.assetId,scannedValue:f.assetCode}],
      photoEvidence:[{evidenceCode:"bin_photo",ordinal:0}]}},{manifestId,photos:[{photoId:crypto.randomUUID(),
        ordinal:0,objectReference:photoReference,sha256:"a".repeat(64),mimeType:"image/jpeg",byteSize:1024,durableReceipt:true}]});
    const completed = await completeMbtDriverBinJob({event,job,manifest,photoReferences:[photoReference]},{capability:enabledDriverBinBoundary});
    const replay = await completeMbtDriverBinJob({event,job,manifest,photoReferences:[photoReference]},{capability:enabledDriverBinBoundary});
    assert.deepEqual(replay.body,completed.body);
    assert.equal(replay.replayed,true);
  }
  const parent = await getBinOrderWorkflow(f.frontVisitId);
  assert.equal(parent.status,"completed");
  assert.equal(parent.currentAssetId,f.assetId);
  const triggers = (await query("SELECT service_visit_id FROM mbt_driver_bin_billing_triggers WHERE contract_id=$1",[f.contractId])).rows;
  assert.ok(triggers.length);
  assert.ok(triggers.every(row=>row.service_visit_id === f.frontVisitId));
  assert.notEqual(part.visitId,f.frontVisitId);
});

test("BIN workflow: different-bin collection-first allows replacement before the old bin is dumped",async()=>{
  const f=await fixture("different-first",await availableDriverExecutionPlanDate());
  const spare=await fixture("different-spare",await availableDriverExecutionPlanDate());
  await atCustomer(f);
  // Put the second driver's truck on the same plan; each driver gets a separate load.
  const otherPlan=await storedPlan(spare.planId);
  await query("UPDATE dispatch_plan_snapshots SET trucks=trucks || $2::jsonb WHERE plan_id=$1",
    [f.planId,JSON.stringify([otherPlan.trucks[0]])]);
  const second={...spare,planId:f.planId,planDate:f.planDate};
  const id=await exchangeRoot(f),dump=await dumping();
  const configured=await configureBinOrderWorkflow(command(f,{visitId:id,sequence:"collection_first",reuse:"different_bin",
    deliveryAssetId:spare.assetId,...dump,destination:{kind:"yard",yardId:"00000000-0000-4000-8000-000000012441"},
    collectionWindow:{startAt:`${f.planDate}T12:00:00Z`,endAt:`${f.planDate}T14:00:00Z`}}));
  const c=await assignedPart(f,configured.body.parts.find(p=>p.role==="collection"));
  const d=await assignedPart(second,configured.body.parts.find(p=>p.role==="delivery"));
  await perform(second,d.jobs[0],200);
  await assert.rejects(perform(second,d.jobs[1],210),/prerequisite|completed/i);
  await perform(f,c.jobs[0],220);
  await perform(second,d.jobs[1],230);
  const state=await getBinOrderWorkflow(id);
  assert.equal(state.currentAssetId,spare.assetId);
  assert.equal(state.status,"in_progress");
  assert.equal((await query("SELECT status FROM mbt_visit_steps WHERE service_visit_id=$1 AND action_code='dump_bin'",
    [c.part.visitId])).rows[0].status,"pending");
  for (const job of c.jobs.slice(1)) await perform(f,job,240,dump);
  assert.equal((await getBinOrderWorkflow(id)).status,"completed");
});

test("BIN workflow: a late actual replacement is accepted and creates a durable same-day exception",async()=>{
  const f=await fixture("late-actual",await availableDriverExecutionPlanDate());
  await atCustomer(f);
  const id=await exchangeRoot(f),dump=await dumping();
  const result=await configureBinOrderWorkflow(command(f,{visitId:id,sequence:"collection_first",reuse:"same_bin",...dump,
    collectionWindow:{startAt:`${f.planDate}T12:00:00Z`,endAt:`${f.planDate}T14:00:00Z`}}));
  const c=await assignedPart(f,result.body.parts.find(p=>p.role==="collection"));
  const d=await assignedPart(f,result.body.parts.find(p=>p.role==="delivery"));
  await perform(f,c.jobs[0],250,{occurredAt:`${f.planDate}T12:00:00Z`});
  await perform(f,c.jobs[1],260,{...dump,occurredAt:`${f.planDate}T14:00:00Z`});
  const tomorrow=new Date(`${f.planDate}T16:00:00Z`);tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
  await perform(f,d.jobs[0],270,{occurredAt:tomorrow.toISOString()});
  const done=await getBinOrderWorkflow(id);
  assert.equal(done.status,"completed");
  assert.equal(done.events.filter(e=>e.action==="late_same_day_completion").length,1);
  assert.equal(done.events.find(e=>e.action==="late_same_day_completion").details.late.length,1);
});

test("BIN workflow: failure after parent completion rolls back custody, claims and workflow evidence before a safe retry",async()=>{
  const {f,part,jobs}=await assignedDelivery("atomic-completion");
  await perform(f,jobs[0],300);
  const before=(await query("SELECT * FROM mbt_bin_asset_state WHERE asset_id=$1",[f.assetId])).rows[0];
  const countBefore=(await getBinOrderWorkflow(f.frontVisitId)).events.length;
  let input;
  await assert.rejects(perform(f,jobs[1],310,{capture:value=>{input=value;},
    hooks:{afterBillingTrigger:()=>{throw new Error("synthetic failure after workflow completion");}}}),/synthetic failure/);
  assert.deepEqual((await query("SELECT * FROM mbt_bin_asset_state WHERE asset_id=$1",[f.assetId])).rows[0],before);
  const after=await getBinOrderWorkflow(f.frontVisitId);
  assert.notEqual(after.status,"completed");
  assert.equal(after.currentAssetId,null);
  assert.equal(after.events.length,countBefore);
  assert.equal((await query("SELECT count(*)::int AS n FROM mbt_bin_workflow_claims WHERE visit_id=$1 AND released_at IS NULL",[part.visitId])).rows[0].n,1);
  await completeMbtDriverBinJob(input,{capability:enabledDriverBinBoundary});
  assert.equal((await getBinOrderWorkflow(f.frontVisitId)).currentAssetId,f.assetId);
  const replay=await completeMbtDriverBinJob(input,{capability:enabledDriverBinBoundary});
  assert.equal(replay.replayed,true);
});

test("BIN workflow: parent extensions update draft final collection but cannot rewrite assigned work",async()=>{
  const f=await fixture("extension",await availableDriverExecutionPlanDate());
  await atCustomer(f);
  const configured=await configureBinOrderWorkflow(command(f,{visitId:f.successorVisitId,...await dumping(),
    collectionWindow:{startAt:`${f.planDate}T14:00:00Z`,endAt:`${f.planDate}T16:00:00Z`},
    destination:{kind:"yard",yardId:"00000000-0000-4000-8000-000000012441"}}));
  await query("UPDATE mbt_service_visits SET scheduled_start_at=$2,scheduled_end_at=$3 WHERE service_visit_id=$1",
    [f.successorVisitId,`${f.planDate}T16:00:00Z`,`${f.planDate}T18:00:00Z`]);
  const changed=await getBinOrderWorkflow(f.successorVisitId);
  assert.equal(changed.parts[0].window.startAt,`${f.planDate}T16:00:00.000Z`);
  assert.ok(changed.revision>configured.body.revision);
  assert.equal(new Date(changed.configuration.parts[0].window.startAt).toISOString(),changed.parts[0].window.startAt);
  await assignedPart(f,changed.parts[0]);
  const line=(await query("SELECT revision::int FROM mbt_contract_service_lines WHERE service_line_id=$1",[f.serviceLineId])).rows[0];
  await assert.rejects(extendFrontdeskServiceLine({...command(f),actor:{operatorId:"frontdesk-test",roles:["mbt_frontdesk"]},
    contractId:f.contractId,serviceLineId:f.serviceLineId,expectedRevision:line.revision,
    returnWindow:{startAt:`${f.planDate}T18:00:00Z`,endAt:`${f.planDate}T20:00:00Z`}}),/assigned or issued/i);
  await assert.rejects(query("UPDATE mbt_service_visits SET scheduled_end_at=$2 WHERE service_visit_id=$1",
    [f.successorVisitId,`${f.planDate}T20:00:00Z`]),/cannot be rescheduled/i);
  assert.equal((await getBinOrderWorkflow(f.successorVisitId)).parts[0].window.endAt,`${f.planDate}T18:00:00.000Z`);
  await query("UPDATE mbt_service_visits SET actual_started_at=$2 WHERE service_visit_id=$1",
    [f.successorVisitId,`${f.planDate}T16:00:00Z`]);
  await assert.rejects(extendFrontdeskServiceLine({...command(f),actor:{operatorId:"frontdesk-test",roles:["mbt_frontdesk"]},
    contractId:f.contractId,serviceLineId:f.serviceLineId,expectedRevision:line.revision,
    returnWindow:{startAt:`${f.planDate}T18:00:00Z`,endAt:`${f.planDate}T20:00:00Z`}}),/collection visit that has started/i);
  assert.equal((await getBinOrderWorkflow(f.successorVisitId)).parts[0].window.endAt,`${f.planDate}T18:00:00.000Z`);
});

test("BIN workflow: invalid role, time, dump acceptance and immutable references fail without partial orders",async()=>{
  const f=await fixture("hostile",await availableDriverExecutionPlanDate());
  await assert.rejects(configureBinOrderWorkflow(command(f,{actor:{operatorId:"driver",roles:["driver"]}})),/access/i);
  await assert.rejects(configureBinOrderWorkflow(command(f,{deliveryWindow:{startLocal:"bad",endLocal:"bad"}})),/Toronto/i);
  await assert.rejects(configureBinOrderWorkflow(command(f,{deliveryWindow:{startAt:`${f.planDate}T14:00:00Z`,endAt:`${f.planDate}T12:00:00Z`}})),/later finish/i);
  await assert.rejects(query("UPDATE mbt_bin_rental_numbers SET rental_number=DEFAULT WHERE service_line_id=$1",[f.serviceLineId]),/immutable/i);
  await assert.rejects(query("UPDATE mbt_bin_orders SET display_reference='BIN99999D' WHERE order_id=$1",[f.frontVisitId]),/immutable/i);
  assert.equal((await getBinOrderWorkflow(f.frontVisitId)).parts.length,0);
  await atCustomer(f);
  const dump=await dumping(),options=await getBinOrderWorkflowOptions(f.successorVisitId);
  assert.equal(options.collectionAssetId,f.assetId);
  const c=command(f,{visitId:f.successorVisitId,...dump,
    collectionWindow:{startAt:`${f.planDate}T14:00:00Z`,endAt:`${f.planDate}T16:00:00Z`},
    destination:{kind:"yard",yardId:"00000000-0000-4000-8000-000000012441"}});
  await query("UPDATE mbt_dump_site_materials SET accepted=false WHERE dump_site_id=$1",[dump.dumpSiteId]);
  await assert.rejects(configureBinOrderWorkflow(c),/does not accept/i);
  assert.equal((await getBinOrderWorkflow(f.successorVisitId)).parts.length,0);
  await query("UPDATE mbt_dump_site_materials SET accepted=true WHERE dump_site_id=$1",[dump.dumpSiteId]);
  const configured=await configureBinOrderWorkflow({...c,idempotencyKey:crypto.randomUUID()});
  const assigned=await assignedPart(f,configured.body.parts[0]);
  await perform(f,assigned.jobs[0],400);
  await query("UPDATE mbt_dump_site_materials SET accepted=false WHERE dump_site_id=$1",[dump.dumpSiteId]);
  await assert.rejects(perform(f,assigned.jobs[1],410,dump),/accept|material|dump/i);
  assert.equal((await query("SELECT count(*)::int AS n FROM mbt_dump_receipts WHERE service_visit_id=$1",[assigned.part.visitId])).rows[0].n,0);
});

test("BIN workflow: an empty bin aboard the truck skips pickup, and a legacy dumped bin uses its actual dump address",async()=>{
  const f=await fixture("aboard",await availableDriverExecutionPlanDate());
  await withTransaction(()=>recordAssetMovement({query,ambientTransaction:true},{assetId:f.assetId,movementType:"collect_empty_bin_outgoing",
    afterStatus:"on_truck",afterLocation:{kind:"truck",truckId:f.binTruckId,reference:"Loaded empty bin"},
    truckId:f.binTruckId,source:"workflow-test",actorType:"system",actorId:"test",occurredAt:`${f.planDate}T10:00:00Z`}));
  const onboard=await configureBinOrderWorkflow(command(f));
  assert.equal(onboard.body.parts[0].steps.length,1);
  assert.equal(onboard.body.configuration.parts[0].source.id,f.binTruckId);
  const pool=await getMbtBinPlanning({planDate:f.planDate,search:f.contractNumber},{capability:enabledDriverBinBoundary});
  assert.equal(pool.pool.items.find(item=>item.mbt.visitId===onboard.body.parts[0].visitId).workflow.source.id,f.binTruckId);
  const assigned=await assignedPart(f,onboard.body.parts[0]);
  await perform(f,assigned.jobs[0],450);
  assert.equal((await getBinOrderWorkflow(f.frontVisitId)).status,"completed");
  const legacy=await fixture("at-dump",await availableDriverExecutionPlanDate()),dump=await dumping();
  await withTransaction(()=>recordAssetMovement({query,ambientTransaction:true},{assetId:legacy.assetId,movementType:"dump_bin_expected",
    afterStatus:"at_dump",afterLocation:{kind:"dump_site",dumpSiteId:dump.dumpSiteId,reference:"500 Dump Road"},
    source:"workflow-test",actorType:"system",actorId:"test",occurredAt:`${legacy.planDate}T10:00:00Z`}));
  const configured=await configureBinOrderWorkflow(command(legacy));
  assert.equal(configured.body.parts[0].steps[0].location.kind,"dump_site");
  assert.match(configured.body.parts[0].steps[0].location.address,/500 Dump Road/);
  const route=await assignedPart(legacy,configured.body.parts[0]);
  for (const job of route.jobs) await perform(legacy,job,460);
  assert.equal((await getBinOrderWorkflow(legacy.frontVisitId)).status,"completed");
});

test("BIN workflow: tomorrow's collection can be planned ahead but waits for the delivery plan to be released",async()=>{
  const first=await attachRental(await planningFixture(4504));
  const second=await attachRental(await planningFixture(4505));
  const delivery=await configureBinOrderWorkflow(command(first));
  const collection=await configureBinOrderWorkflow(command(first,{visitId:first.successorVisitId,...await dumping(),
    collectionWindow:{startAt:`${second.planDate}T12:00:00Z`,endAt:`${second.planDate}T14:00:00Z`},
    destination:{kind:"yard",yardId:"00000000-0000-4000-8000-000000012441"}}));
  const d=delivery.body.parts[0],c=collection.body.parts[0];
  await runPlanning(first,"assign",{visitId:d.visitId,expectedVisitRevision:d.revision,assetAssignments:[]});
  await runPlanning(second,"assign",{visitId:c.visitId,expectedVisitRevision:c.revision,assetAssignments:[]});
  await assert.rejects(runPlanning(second,"confirm"),/Release the prerequisite/i);
  await runPlanning(first,"confirm");
  await runPlanning(second,"confirm");
  assert.equal((await query("SELECT count(*)::int AS n FROM mbt_bin_planning_assignments WHERE service_visit_id=$1 AND released_at IS NOT NULL",[c.visitId])).rows[0].n,1);
});

test("BIN workflow: a dumped bin remains aboard the same truck for the next customer's delivery tomorrow",async()=>{
  const first=await attachRental(await planningFixture(4510));
  const next=await attachRental(await planningFixture(4511));
  await atCustomer(first);
  const truck=(await storedPlan(first.planId)).trucks[0];
  await query("UPDATE dispatch_plan_snapshots SET trucks=trucks || $2::jsonb WHERE plan_id=$1",
    [next.planId,JSON.stringify([truck])]);
  const configured=await configureBinOrderWorkflow(command(first,{visitId:first.successorVisitId,...await dumping(),
    collectionWindow:{startAt:`${first.planDate}T12:00:00Z`,endAt:`${first.planDate}T14:00:00Z`},
    destination:{kind:"delivery",orderId:next.frontVisitId}}));
  const c=configured.body.parts[0],d=(await getBinOrderWorkflow(next.frontVisitId)).parts[0];
  await runPlanning(first,"assign",{visitId:c.visitId,expectedVisitRevision:c.revision,assetAssignments:[]});
  await runPlanning(next,"assign",{loadId:first.binLoadIds[0],visitId:d.visitId,expectedVisitRevision:d.revision,assetAssignments:[]});
  await runPlanning(first,"confirm");
  await runPlanning(next,"confirm");
  const onward=(await storedPlan(next.planId)).trucks.find(t=>String(t.id)===first.binTruckId).loads[0].stops;
  assert.deepEqual(onward.map(s=>s.actionCode),["deliver_bin"]);
  assert.equal(onward[0].reference,d.reference);
  assert.notEqual(d.reference,configured.body.reference);
});

test("BIN workflow: stale locations, loaded delivery bins, and revoked reservations cannot be released",async()=>{
  const f=await attachRental(await planningFixture(4513));
  const configured=await configureBinOrderWorkflow(command(f)),part=configured.body.parts[0];
  await withTransaction(()=>recordAssetMovement({query,ambientTransaction:true},{assetId:f.assetId,movementType:"pickup_bin_expected",
    afterStatus:"on_truck",afterLocation:{kind:"truck",truckId:f.binTruckId,reference:"Loaded bin"},
    truckId:f.binTruckId,source:"workflow-test",actorType:"system",actorId:"test",occurredAt:`${f.planDate}T10:00:00Z`}));
  await assert.rejects(runPlanning(f,"assign",{visitId:part.visitId,expectedVisitRevision:part.revision,assetAssignments:[]}),/no confirmed empty/i);
  const other=await fixture("stale-other",await availableDriverExecutionPlanDate());
  await withTransaction(()=>recordAssetMovement({query,ambientTransaction:true},{assetId:f.assetId,movementType:"bin_handoff_empty",
    afterStatus:"on_truck",afterLocation:{kind:"truck",truckId:other.binTruckId,reference:"Other truck"},
    truckId:other.binTruckId,source:"workflow-test",actorType:"system",actorId:"test",occurredAt:`${f.planDate}T11:00:00Z`}));
  await assert.rejects(runPlanning(f,"assign",{visitId:part.visitId,expectedVisitRevision:part.revision,assetAssignments:[]}),/another truck/i);
  const yard=(await query("SELECT yard_id FROM mbt_yards WHERE active AND yard_id<>$1 LIMIT 1",
    ["00000000-0000-4000-8000-000000012441"])).rows[0];
  await withTransaction(()=>recordAssetMovement({query,ambientTransaction:true},{assetId:f.assetId,movementType:"return_bin_expected",
    afterStatus:"available",afterLocation:{kind:"yard",yardId:yard.yard_id,reference:"Other yard"},
    source:"workflow-test",actorType:"system",actorId:"test",occurredAt:`${f.planDate}T12:00:00Z`}));
  await assert.rejects(runPlanning(f,"assign",{visitId:part.visitId,expectedVisitRevision:part.revision,assetAssignments:[]}),/moved since/i);
  assert.equal((await storedPlan(f.planId)).trucks[0].loads[0].stops.length,0);
  const fixed=await configureBinOrderWorkflow(command(f,{expectedRevision:configured.body.revision}));
  await runPlanning(f,"assign",{visitId:part.visitId,expectedVisitRevision:fixed.body.parts[0].revision,assetAssignments:[]});
  await query("UPDATE mbt_bin_workflow_claims SET released_at=now() WHERE visit_id=$1",[part.visitId]);
  await assert.rejects(runPlanning(f,"confirm"),/reservation changed/i);
});

test("BIN workflow: invalid collection identities and targets do not rewrite an existing rental",async()=>{
  const f=await fixture("invalid-collection",await availableDriverExecutionPlanDate());
  const other=await fixture("invalid-target",await availableDriverExecutionPlanDate());
  const dump=await dumping();
  const request=command(f,{visitId:f.successorVisitId,...dump,
    collectionWindow:{startAt:`${f.planDate}T14:00:00Z`,endAt:`${f.planDate}T16:00:00Z`},
    destination:{kind:"yard",yardId:"00000000-0000-4000-8000-000000012441"}});
  await assert.rejects(configureBinOrderWorkflow({...request,collectionAssetId:other.assetId}),/current physical/i);
  await assert.rejects(configureBinOrderWorkflow({...request,collectionAssetId:f.assetId}),/customer's site/i);
  await atCustomer(f);
  await assert.rejects(configureBinOrderWorkflow(command(f)),/existing instructions/i);
  await assert.rejects(configureBinOrderWorkflow({...request,collectionAssetId:other.assetId}),/current physical/i);
  await assert.rejects(configureBinOrderWorkflow({...request,destination:{kind:"delivery",orderId:f.successorVisitId}}),/different receiving/i);
  const unconfiguredExchange=await exchangeRoot(other);
  await assert.rejects(configureBinOrderWorkflow({...request,destination:{kind:"delivery",orderId:unconfiguredExchange}}),/Configure the receiving/i);
  assert.equal((await getBinOrderWorkflow(f.successorVisitId)).parts.length,0);
});

test("BIN workflow: a legacy delivery finishing after upgrade records the current bin without rewriting its frozen instructions",async()=>{
  const f=await fixture("legacy-transition",await availableDriverExecutionPlanDate());
  const visit=(await query("SELECT * FROM mbt_service_visits WHERE service_visit_id=$1",[f.frontVisitId])).rows[0];
  const before=JSON.stringify(visit.service_snapshot);
  await withTransaction(async()=>{
    await recordAssetMovement({query,ambientTransaction:true},{assetId:f.assetId,movementType:"deliver_bin_outgoing",
      afterStatus:"at_customer",afterLocation:{kind:"customer_site",reference:"100 Test Route",customerSiteProfileId:f.siteProfileId},
      contractId:f.contractId,visitId:f.frontVisitId,source:"driver_bin_execution",actorType:"driver",actorId:f.driverLogin,
      occurredAt:`${f.planDate}T12:00:00Z`});
    await finishBinWorkflowStep({rows:{visit},step:{action_code:"deliver_bin"},
      normalized:{occurredAt:new Date(`${f.planDate}T12:00:00Z`),driverLogin:f.driverLogin,eventId:crypto.randomUUID()}},true);
  });
  assert.equal((await getBinOrderWorkflow(f.frontVisitId)).currentAssetId,f.assetId);
  assert.equal(JSON.stringify((await query("SELECT service_snapshot FROM mbt_service_visits WHERE service_visit_id=$1",[f.frontVisitId])).rows[0].service_snapshot),before);
});

test("BIN workflow: linking a different source cannot silently retarget an assigned final collection",async()=>{
  const source=await fixture("frozen-destination-source",await availableDriverExecutionPlanDate());
  const target=await fixture("frozen-destination",await availableDriverExecutionPlanDate());
  await atCustomer(source);
  const dump=await dumping(),destination={kind:"yard",yardId:"00000000-0000-4000-8000-000000012441"};
  const delivery=await configureBinOrderWorkflow(command(target));
  const final=await configureBinOrderWorkflow(command(target,{visitId:target.successorVisitId,...dump,destination,
    collectionWindow:{startAt:`${target.planDate}T16:00:00Z`,endAt:`${target.planDate}T18:00:00Z`}}));
  await assignedPart(target,final.body.parts[0]);
  await assert.rejects(configureBinOrderWorkflow(command(source,{visitId:source.successorVisitId,...dump,
    collectionWindow:{startAt:`${source.planDate}T14:00:00Z`,endAt:`${source.planDate}T16:00:00Z`},
    destination:{kind:"delivery",orderId:target.frontVisitId}})),/final collection already has issued or assigned/i);
  assert.equal((await getBinOrderWorkflow(source.successorVisitId)).parts.length,0);
  assert.equal((await getBinOrderWorkflow(target.frontVisitId)).parts[0].assetId,delivery.body.parts[0].assetId);
});

test("BIN workflow: a new exchange cannot redirect the bin promised to an assigned onward delivery",async()=>{
  const f=await fixture("frozen-onward",await availableDriverExecutionPlanDate());
  const next=await fixture("frozen-onward-target",await availableDriverExecutionPlanDate());
  const spare=await fixture("frozen-onward-spare",await availableDriverExecutionPlanDate());
  await atCustomer(f);
  const dump=await dumping();
  const final=await configureBinOrderWorkflow(command(f,{visitId:f.successorVisitId,...dump,
    collectionWindow:{startAt:`${f.planDate}T16:00:00Z`,endAt:`${f.planDate}T18:00:00Z`},
    destination:{kind:"delivery",orderId:next.frontVisitId,deliveryWindow:{startAt:`${f.planDate}T18:00:00Z`,endAt:`${f.planDate}T20:00:00Z`}}}));
  await assignedPart(f,(await getBinOrderWorkflow(next.frontVisitId)).parts[0]);
  const id=await exchangeRoot(f);
  await assert.rejects(configureBinOrderWorkflow(command(f,{visitId:id,sequence:"delivery_first",reuse:"different_bin",
    deliveryAssetId:spare.assetId,...dump,destination:{kind:"yard",yardId:"00000000-0000-4000-8000-000000012441"},
    collectionWindow:{startAt:`${f.planDate}T14:00:00Z`,endAt:`${f.planDate}T16:00:00Z`}})),/onward delivery is already assigned/i);
  assert.equal((await getBinOrderWorkflow(id)).parts.length,0);
  assert.equal((await getBinOrderWorkflow(f.successorVisitId)).parts[0].assetId,final.body.parts[0].assetId);
});

test("BIN workflow: linked plan validation rejects reverse timing, forecast truck transfers and missed local-day promises",async()=>{
  const f=await attachRental(await planningFixture(4520,{planDate:await availableDriverExecutionPlanDate()}));
  const other=await attachRental(await planningFixture(4521,{planDate:await availableDriverExecutionPlanDate()}));
  const yesterday=new Date(`${f.planDate}T12:00:00Z`);yesterday.setUTCDate(yesterday.getUTCDate()-1);
  await atCustomer({...f,planDate:yesterday.toISOString().slice(0,10)});
  const truck=(await storedPlan(other.planId)).trucks[0];
  truck.loads[0].plannedStartMinute=540;truck.loads[0].plannedFinishMinute=600;
  await query("UPDATE dispatch_plan_snapshots SET trucks=trucks || $2::jsonb WHERE plan_id=$1",[f.planId,JSON.stringify([truck])]);
  const id=await exchangeRoot(f),dump=await dumping();
  const flow=await configureBinOrderWorkflow(command(f,{visitId:id,sequence:"collection_first",reuse:"same_bin",...dump,
    collectionWindow:{startAt:`${f.planDate}T12:00:00Z`,endAt:`${f.planDate}T14:00:00Z`}}));
  const c=await assignedPart(f,flow.body.parts.find(p=>p.role==="collection"));
  const d=await assignedPart({...other,planId:f.planId,planDate:f.planDate},flow.body.parts.find(p=>p.role==="delivery"));
  await assert.rejects(assertBinWorkflowPlanDependencies(d.part.visitId),/same truck/i);
  const plan=await storedPlan(f.planId),receiving=plan.trucks.find(t=>String(t.id)===other.binTruckId).loads[0];
  receiving.plannedStartMinute=420;receiving.plannedFinishMinute=480;
  await query("UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1",[f.planId,JSON.stringify(plan.trucks)]);
  await assert.rejects(assertBinWorkflowPlanDependencies(d.part.visitId),/must follow/i);
  receiving.plannedStartMinute=540;receiving.plannedFinishMinute=600;
  await query("UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1",[f.planId,JSON.stringify(plan.trucks)]);
  await perform(f,c.jobs[0],700,{occurredAt:yesterday.toISOString()});
  await assert.rejects(assertBinWorkflowPlanDependencies(d.part.visitId),/same Toronto calendar day/i);
});
