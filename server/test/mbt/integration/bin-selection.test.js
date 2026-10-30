import assert from "node:assert/strict";
import test, { after } from "node:test";
import crypto from "node:crypto";
import express from "express";
import { query, closeDb, withTransaction } from "../../../src/db.js";
import { recordAssetMovement } from "../../../src/mbt/asset-service.js";
import { assignMbtBinFrontLeg } from "../../../src/mbt/bin-dispatch-service.js";
import { stagePlanningAssignment } from "../../../src/mbt/bin-planning-assignments.js";
import { createMbtRouter } from "../../../src/mbt/router.js";
import { configureBinOrderWorkflow } from "../../../src/mbt/bin-order-workflow-service.js";
import { planningFixture, run, storedPlan, boundary, command } from "../support/bin-planning-fixtures.js";
import { binStopLabels } from "../../../src/mbt/bin-stop-labels.js";
import { changeAssignedBin } from "../../../src/mbt/bin-selection-service.js";
import { getBinOrderWorkflowOptions } from "../../../src/mbt/bin-order-workflow-service.js";
import { releaseDispatchPlanEditLease,acquireDispatchPlanEditLease } from "../../../src/dispatch-plan-lease-repository.js";
import { getDriverDayJobs } from "../../../src/driver-repository.js";
import { startMbtDriverBinJob } from "../../../src/mbt/driver-bin-execution-service.js";
import { availableDriverExecutionPlanDate,driverBinEvent,enabledDriverBinBoundary } from "../support/driver-bin-fixtures.js";
after(closeDb);
let offset = 4100;

async function fixture({assigned = false, released = false, executable=false, legacy=false} = {}) {
  const f = await planningFixture(offset++,executable ? {planDate:await availableDriverExecutionPlanDate()} : {});
  const alternate = await planningFixture(offset++);
  const serviceLineId = crypto.randomUUID();
  await query(`INSERT INTO mbt_contract_service_lines
    (service_line_id,contract_id,line_number,bin_type_id,customer_site_profile_id,site_snapshot,pricing_snapshot)
    SELECT $1,contract_id,1,bin_type_id,customer_site_profile_id,site_snapshot,pricing_snapshot
    FROM mbt_contracts WHERE contract_id=$2`, [serviceLineId,f.contractId]);
  await query("UPDATE mbt_service_visits SET service_line_id=$1 WHERE contract_id=$2",[serviceLineId,f.contractId]);
  const configured = legacy ? {body:{parts:[{visitId:f.frontVisitId,revision:1}]}} : await configureBinOrderWorkflow({visitId:f.frontVisitId,expectedRevision:1,
    actor:f.actor,idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),
    deliveryAssetId:f.assetId,deliveryWindow:{startAt:`${f.planDate}T11:00:00Z`,endAt:`${f.planDate}T12:00:00Z`}});
  const part = configured.body.parts[0];
  if (assigned) await run(f,"assign",{visitId:part.visitId,expectedVisitRevision:part.revision});
  if (released) await run(f,"confirm");
  return {...f,alternate,part,serviceLineId};
}

async function http(f, task) {
  const events=[]; const app=express(); app.use(express.json());
  app.use((req,_res,next)=>{req.operator={id:f.actor.operatorId,roles:req.get("x-test-denied") ? ["sales"] : ["dispatcher"]};next();});
  app.use("/api/mbt",createMbtRouter({authorizePhase3Capability:async()=>({}),planningChanged:e=>events.push(e)}));
  const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});
  const url=`http://127.0.0.1:${server.address().port}/api/mbt/planning/workflows/${f.part.visitId}`;
  try {await task({url,events});} finally {await new Promise(resolve=>server.close(resolve));}
}
async function selection(f,url) {
  const response=await fetch(url); assert.equal(response.status,200);
  const options=await response.json(); assert.ok(options.binSelection,"the planner exposes bin re-selection eligibility");
  const plan=await storedPlan(f.planId);
  const state=(await query("SELECT revision::int FROM mbt_bin_asset_state WHERE asset_id=$1",[f.alternate.assetId])).rows[0];
  return {expectedRevision:options.workflow.revision,expectedVisits:options.binSelection.expectedVisits,
    assetId:f.alternate.assetId,expectedStateRevision:state.revision,reason:"Choose another matching empty bin",
    plans:options.binSelection.plans.map(p=>({...p,baseRevision:plan.revision,baseDigest:plan.digest,
      sessionId:f.editLease.sessionId,editLeaseToken:f.editLease.token}))};
}
async function post(url,body,key=crypto.randomUUID(),headers={}) {
  const response=await fetch(`${url}/bin-selection`,{method:"POST",headers:{"content-type":"application/json","idempotency-key":key,...headers},body:JSON.stringify(body)});
  const text=await response.text(); let result; try {result=JSON.parse(text);} catch {result={error:text};}
  return {status:response.status,body:result};
}
async function visit(id) {return (await query("SELECT * FROM mbt_service_visits WHERE service_visit_id=$1",[id])).rows[0];}

test("bin selection: an unassigned delivery can select again without creating orders or billing parts",async()=>{
  const f=await fixture();
  await http(f,async({url})=>{
    const before=await visit(f.part.visitId),count=(await query("SELECT count(*)::int AS n FROM mbt_service_visits WHERE contract_id=$1",[f.contractId])).rows[0].n;
    const body=await selection(f,url),key=crypto.randomUUID();
    const result=await post(url,body,key); assert.equal(result.status,200,JSON.stringify(result.body));
    const afterVisit=await visit(f.part.visitId);
    assert.equal(afterVisit.expected_asset_id,f.alternate.assetId); assert.equal(afterVisit.dispatch_plan_id,null);
    assert.equal(afterVisit.visit_reference,before.visit_reference); assert.equal(afterVisit.billing_ownership,"none");
    assert.equal((await query("SELECT count(*)::int AS n FROM mbt_service_visits WHERE contract_id=$1",[f.contractId])).rows[0].n,count);
    assert.equal((await post(url,body,key)).status,200);
    assert.equal((await visit(f.part.visitId)).revision,afterVisit.revision);
  });
});

for (const released of [false,true]) test(`bin selection: ${released ? "released work republishes" : "draft stays draft"} with a fresh generation`,async()=>{
  const f=await fixture({assigned:true,released});
  await http(f,async({url,events})=>{
    const before=await visit(f.part.visitId),body=await selection(f,url);
    const result=await post(url,body); assert.equal(result.status,200,JSON.stringify(result.body));
    const afterVisit=await visit(f.part.visitId);
    assert.equal(afterVisit.dispatch_load_id,before.dispatch_load_id); assert.equal(afterVisit.planned_truck_id,before.planned_truck_id);
    assert.equal(Number(afterVisit.planning_generation),Number(before.planning_generation)+1);
    assert.equal(afterVisit.expected_asset_id,f.alternate.assetId);
    const assignments=(await query("SELECT * FROM mbt_bin_planning_assignments WHERE service_visit_id=$1 ORDER BY generation",[f.part.visitId])).rows;
    assert.ok(assignments[0].withdrawn_at); assert.equal(Boolean(assignments.at(-1).released_at),released);
    assert.ok(afterVisit.dispatch_assignment_snapshot.stops.every(s=>s.mbt.driverReleased===released));
    assert.ok(afterVisit.dispatch_assignment_snapshot.stops.every(s=>s.assetCode===f.alternate.assetCode));
    assert.equal(events.length,1);
  });
});

test("bin selection: start, stale source, missing lease and unauthorized callers make no writes",async()=>{
  const f=await fixture({assigned:true,released:true});
  await http(f,async({url})=>{
    const body=await selection(f,url),before=await visit(f.part.visitId),plan=await storedPlan(f.planId);
    assert.equal((await post(url,body,crypto.randomUUID(),{"x-test-denied":"1"})).status,403);
    assert.equal((await post(url,{...body,plans:[]})).status,409);
    assert.equal((await post(url,{...body,expectedVisits:[]})).status,409);
    assert.equal((await post(url,{...body,assetId:"invalid-bin"})).status,400);
    assert.equal((await post(url,{...body,expectedStateRevision:99999})).status,409);
    assert.equal((await storedPlan(f.planId)).digest,plan.digest);
    assert.deepEqual(await visit(f.part.visitId),before);
    await query("UPDATE mbt_service_visits SET actual_started_at=now(),status='in_progress' WHERE service_visit_id=$1",[f.part.visitId]);
    const started=await post(url,body); assert.equal(started.status,409); assert.match(started.body.error || started.body.message,/start/i);
    assert.equal((await visit(f.part.visitId)).expected_asset_id,f.assetId);
  });
});

async function serviceInput(f,other=null) {
  const options=await getBinOrderWorkflowOptions(f.part.visitId);
  const state=(await query("SELECT revision::int FROM mbt_bin_asset_state WHERE asset_id=$1",[f.alternate.assetId])).rows[0];
  return {visitId:f.part.visitId,actor:f.actor,idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),
    reason:"Reselect physical bin",assetId:f.alternate.assetId,expectedStateRevision:state.revision,
    expectedRevision:options.workflow.revision,expectedVisits:options.binSelection.expectedVisits,
    plans:options.binSelection.plans.map(p=>{const lease=p.planId===f.planId ? f.editLease : other.editLease;
      return {...p,sessionId:lease.sessionId,editLeaseToken:lease.token};})};
}
async function collection(f,destination={kind:"yard",yardId:"00000000-0000-4000-8000-000000012441"}) {
  const dumpSiteId=crypto.randomUUID(),materialId=crypto.randomUUID();
  await query("INSERT INTO mbt_materials(material_id,material_code,display_name,created_by,updated_by) VALUES ($1,$2,'Clean fill','test','test')",[materialId,`MAT-${materialId}`]);
  await query(`INSERT INTO mbt_dump_sites(dump_site_id,dump_site_code,display_name,address_line_1,city,region,created_by,updated_by)
    VALUES ($1,$2,'Test dump','500 Dump Road','Toronto','ON','test','test')`,[dumpSiteId,`DP-${dumpSiteId}`]);
  await query(`INSERT INTO mbt_dump_site_materials(dump_site_material_id,dump_site_id,material_id,accepted,created_by,updated_by)
    VALUES ($1,$2,$3,true,'test','test')`,[crypto.randomUUID(),dumpSiteId,materialId]);
  await query("UPDATE mbt_contract_service_lines SET pricing_snapshot=pricing_snapshot || $2::jsonb WHERE service_line_id=$1",[f.serviceLineId,JSON.stringify({materialId})]);
  const configured=await configureBinOrderWorkflow({visitId:f.successorVisitId,expectedRevision:1,actor:f.actor,
    idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),dumpSiteId,materialId,
    collectionWindow:{startAt:`${f.alternate.planDate}T13:00:00Z`,endAt:`${f.alternate.planDate}T14:00:00Z`},
    destination});
  return configured.body.parts[0];
}

test("bin selection: historical dependent work on another date requires both leases and changes atomically",async()=>{
  const f=await fixture({assigned:true,released:true}),part=await collection(f);
  await releaseDispatchPlanEditLease(f.alternate.editLease);
  const identity={...f.alternate.editLease,operatorId:f.actor.operatorId,sessionId:crypto.randomUUID()};
  const lease=await acquireDispatchPlanEditLease(identity);
  const other={...f.alternate,actor:f.actor,editLease:{...identity,token:lease.token}};
  // Recreate an existing collection planned before the final-collection hold.
  // Its bin-selection and lease guarantees must survive the new planning rule.
  const historical=await command(other,"assign",{visitId:part.visitId,expectedVisitRevision:part.revision,
    assetAssignments:[{assetId:f.assetId,reservationSlot:"outgoing",expectedStateRevision:1}]});
  await withTransaction(async()=>{
    await assignMbtBinFrontLeg(historical,{...boundary,planning:true});
    await stagePlanningAssignment(part.visitId,await storedPlan(other.planId),historical,false);
  });
  const input=await serviceInput(f,other),before=await storedPlan(f.planId),dependentBefore=await storedPlan(other.planId);
  await assert.rejects(changeAssignedBin({...input,plans:input.plans.slice(0,1)},boundary),/every affected plan/i);
  await assert.rejects(changeAssignedBin(input,{...boundary,hooks:{beforeCommit:()=>{throw new Error("injected selection rollback");}}}),/injected selection rollback/);
  assert.equal((await storedPlan(f.planId)).digest,before.digest);assert.equal((await storedPlan(other.planId)).digest,dependentBefore.digest);
  await changeAssignedBin(input,boundary);
  assert.equal((await visit(part.visitId)).expected_asset_id,f.alternate.assetId);
  assert.equal((await visit(f.part.visitId)).expected_asset_id,f.alternate.assetId);
  const active=(await query("SELECT service_visit_id,released_at FROM mbt_bin_planning_assignments WHERE service_visit_id=ANY($1::uuid[]) AND withdrawn_at IS NULL",[[f.part.visitId,part.visitId]])).rows;
  assert.ok(active.find(a=>a.service_visit_id===f.part.visitId).released_at);
  assert.equal(active.find(a=>a.service_visit_id===part.visitId).released_at,null);
});

test("bin selection: concurrent selections have one winner and old driver jobs cannot start",async()=>{
  const f=await fixture({assigned:true,released:true,executable:true});
  const jobs=(await getDriverDayJobs(f.driverLogin,{date:f.planDate,allowBin:true})).jobs.filter(j=>j.mbt);
  assert.equal(jobs.length,2);
  const input=await serviceInput(f);
  const results=await Promise.allSettled(Array.from({length:12},()=>changeAssignedBin({...input,idempotencyKey:crypto.randomUUID()},boundary)));
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal((await query("SELECT count(*)::int AS n FROM mbt_bin_planning_assignments WHERE service_visit_id=$1 AND withdrawn_at IS NULL",[f.part.visitId])).rows[0].n,1);
  const job=jobs[0],manifest={manifestId:crypto.randomUUID(),schemaVersion:2,planId:f.planId,planRevision:1};
  await assert.rejects(startMbtDriverBinJob({job,manifest,event:driverBinEvent(f,job,"job_started",1,{}, {manifestId:manifest.manifestId})},
    {capability:enabledDriverBinBoundary}),e=>e.code==="MBT_DRIVER_BIN_REVIEW_REQUIRED");
  const refreshed=(await getDriverDayJobs(f.driverLogin,{date:f.planDate,allowBin:true})).jobs.filter(j=>j.mbt);
  assert.equal(refreshed.length,2);assert.equal(refreshed[0].mbt.exactAssets.expected.assetId,f.alternate.assetId);
});

test("bin selection: a real driver start locks the order before its parent records a start",async()=>{
  const f=await fixture({assigned:true,released:true,executable:true}),input=await serviceInput(f);
  const job=(await getDriverDayJobs(f.driverLogin,{date:f.planDate,allowBin:true})).jobs.find(j=>j.mbt);
  const manifest={manifestId:crypto.randomUUID(),schemaVersion:2,planId:f.planId,planRevision:1};
  await startMbtDriverBinJob({job,manifest,event:driverBinEvent(f,job,"job_started",1,{}, {manifestId:manifest.manifestId})},{capability:enabledDriverBinBoundary});
  assert.equal((await visit(f.frontVisitId)).actual_started_at,null);
  await assert.rejects(changeAssignedBin(input,boundary),/started/i);
  assert.equal((await visit(f.part.visitId)).expected_asset_id,f.assetId);
});

test("bin selection: a changed pickup source needs a verified route that fits the existing load",async()=>{
  const f=await fixture({assigned:true,released:true});
  const yard=(await query("SELECT yard_id,yard_code FROM mbt_yards WHERE active AND yard_code='3445'")).rows[0];
  await withTransaction(()=>recordAssetMovement({query,ambientTransaction:true},{assetId:f.alternate.assetId,movementType:"yard_transfer",
    afterStatus:"available",afterLocation:{kind:"yard",reference:yard.yard_code,yardId:yard.yard_id},source:"bin-selection-test",
    actorType:"operator",actorId:f.actor.operatorId,occurredAt:`${f.alternate.planDate}T08:00:00Z`}));
  const p=await storedPlan(f.planId);p.trucks[0].loads[0].plannedFinishMinute=540;
  await query("UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1",[f.planId,JSON.stringify(p.trucks)]);
  const input=await serviceInput(f),before=await storedPlan(f.planId);
  await assert.rejects(changeAssignedBin(input,boundary),/route/i);
  await assert.rejects(changeAssignedBin(input,{...boundary,routeEstimator:async()=>({source:"fallback",legMinutes:[10,10]})}),/could not be verified/i);
  await assert.rejects(changeAssignedBin(input,{...boundary,routeEstimator:async()=>({source:"google_routes_v2",legMinutes:[600,600]})}),/fit|schedule|time/i);
  assert.equal((await storedPlan(f.planId)).digest,before.digest);
  let requested;
  await changeAssignedBin(input,{...boundary,routeEstimator:async request=>{requested=request;return {source:"google_routes_v2",legMinutes:[10,10]};}});
  const afterVisit=await visit(f.part.visitId),stops=afterVisit.dispatch_assignment_snapshot.stops;
  assert.equal(afterVisit.service_snapshot.binWorkflow.source.id,yard.yard_id);
  assert.equal(requested.stops[1].location,stops[0].planningAddress);
  assert.ok(stops[1].timing.arrival>=stops[0].timing.depart+10);
  assert.ok(stops[1].timing.depart<=540);
});

test("bin selection: unrelated drafts in the released plan remain unpublished",async()=>{
  const f=await fixture({assigned:true,released:true}),other=await planningFixture(offset++);
  await run(f,"assign",{visitId:other.frontVisitId,expectedVisitRevision:1,loadId:f.binLoadIds[1],
    assetAssignments:[{assetId:other.assetId,reservationSlot:"outgoing",expectedStateRevision:1}]});
  const before=await visit(other.frontVisitId);
  await changeAssignedBin(await serviceInput(f),boundary);
  assert.deepEqual(await visit(other.frontVisitId),before);
  const assignment=(await query("SELECT released_at FROM mbt_bin_planning_assignments WHERE service_visit_id=$1 AND withdrawn_at IS NULL",[other.frontVisitId])).rows[0];
  assert.equal(assignment.released_at,null);
});

test("bin selection: a linked onward delivery keeps its collection bin",async()=>{
  const source=await fixture(),target=await fixture();
  await collection(source,{kind:"delivery",orderId:target.frontVisitId});
  const options=await getBinOrderWorkflowOptions(target.part.visitId);
  assert.equal(options.binSelection.eligible,false);assert.match(options.binSelection.reason,/linked/i);
  await assert.rejects(changeAssignedBin(await serviceInput(target),boundary),/linked/i);
  assert.equal((await visit(target.part.visitId)).expected_asset_id,source.assetId);
});

test("bin selection: legacy released delivery keeps visit and step IDs while selecting another bin",async()=>{
  const f=await fixture({legacy:true});
  const input={actor:f.actor,visitId:f.frontVisitId,planId:f.planId,planDate:f.planDate,loadId:f.binLoadIds[0],
    expectedPlanRevision:(await storedPlan(f.planId)).revision,expectedVisitRevision:1,
    assetAssignments:[{assetId:f.assetId,reservationSlot:"outgoing",expectedStateRevision:1}],reason:"Legacy delivery",
    idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID()};
  await assignMbtBinFrontLeg(input,boundary);
  await withTransaction(async()=>stagePlanningAssignment(f.frontVisitId,await storedPlan(f.planId),input));
  await run(f,"confirm");
  const before=await visit(f.frontVisitId),steps=(await query("SELECT visit_step_id FROM mbt_visit_steps WHERE service_visit_id=$1 ORDER BY sequence_number",[f.frontVisitId])).rows;
  await changeAssignedBin(await serviceInput(f),boundary);
  const changed=await visit(f.frontVisitId);
  assert.equal(changed.visit_reference,before.visit_reference);assert.equal(changed.expected_asset_id,f.alternate.assetId);
  assert.equal(changed.billing_ownership,before.billing_ownership);
  assert.deepEqual((await query("SELECT visit_step_id FROM mbt_visit_steps WHERE service_visit_id=$1 ORDER BY sequence_number",[f.frontVisitId])).rows,steps);
  assert.equal((await visit(f.successorVisitId)).expected_asset_id,f.alternate.assetId);
});

test("bin selection: simultaneous driver start and re-selection have exactly one committed winner",async()=>{
  for (let round=0;round<3;round++) {
    const f=await fixture({assigned:true,released:true,executable:true}),input=await serviceInput(f);
    const job=(await getDriverDayJobs(f.driverLogin,{date:f.planDate,allowBin:true})).jobs.find(j=>j.mbt);
    const manifest={manifestId:crypto.randomUUID(),schemaVersion:2,planId:f.planId,planRevision:1};
    const results=await Promise.allSettled([
      startMbtDriverBinJob({job,manifest,event:driverBinEvent(f,job,"job_started",1,{}, {manifestId:manifest.manifestId})},{capability:enabledDriverBinBoundary}),
      changeAssignedBin(input,boundary)
    ]);
    assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
    const current=await visit(f.part.visitId);
    assert.equal(current.expected_asset_id,results[0].status==="fulfilled" ? f.assetId : f.alternate.assetId);
    assert.equal(Boolean(current.actual_started_at),results[0].status==="fulfilled");
  }
});


test("bin selection: legacy Dispatch labels use the saved generation without changing the plan",async()=>{
  const f=await fixture({legacy:true});
  await assignMbtBinFrontLeg({visitId:f.frontVisitId,expectedVisitRevision:1,expectedPlanRevision:(await storedPlan(f.planId)).revision,planId:f.planId,planDate:f.planDate,loadId:f.binLoadIds[0],
    actor:f.actor,idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),reason:"Legacy labels",assetAssignments:[{assetId:f.assetId,reservationSlot:"outgoing",expectedStateRevision:1}]},boundary);
  const plan=await storedPlan(f.planId),original=structuredClone(plan);
  for(const t of plan.trucks) for(const l of t.loads) for(const s of l.stops) {
    delete s.reference;delete s.assetId;delete s.assetCode;
  }
  const before=structuredClone(plan);
  await query("UPDATE mbt_service_visits SET expected_asset_id=$2 WHERE service_visit_id=$1",[f.frontVisitId,f.alternate.assetId]);
  const labels=await binStopLabels(plan),stops=plan.trucks.flatMap(t=>t.loads.flatMap(l=>l.stops));
  for(const stop of stops.filter(s=>s.mbt)) {
    assert.match(labels[stop.id].reference,/^BIN\d{5}D$/);
    assert.equal(labels[stop.id].assetCode,f.assetCode);
  }
  assert.deepEqual(plan,before);assert.equal((await storedPlan(f.planId)).digest,original.digest);
});

test("bin selection: a lost-response retry can reacquire its date lease without another generation",async()=>{
  const f=await fixture({assigned:true,released:true}),input=await serviceInput(f);
  const first=await changeAssignedBin(input,boundary),before=await visit(f.part.visitId);
  await releaseDispatchPlanEditLease(f.editLease);
  const identity={...f.editLease,sessionId:crypto.randomUUID()};
  const fresh=await acquireDispatchPlanEditLease(identity);
  const retry={...input,plans:input.plans.map(p=>({...p,sessionId:identity.sessionId,editLeaseToken:fresh.token}))};
  const second=await changeAssignedBin(retry,boundary);
  assert.deepEqual(second.body,first.body);assert.equal(second.replayed,true);
  assert.equal((await visit(f.part.visitId)).planning_generation,before.planning_generation);
});

test("bin selection: an order with no initial bin must be planned before re-selection",async()=>{
  const f=await fixture({legacy:true});
  await query("UPDATE mbt_service_visits SET expected_asset_id=NULL,outgoing_asset_id=NULL WHERE service_visit_id=$1",[f.frontVisitId]);
  const options=await getBinOrderWorkflowOptions(f.frontVisitId);
  assert.equal(options.binSelection.eligible,false);assert.match(options.binSelection.reason,/initial bin/i);
  await assert.rejects(changeAssignedBin(await serviceInput(f),boundary),/initial bin/i);
});

test("bin selection: aboard and yard sources remove and restore pickup evidence while retaining delivery identity",async()=>{
  const f=await fixture();
  const originalVisit=await visit(f.part.visitId);
  const readSteps=async()=>(await query(`SELECT visit_step_id,action_code,expected_asset_id FROM mbt_visit_steps
    WHERE service_visit_id=$1 ORDER BY sequence_number`,[f.part.visitId])).rows;
  const readEvidence=async id=>(await query(`SELECT visit_evidence_requirement_id,evidence_code,evidence_type
    FROM mbt_visit_evidence_requirements WHERE visit_step_id=$1 ORDER BY evidence_code`,[id])).rows;
  const before=await readSteps(),delivery=before.find(s=>s.action_code==="deliver_bin");
  const deliveryEvidence=await readEvidence(delivery.visit_step_id);
  await withTransaction(()=>recordAssetMovement({query,ambientTransaction:true},{assetId:f.alternate.assetId,
    movementType:"collect_empty_bin_outgoing",afterStatus:"on_truck",
    afterLocation:{kind:"truck",truckId:f.binTruckId,reference:"Loaded empty bin"},truckId:f.binTruckId,
    source:"bin-selection-test",actorType:"system",actorId:"test",occurredAt:`${f.planDate}T10:00:00Z`}));
  await changeAssignedBin(await serviceInput(f),boundary);
  const aboard=await readSteps();
  assert.deepEqual(aboard,[{...delivery,expected_asset_id:f.alternate.assetId}]);
  assert.deepEqual(await readEvidence(delivery.visit_step_id),deliveryEvidence);
  assert.deepEqual(await readEvidence(before.find(s=>s.action_code==="collect_empty_bin").visit_step_id),[]);
  await changeAssignedBin(await serviceInput({...f,alternate:{assetId:f.assetId}}),boundary);
  const restored=await readSteps();
  assert.deepEqual(restored.map(s=>s.action_code),["collect_empty_bin","deliver_bin"]);
  assert.equal(restored[1].visit_step_id,delivery.visit_step_id);
  assert.ok(restored.every(s=>s.expected_asset_id===f.assetId));
  assert.deepEqual(await readEvidence(delivery.visit_step_id),deliveryEvidence);
  assert.deepEqual((await readEvidence(restored[0].visit_step_id)).map(e=>[e.evidence_code,e.evidence_type]),
    [["bin_photo","photo"],["bin_scan","bin_scan"]]);
  assert.equal((await visit(f.part.visitId)).visit_reference,originalVisit.visit_reference);
  assert.equal((await getBinOrderWorkflowOptions(f.part.visitId)).workflow.reference,f.part.reference);
});
