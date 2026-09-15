import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, withTransaction, closeDb } from "../src/db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../src/dispatch-fleet-status.js";
import { compactDispatchOrderCard, dispatchOrderSearchText } from "../src/dispatch-planner-optimization.js";
import { digestDispatchPlan, dispatchPlanBoard } from "../src/dispatch-planner-performance.js";
import { writeDispatchAudit } from "../src/dispatch-audit-repository.js";
import { syncDispatchPlanLoadAssignments } from "../src/dispatch-load-assignment-repository.js";

const targetRef = "GOA-8353-8354";
const sourceRefs = ["SOA08353", "SOA08354", "SOB120030"];
const correctAddress = "145 Valleymede Dr, Richmond Hill, ON L4B 1T3";
const otherAddress = "39 Estoril St, Richmond Hill, ON L4C 0B6";

function repairedOrder(order) {
  if (![targetRef, ...sourceRefs.slice(0, 2)].includes(order.id)) {return order;}
  const result = { ...order, address: correctAddress, destinationAddress: correctAddress, defaultDestinationAddress: correctAddress };
  if (order.raw) {
    result.raw = { ...order.raw };
    for (const field of ["dispatch_address", "drop_address", "default_drop_address"]) {
      if (Object.hasOwn(result.raw, field)) {result.raw[field] = correctAddress;}
    }
  }
  if (order.childOrderDetails) {result.childOrderDetails = order.childOrderDetails.map(repairedOrder);}
  return result;
}

async function lockedState() {
  await query("SET LOCAL lock_timeout='5s'");
  await query("SET LOCAL statement_timeout='30s'");
  await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
  for (const ref of sourceRefs) {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`dispatch-global-source-refresh:${ref.toLowerCase()}`]);
  }
  await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`dispatch-global-order-group:${targetRef.toLowerCase()}`]);
  const sources = (await query("SELECT * FROM sales_orders WHERE tranid=ANY($1) ORDER BY tranid FOR UPDATE", [sourceRefs])).rows;
  assert.deepEqual(sources.map(row=>[row.tranid, row.dispatch_address]),
    [[sourceRefs[0],correctAddress],[sourceRefs[1],correctAddress],[sourceRefs[2],otherAddress]], "Authoritative source address changed");
  const plan = (await query(`SELECT p.id,p.plan_date::text AS "planDate",p.status,p.revision,s.orders,s.trucks,s.summary,s.saved_at
    FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=325 FOR UPDATE OF p,s`)).rows[0];
  assert.equal(plan?.planDate,"2026-09-12");
  assert.equal(plan.status,"confirmed");
  const group = (await query("SELECT * FROM dispatch_global_order_groups WHERE group_ref=$1 FOR UPDATE",[targetRef])).rows[0];
  assert.equal(group?.active,true);
  assert.deepEqual([...group.full_order.childOrders].sort(),sourceRefs.slice(0,2));
  const targets = plan.orders.filter(order=>order.id===targetRef);
  assert.equal(targets.length,1,"Target group occurrence changed");
  assert.deepEqual([...targets[0].childOrders].sort(),sourceRefs.slice(0,2));
  const jobs = (await query("SELECT * FROM driver_job_records WHERE plan_id=325 ORDER BY job_id FOR SHARE")).rows;
  assert.equal(jobs.some(job=>job.started_at || job.completed_at || ["in_progress","complete"].includes(job.status)),false,"Plan has started driver work");
  return {plan,group,sources,jobs};
}

function correctedLoadTiming(load, projection) {
  assert.deepEqual(projection.stops.map(stop=>stop.id),load.stops.map(stop=>stop.id),"Projected stop identities changed");
  let cursor=projection.plannedStartMinute;
  assert.ok(Number.isFinite(cursor),"Invalid projected load start");
  for (const stop of projection.stops) {
    assert.ok(Number.isFinite(stop.timing.arrival) && Number.isFinite(stop.timing.depart),"Invalid projected stop timing");
    assert.ok(stop.timing.arrival>=cursor && stop.timing.depart>=stop.timing.arrival,"Projected stop times overlap");
    cursor=stop.timing.depart;
  }
  assert.equal(projection.timing.start,projection.plannedStartMinute);
  assert.equal(projection.timing.finish,projection.plannedFinishMinute);
  assert.ok(projection.plannedFinishMinute>=cursor,"Projected finish precedes final stop");
  const next={...load,timing:projection.timing,plannedStartMinute:projection.plannedStartMinute,
    plannedFinishMinute:projection.plannedFinishMinute,stops:load.stops.map((stop,index)=>({...stop,timing:projection.stops[index].timing}))};
  delete next.routeEstimate;
  return next;
}

function repairedTrucks(plan, projection) {
  const loads=plan.trucks.flatMap(truck=>truck.loads||[]);
  const affected=loads.filter(load=>(load.stops||[]).some(stop=>stop.orderId===targetRef));
  if (!affected.length) {return plan.trucks;}
  assert.ok(projection,"Assigned group requires a current timing projection");
  assert.equal(Number(projection.revision),Number(plan.revision),"Timing projection revision changed");
  assert.deepEqual(projection.beforeTrucks,plan.trucks,"Timing projection assignments changed");
  assert.deepEqual(projection.loads.map(load=>load.id).sort(),affected.map(load=>load.id).sort(),"Projected load selection changed");
  // This incident has one load for Li. A newly appended load needs a new
  // projection of that driver's full sequence, rather than a partial repair.
  assert.equal(loads.filter(load=>affected.some(target=>target.driverLogin===load.driverLogin)).length,affected.length,
    "Driver has additional loads; project the complete sequence");
  const byId=new Map(projection.loads.map(load=>[load.id,load]));
  return plan.trucks.map(truck=>({...truck,loads:(truck.loads||[]).map(load=>byId.has(load.id)?correctedLoadTiming(load,byId.get(load.id)):load)}));
}

async function persistRepair(state,orders,globalOrder,trucks) {
  const {plan}=state;
  const next={...plan,orders,trucks,revision:Number(plan.revision)+1};
  const board=dispatchPlanBoard(next);
  await query(`INSERT INTO dispatch_plan_snapshot_history
    (plan_id,plan_date,revision,orders,trucks,summary,original_saved_at,archive_reason,session_id,
      schema_version,plan_digest,order_count,truck_count,load_count,stop_count)
    VALUES ($1,$2::date,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,'stale_delivery_address_repair','repair:CE94487:20260912',
      2,$8,$9,$10,$11,$12)`,[plan.id,plan.planDate,plan.revision,JSON.stringify(plan.orders),JSON.stringify(plan.trucks),
    JSON.stringify(plan.summary),plan.saved_at,digestDispatchPlan(plan),plan.orders.length,board.truckCount,board.loadCount,board.stopCount]);
  await query("UPDATE dispatch_plans SET revision=$2,updated_at=now() WHERE id=$1",[plan.id,next.revision]);
  await query(`UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$8::jsonb,saved_at=now(),schema_version=2,plan_digest=$3,
    order_count=$4,truck_count=$5,load_count=$6,stop_count=$7 WHERE plan_id=$1`,
  [plan.id,JSON.stringify(orders),digestDispatchPlan(next),orders.length,board.truckCount,board.loadCount,board.stopCount,JSON.stringify(trucks)]);
  if (trucks!==plan.trucks) {await syncDispatchPlanLoadAssignments(next);}
  await query(`UPDATE dispatch_global_order_groups SET full_order=$2::jsonb,card=$3::jsonb,search_text=$4,updated_at=now()
    WHERE group_ref=$1`,[targetRef,JSON.stringify(globalOrder),JSON.stringify(compactDispatchOrderCard(globalOrder)),dispatchOrderSearchText(globalOrder)]);
  await query("DELETE FROM dispatch_order_catalog_entries WHERE order_ref=$1",[targetRef]);
  await query(`UPDATE dispatch_order_catalog_state SET generation=generation+1,
    catalog_count=(SELECT count(*)::int FROM dispatch_order_catalog_entries),updated_at=now() WHERE singleton=true`);
  return next;
}

/** Default execution rehearses every write and rolls back. No NetSuite writes. */
export async function repairCe94487StaleAddress({apply=false,expectedRevision=null,backupPath="",timingProjection=null}={}) {
  return withTransaction(async()=>{
    const state=await lockedState();
    const orders=state.plan.orders.map(repairedOrder);
    const globalOrder=repairedOrder(state.group.full_order);
    if (JSON.stringify(orders)===JSON.stringify(state.plan.orders) && JSON.stringify(globalOrder)===JSON.stringify(state.group.full_order)) {
      return {applied:false,alreadyCorrect:true,revision:Number(state.plan.revision)};
    }
    const trucks=repairedTrucks(state.plan,timingProjection);
    if (apply) {
      assert.equal(Number(expectedRevision),Number(state.plan.revision),"Plan revision changed; rehearse again");
      assert.ok(backupPath,"Applying requires a private backup path");
      await fs.mkdir(path.dirname(backupPath),{recursive:true,mode:0o700});
      await fs.writeFile(backupPath,JSON.stringify(state),{flag:"wx",mode:0o600});
    }
    const next=await persistRepair(state,orders,globalOrder,trucks);
    const after=(await query("SELECT orders,trucks,summary FROM dispatch_plan_snapshots WHERE plan_id=325")).rows[0];
    assert.deepEqual(after.orders,orders);
    assert.deepEqual(after.trucks,trucks,"Assignments or projected timings changed");
    assert.deepEqual(after.summary,state.plan.summary,"Plan summary changed");
    assert.deepEqual((await query("SELECT * FROM sales_orders WHERE tranid=ANY($1) ORDER BY tranid",[sourceRefs])).rows,state.sources,"Source orders changed");
    assert.deepEqual((await query("SELECT * FROM driver_job_records WHERE plan_id=325 ORDER BY job_id")).rows,state.jobs,"Driver records changed");
    await writeDispatchAudit({action:"dispatch.stale_delivery_address_repaired",entityType:"order",entityId:targetRef,orderId:targetRef,
      planId:325,planDate:state.plan.planDate,source:"stale-delivery-address-repair",operatorName:"system:authorized-address-repair",
      before:state.plan.orders.find(order=>order.id===targetRef),after:orders.find(order=>order.id===targetRef),
      details:{previousRevision:Number(state.plan.revision),revision:next.revision,backupPath:apply?backupPath:"rollback rehearsal",sourceRefs}});
    return {applied:apply,rolledBack:!apply,previousRevision:Number(state.plan.revision),revision:next.revision,
      groupAddress:globalOrder.destinationAddress,otherAddress,driverRecordsPreserved:state.jobs.length,assignmentsPreserved:true};
  },{rollback:!apply});
}

if (process.argv[1]===fileURLToPath(import.meta.url)) {
  try {
    const value=flag=>process.argv[process.argv.indexOf(flag)+1];
    console.log(JSON.stringify(await repairCe94487StaleAddress({apply:process.argv.includes("--apply"),
      expectedRevision:process.argv.includes("--revision")?value("--revision"):null,
      backupPath:process.argv.includes("--backup")?value("--backup"):"",
      timingProjection:process.argv.includes("--timing")?JSON.parse(await fs.readFile(value("--timing"),"utf8")):null})));
  } finally {await closeDb();}
}
