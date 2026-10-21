import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile } from "node:fs/promises";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { completeDirectDependenciesForSalesOrderDrop, enrichDispatchOrdersWithDependencies } from "../../../src/order-dependency-repository.js";
import { assertSalesDeliveryPlanningAllowed } from "../../../src/dispatch-fulfilled-so-repository.js";
import crypto from "node:crypto";
import {loadDispatchOrdersForResponse} from "../../../src/server.js";
import {createDispatchPlan,saveDispatchPlanSnapshot} from "../../../src/dispatch-plan-repository.js";
import {applyDispatchV2Command,syncDispatchPlanLoadProjection,syncDispatchPlanOrderAssignments} from "../../../src/dispatch-planner-v2-repository.js";
import {digestDispatchPlan} from "../../../src/dispatch-planner-performance.js";
import {validateDispatchPlanDependencies} from "../../../src/order-dependency-repository.js";
import {getDriverDayJobs} from "../../../src/driver-repository.js";

after(closeDb);
const TO_ID = 9359251001;
const SO_ID = TO_ID + 1;
const TO = "TO-DIRECT-LIFECYCLE";
const SO = "SO-DIRECT-LIFECYCLE";
const FINISHED = "2098-09-01T19:25:43.188Z";

async function rollbackTest(run) {
  const context = await beginRollbackContext();
  try { await context.run(run); } finally { await context.rollback(); }
}

async function seed({ quantity = 20, allocated = 19 } = {}) {
  await query(`INSERT INTO transfer_orders (netsuite_id,tranid,trandate,status,status_text,
    from_location_id,from_location,to_location_id,to_location,receiving_status,fulfillment_status,netsuite_active)
    VALUES ($1,$2,'2098-09-01','B','Pending Fulfillment',28,'2967',15,'12441','not_received','open',true)`, [TO_ID,TO]);
  await query(`INSERT INTO sales_orders (netsuite_id,tranid,trandate,status,status_text,customer,
    outbound_location_id,outbound_location,fulfillment_status,netsuite_active)
    VALUES ($1,$2,'2098-09-01','B','Pending Fulfillment','Test customer',15,'12441','open',true)`, [SO_ID,SO]);
  const salesLine = (await query(`INSERT INTO sales_order_lines (sales_order_id,line_id,item_id,item_name,sku,
    quantity,unit,piece_qty,to_pcs,netsuite_active) VALUES ($1,1,5055,'Test pieces','TEST-PIECES',$2,'PC',$2,1,true) RETURNING id`, [SO_ID,allocated])).rows[0];
  const lines = {};
  for (const stage of ["outbound", "receiving"]) {
    lines[stage] = (await query(`INSERT INTO transfer_order_lines (transfer_order_id,line_stage,line_id,item_id,item_name,sku,
      item_type,quantity,unit,piece_qty,to_pcs,received_piece_qty,netsuite_received_qty,netsuite_active)
      VALUES ($1,$2,1,5055,'Test pieces','TEST-PIECES','InvtPart',$3,'PC',$3,1,0,0,true) RETURNING id`, [TO_ID,stage,quantity])).rows[0].id;
  }
  const plan = (await query("INSERT INTO dispatch_plans (plan_date,status) VALUES ('2098-09-01','confirmed') RETURNING id")).rows[0];
  const dependency = (await query(`INSERT INTO order_dependencies (sales_order_id,sales_order_ref,dispatch_target_ref,
    transfer_order_id,transfer_order_ref,dependency_mode,same_load_required,status,source_location_id,source_location,
    accounting_destination_location_id,accounting_destination_location,planned_plan_id,planned_date,planned_load_id)
    VALUES ($1,$2,$2,$3,$4,'direct_to_customer',true,'active',28,'2967',15,'12441',$5,'2098-09-01','link-load') RETURNING id`,
  [SO_ID,SO,TO_ID,TO,plan.id])).rows[0];
  await query(`INSERT INTO order_dependency_lines (dependency_id,sales_line_id,transfer_outbound_line_id,transfer_receiving_line_id,
    item_id,item_name,unit,allocated_quantity,piece_qty,line_role,dispatch_target_line_key)
    VALUES ($1,$2,$3,$4,5055,'Test pieces','PC',$5,$5,'sales_allocation',$6)`,
  [dependency.id,salesLine.id,lines.outbound,lines.receiving,allocated,`${SO}::${SO}::${salesLine.id}`]);
  const card = { id: TO, type: "TO", sourceYard: "2967", destinationYard: "12441", pickupLocations: ["2967"],
    items: [{ lineRowId: String(lines.outbound), itemId: 5055, sku: "TEST-PIECES", quantity, pieces: quantity, unit: "PC", toPcs: 1 }] };
  return { plan, dependency, card };
}

async function driverDrop(plan, ref, id = "direct-customer-drop", finished = FINISHED) {
  await query(`INSERT INTO driver_job_records (job_id,plan_id,plan_date,driver_login,truck_plate,load_id,load_name,
    stop_id,stop_type,order_refs,status,started_at,completed_at,job_details)
    VALUES ($1,$2,'2098-09-01','test-driver','TEST-TRUCK','link-load','Test load',$1,'dropoff',$3::jsonb,'complete',
      '2098-09-01T18:00:00Z',$4,$5::jsonb)`,
  [id,plan.id,JSON.stringify([ref]),finished,JSON.stringify({ orderTypes: [ref===SO ? "SO" : "TO"], orders: [{ orderRef: ref, orderType: ref===SO ? "SO" : "TO" }] })]);
}

async function complete(plan) {
  return completeDirectDependenciesForSalesOrderDrop({ salesOrderRefs: [SO], driverJobId: "direct-customer-drop",
    planId: plan.id, planDate: "2098-09-01", truckPlate: "TEST-TRUCK", loadId: "link-load", loadName: "Test load" });
}
async function completion() {
  return (await query("SELECT * FROM dispatch_order_completion_status WHERE order_kind='TO' AND order_ref=$1", [TO])).rows;
}

test("partial TO exposes only unallocated cargo and full TO remains linked", () => rollbackTest(async () => {
  const { card } = await seed();
  const [projected] = await enrichDispatchOrdersWithDependencies([card]);
  assert.equal(projected.dependencyHidden, false);
  assert.equal(projected.toRouteProjection.salesQty, 1);
  assert.equal(projected.toRouteProjection.pieces, 1);
  await assertSalesDeliveryPlanningAllowed([TO]);
  await query("UPDATE order_dependency_lines SET allocated_quantity=20,piece_qty=20 WHERE item_id=5055");
  const [full] = await enrichDispatchOrdersWithDependencies([card]);
  assert.equal(full.dependencyHidden, true);
  await assert.rejects(assertSalesDeliveryPlanningAllowed([TO]), { code: "DISPATCH_LINKED_CARGO_ONLY" });
}));

test("partial direct delivery does not complete whole TO and replay cannot double receipt", () => rollbackTest(async () => {
  const { plan } = await seed();
  await driverDrop(plan, SO);
  await complete(plan);
  assert.equal((await completion()).length, 0, "one outstanding piece must prevent whole-TO completion");
  const before = (await query("SELECT received_piece_qty FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='receiving'", [TO_ID])).rows;
  assert.equal(Number(before[0].received_piece_qty), 19);
  await complete(plan);
  assert.deepEqual((await query("SELECT received_piece_qty FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='receiving'", [TO_ID])).rows, before);
  await assertSalesDeliveryPlanningAllowed([TO]);
}));

test("the persisted planner and feed retain only the TO remainder",()=>rollbackTest(async()=>{
  const {plan:linkedPlan}=await seed();
  await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES ($1,'[]','[]','{}')",[linkedPlan.id]);
  const linkedSnapshot={id:String(linkedPlan.id),revision:0,planDate:"2098-09-01",orders:[],trucks:[],summary:{}};
  await syncDispatchPlanLoadProjection(linkedSnapshot);
  await syncDispatchPlanOrderAssignments(linkedSnapshot);
  const cards=await loadDispatchOrdersForResponse({type:"TO",exactOrderRefs:[TO],search:TO});
  const card=cards.find(row=>row.id===TO);
  assert.equal(card.toRouteProjection.pieces,1);
  const created=await createDispatchPlan({planDate:"2098-09-02",note:"Isolated remaining cargo"});
  const saved=await saveDispatchPlanSnapshot(created.id,{planDate:created.planDate,baseRevision:created.revision,
    orders:[card],trucks:[{id:"remaining-truck",plate:"REMAINING",driverLogin:"remaining-driver",loads:[{id:"remaining-load",name:"Remaining",stops:[]}]}],summary:{}});
  const result=await applyDispatchV2Command({planId:created.id,command:{commandId:crypto.randomUUID(),commandType:"replace_plan",
    baseRevision:saved.revision,baseDigest:digestDispatchPlan(saved),payload:{orders:[card],summary:{},trucks:[{
      id:"remaining-truck",plate:"REMAINING",driverLogin:"remaining-driver",loads:[{id:"remaining-load",name:"Remaining",stops:[
        {id:"remaining-pickup",type:"pick",orderId:TO,orderRefs:[TO],location:"2967"},
        {id:"remaining-drop",type:"drop",orderId:TO,orderRefs:[TO],location:"12441"}
      ]}]}]}}});
  assert.equal(result.payload.plan.assignedOrderSnapshots.find(row=>row.id===TO).toRouteProjection.pieces,1);
  const [{orders}]=(await query("SELECT orders FROM dispatch_plan_snapshots WHERE plan_id=$1",[created.id])).rows;
  assert.equal(orders.find(row=>row.id===TO).toRouteProjection.pieces,1);
  const together={...result.payload.plan,orders:[...orders,{id:SO,type:"SO"}],trucks:[{plate:"TEST",loads:[{id:"link-load",stops:[
    {id:"linked-pickup",type:"pick",orderRefs:[SO],location:"2967"},{id:"linked-drop",type:"drop",orderId:SO},
    {id:"remaining-pickup",type:"pick",orderRefs:[TO],location:"2967"},{id:"remaining-drop",type:"drop",orderId:TO}
  ]}]}]};
  assert.deepEqual(await validateDispatchPlanDependencies(together),[]);
  await query("UPDATE dispatch_plans SET status='confirmed' WHERE id=$1",[created.id]);
  const day=await getDriverDayJobs("remaining-driver",{date:"2098-09-02"});
  const drop=day.jobs.find(job=>job.stopType==="dropoff"&&job.orderRefs.includes(TO));
  assert.ok(drop,"confirmed TO remainder reaches Driver");
  assert.deepEqual(drop.orders[0].items.map(item=>item.units),[[{unit:"PCS",value:1}]]);
}));

for (const residualFirst of [false, true]) {
  test(`partial TO completes only after both routes; residual first=${residualFirst}`, () => rollbackTest(async () => {
    const { plan } = await seed();
    if (residualFirst) {
      await driverDrop(plan, TO, "residual-drop", "2098-09-01T19:00:00Z");
      assert.equal((await completion()).length, 0, "remaining-route delivery cannot finish undelivered linked cargo");
    }
    await driverDrop(plan, SO);
    await complete(plan);
    if (!residualFirst) {
      assert.equal((await completion()).length, 0);
      await driverDrop(plan, TO, "residual-drop", "2098-09-01T20:00:00Z");
    }
    const [done] = await completion();
    assert.equal(done.dispatch_completion_status, "completed");
    assert.equal(new Date(done.dispatch_completed_at).toISOString(), residualFirst ? FINISHED : "2098-09-01T20:00:00.000Z");
    await assert.rejects(assertSalesDeliveryPlanningAllowed([TO]));
  }));
}

test("fully allocated TO completes at actual Driver time", () => rollbackTest(async () => {
  const { plan } = await seed({ quantity: 19 });
  await driverDrop(plan, SO);
  await complete(plan);
  const [done] = await completion();
  assert.equal(done.dispatch_completion_status, "completed");
  assert.equal(new Date(done.dispatch_completed_at).toISOString(), FINISHED);
  const [dependency] = (await query("SELECT direct_received_at FROM order_dependencies WHERE transfer_order_ref=$1",[TO])).rows;
  assert.equal(new Date(dependency.direct_received_at).toISOString(),FINISHED);
}));

test("TO receipt caps a reduced source quantity instead of using stale allocation", () => rollbackTest(async () => {
  const { plan } = await seed({ quantity: 19, allocated: 38 });
  await driverDrop(plan, SO);
  await complete(plan);
  const [receipt] = (await query("SELECT received_piece_qty FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='receiving'", [TO_ID])).rows;
  assert.equal(Number(receipt.received_piece_qty), 19);
  const [line] = (await query("SELECT locally_received_quantity FROM order_dependency_lines WHERE item_id=5055")).rows;
  assert.equal(Number(line.locally_received_quantity), 19);
}));

test("TO receipt does not add stock already received through NetSuite", () => rollbackTest(async () => {
  const { plan } = await seed();
  await query("UPDATE transfer_order_lines SET received_piece_qty=20,netsuite_received_qty=20 WHERE transfer_order_id=$1 AND line_stage='receiving'", [TO_ID]);
  await driverDrop(plan, SO);
  await complete(plan);
  const [receipt] = (await query("SELECT received_piece_qty FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='receiving'", [TO_ID])).rows;
  assert.equal(Number(receipt.received_piece_qty), 20);
}));

test("migration excludes old partial TO completion without rewriting its immutable history", () => rollbackTest(async () => {
  const original=await readFile(new URL("../../../migrations/159_dispatch_order_completion_status.sql",import.meta.url),"utf8");
  const start=original.indexOf("CREATE OR REPLACE FUNCTION dispatch_project_direct_dependency_completion()");
  const end=original.indexOf("DROP TRIGGER",start);
  await query(original.slice(start,end));
  const {plan}=await seed();
  await driverDrop(plan,SO);
  await complete(plan);
  const [wrong]=await completion();
  assert.equal(wrong.dispatch_completion_status,"completed");
  const immutable=async()=>(await query("SELECT * FROM dispatch_order_completion_events WHERE id=$1",[wrong.completion_event_id])).rows[0];
  const before=await immutable();
  const migration=await readFile(new URL("../../../migrations/230_direct_ship_lifecycle.sql",import.meta.url),"utf8");
  await query(migration);
  assert.equal((await completion()).length,0);
  assert.deepEqual(await immutable(),before);
  await query(migration);
  assert.equal(Number((await query("SELECT count(*) FROM dispatch_direct_ship_completion_corrections WHERE completion_event_id=$1",[wrong.completion_event_id])).rows[0].count),1);
  await driverDrop(plan,TO,"correct-remaining-drop","2098-09-01T20:00:00Z");
  assert.equal((await completion())[0].completion_evidence_id,"correct-remaining-drop");
}));

test("unknown native TO quantity does not hide known physical cargo",()=>rollbackTest(async()=>{
  const {card}=await seed({quantity:0,allocated:1});
  await query("UPDATE transfer_order_lines SET pallet_qty=3 WHERE transfer_order_id=$1",[TO_ID]);
  card.items[0].pallets=3;
  const [projected]=await enrichDispatchOrdersWithDependencies([card]);
  assert.equal(projected.toRouteProjection.pallets,3);
  assert.equal(projected.dependencyHidden,false);
  await assert.doesNotReject(assertSalesDeliveryPlanningAllowed([TO]));
}));

for (const allocated of [19,20]) {
  test(`a TO group cannot bypass linked-cargo quantities; allocated=${allocated}`,()=>rollbackTest(async()=>{
    const {plan,card}=await seed({allocated});
    const group={id:"GOT-DIRECT-LIFECYCLE",type:"TO",childOrders:[TO],childOrderDetails:[card],items:card.items};
    await query(`INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_id,source_plan_date,full_order,card)
      VALUES ($1,'TO',$2,'2098-09-01',$3::jsonb,$3::jsonb)`,[group.id,plan.id,JSON.stringify(group)]);
    await query("INSERT INTO dispatch_global_order_group_members(group_ref,member_order_ref,position) VALUES ($1,$2,0)",[group.id,TO]);
    await assert.rejects(assertSalesDeliveryPlanningAllowed([group.id]),{code:"DISPATCH_LINKED_CARGO_ONLY"});
  }));
}

test("concurrent direct drop effects create one receipt and one quantity increment", async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,"1");
  const {plan}=await seed();
  await driverDrop(plan,SO);
  const outcomes=await Promise.all([complete(plan),complete(plan)]);
  assert.equal(outcomes.reduce((sum,outcome)=>sum+outcome.completed.length,0),1);
  assert.equal(outcomes.reduce((sum,outcome)=>sum+outcome.alreadyCompleted.length,0),1);
  const [quantity]=(await query("SELECT received_piece_qty FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='receiving'",[TO_ID])).rows;
  assert.equal(Number(quantity.received_piece_qty),19);
  assert.equal(Number((await query("SELECT count(*) FROM order_dependency_receipts WHERE transfer_order_ref=$1",[TO])).rows[0].count),1);
});
