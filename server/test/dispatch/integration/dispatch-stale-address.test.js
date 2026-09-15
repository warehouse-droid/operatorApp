import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query, withIndependentTransaction } from "../../../src/db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../../../src/dispatch-fleet-status.js";
import { reconcileDispatchGlobalOrderSources } from "../../../src/dispatch-delivery-group-repository.js";
import { repairCe94487StaleAddress } from "../../../tools/repair-ce94487-stale-address.mjs";

after(closeDb);
const oldAddress = "39 Estoril St, Richmond Hill, ON L4C 0B6";
const newAddress = "145 Valleymede Dr, Richmond Hill, ON L4B 1T3";
async function fixture(operation) {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  const rollback = await beginRollbackContext();
  const directory = await fs.mkdtemp("/tmp/stale-address-test-");
  try { return await rollback.run(async () => {
    const children = [[983941, "SOA08353"], [983943, "SOA08354"]].map(([id, ref]) => ({ id: ref, netsuiteId: id,
      sourceTable: "sales_orders", type: "SO", address: newAddress, destinationAddress: newAddress,
      defaultDestinationAddress: newAddress, items: [{ itemId: id, quantity: 2 }], pallets: 1 }));
    for (const [id, ref, address] of [[983941,"SOA08353",newAddress],[983943,"SOA08354",newAddress],[987526,"SOB120030",oldAddress]]) {
      await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,dispatch_address,netsuite_active)
        VALUES ($1,$2,'Address fixture','B',$3,true)`, [id,ref,address]);
    }
    const group = { ...children[0], id: "GOA-8353-8354", groupKey: children[0].id, destinationAddress: oldAddress,
      defaultDestinationAddress: oldAddress, childOrders: children.map(child=>child.id), childOrderDetails: children,
      raw: { dispatch_address: oldAddress, drop_address: oldAddress, default_drop_address: oldAddress, preserved: 42 } };
    const other = { id: "SOB120030", address: oldAddress, destinationAddress: oldAddress, items: [{ itemId: 456, quantity: 3 }] };
    await query("INSERT INTO dispatch_plans(id,plan_date,status,revision) VALUES (325,'2026-09-12','confirmed',11)");
    // Latest incident state: group is unassigned. Never resurrect its old stop.
    const trucks = [{ id: "T8", plate: "CE94487", loads: [{ id: "L1", driverLogin: "li", stops: [
      { id: "pick", type: "pick", orderId: other.id }, { id: "drop", type: "drop", orderId: other.id }
    ] }] }];
    await query(`INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary)
      VALUES (325,$1::jsonb,$2::jsonb,'{"preserved":true}')`, [JSON.stringify([group,other]),JSON.stringify(trucks)]);
    await query(`INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_id,source_plan_date,full_order,card)
      VALUES ($1,'SO',325,'2026-09-12',$2::jsonb,$2::jsonb)`, [group.id,JSON.stringify(group)]);
    for (const [position,child] of children.entries()) {
      await query("INSERT INTO dispatch_global_order_group_members(group_ref,member_order_ref,position) VALUES ($1,$2,$3)", [group.id,child.id,position]);
    }
    const snapshot = async()=> (await query(`SELECT p.revision,s.orders,s.trucks,s.summary FROM dispatch_plans p
      JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=325`)).rows[0];
    return operation({ snapshot, children, group, backupPath: `${directory}/before.json` });
  }); } finally { await rollback.rollback(); await fs.rm(directory,{recursive:true,force:true}); }
}

test("SA-2 real source refresh repairs the global group and its compact card", async()=>fixture(async ({ children,group })=>{
  await reconcileDispatchGlobalOrderSources({ orders: children });
  const row = (await query("SELECT full_order,card FROM dispatch_global_order_groups WHERE group_ref=$1", [group.id])).rows[0];
  assert.equal(row.full_order.destinationAddress,newAddress);
  assert.equal(row.card.destinationAddress,newAddress);
  assert.deepEqual(row.full_order.childOrderDetails,children.map(child=>({...child,pickupLocations:[],sourceYard:"",notes:"",transitCo:null})));
}));

test("SA-4 repair rolls back by default, applies once, archives and preserves assignments and cargo", async()=>fixture(async({snapshot,backupPath})=>{
  const before = await snapshot();
  assert.equal((await repairCe94487StaleAddress()).rolledBack,true);
  assert.deepEqual(await snapshot(),before);
  const result = await repairCe94487StaleAddress({apply:true,expectedRevision:11,backupPath});
  assert.equal(result.applied,true);
  const current = await snapshot();
  assert.equal(Number(current.revision),12);
  assert.equal(current.orders[0].destinationAddress,newAddress);
  assert.deepEqual(current.trucks,before.trucks);
  assert.deepEqual(current.summary,before.summary);
  assert.deepEqual(current.orders.slice(1),before.orders.slice(1));
  assert.deepEqual(current.orders[0].items,before.orders[0].items);
  assert.deepEqual(current.orders[0].childOrders,before.orders[0].childOrders);
  assert.deepEqual(JSON.parse(await fs.readFile(backupPath,'utf8')).plan.orders,before.orders);
  assert.equal((await query("SELECT count(*)::int AS n FROM dispatch_plan_snapshot_history WHERE plan_id=325 AND archive_reason='stale_delivery_address_repair'")).rows[0].n,1);
  assert.equal((await query("SELECT count(*)::int AS n FROM dispatch_audit_log WHERE plan_id=325 AND action='dispatch.stale_delivery_address_repaired'")).rows[0].n,1);
  const competitor = await withIndependentTransaction(async execute=>(await execute("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",[DISPATCH_FLEET_PLANNING_LOCK])).rows[0]);
  assert.equal(competitor.acquired,false);
  assert.equal((await repairCe94487StaleAddress({apply:true})).alreadyCorrect,true);
  assert.deepEqual(await snapshot(),current);
}));

test("SA-4 stale revision and changed authoritative address refuse repair without changing the plan", async()=>fixture(async({snapshot,backupPath})=>{
  const before = await snapshot();
  await assert.rejects(repairCe94487StaleAddress({apply:true,expectedRevision:10,backupPath}),/revision/iu);
  await query("UPDATE sales_orders SET dispatch_address='Different now' WHERE tranid='SOA08353'");
  await assert.rejects(repairCe94487StaleAddress(),/source address/iu);
  assert.deepEqual(await snapshot(),before);
}));

test("SA-4 started driver work prevents address repair", async()=>fixture(async({snapshot})=>{
  await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,truck_id,truck_plate,load_id,stop_id,stop_type,order_refs,status,started_at)
    VALUES ('address-test',325,'2026-09-12','li','T8','CE94487','L1','pick','pickup','["SOB120030"]','in_progress',now())`);
  const before = await snapshot();
  await assert.rejects(repairCe94487StaleAddress(),/started driver/iu);
  assert.deepEqual(await snapshot(),before);
}));

test("SA-4 a late failure rolls back group, snapshot, revision and history", async()=>fixture(async({snapshot,backupPath})=>{
  const before = await snapshot();
  await query(`CREATE FUNCTION pg_temp.fail_address_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='dispatch.stale_delivery_address_repaired' THEN RAISE EXCEPTION 'injected address audit failure'; END IF; RETURN NEW; END $$`);
  await query("CREATE TRIGGER fail_address_audit BEFORE INSERT ON dispatch_audit_log FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_address_audit()");
  await assert.rejects(repairCe94487StaleAddress({apply:true,expectedRevision:11,backupPath}),/injected address audit failure/iu);
  assert.deepEqual(await snapshot(),before);
  assert.equal((await query("SELECT full_order->>'destinationAddress' AS address FROM dispatch_global_order_groups WHERE group_ref='GOA-8353-8354'")).rows[0].address,oldAddress);
  assert.equal((await query("SELECT count(*)::int AS n FROM dispatch_plan_snapshot_history WHERE plan_id=325")).rows[0].n,0);
}));

test("SA-4 assigned drops use an exact-revision timing projection and preserve stop identities", async()=>fixture(async({snapshot,backupPath})=>{
  const initial=await snapshot();
  const trucks=structuredClone(initial.trucks);
  trucks[0].loads[0].stops.push({id:"group-drop",type:"drop",orderId:"GOA-8353-8354"});
  trucks[0].loads[0].routeEstimate={routeSignature:"stale combined destination"};
  await query("UPDATE dispatch_plan_snapshots SET trucks=$1::jsonb WHERE plan_id=325",[JSON.stringify(trucks)]);
  const before=await snapshot();
  const timingProjection={revision:11,beforeTrucks:trucks,loads:[{id:"L1",timing:{start:420,finish:600},
    plannedStartMinute:420,plannedFinishMinute:600,stops:[{id:"pick",timing:{arrival:445,depart:485}},
      {id:"drop",timing:{arrival:515,depart:540}},{id:"group-drop",timing:{arrival:570,depart:600}}]}]};
  await assert.rejects(repairCe94487StaleAddress(),/timing projection/iu);
  await assert.rejects(repairCe94487StaleAddress({timingProjection:{...timingProjection,revision:10}}),/revision/iu);
  const bad=structuredClone(timingProjection);
  bad.loads[0].stops[2].timing.arrival=539;
  await assert.rejects(repairCe94487StaleAddress({timingProjection:bad}),/overlap/iu);
  const moved=structuredClone(timingProjection);
  moved.loads[0].stops[1].id="another-stop";
  await assert.rejects(repairCe94487StaleAddress({timingProjection:moved}),/identities/iu);
  const changed=structuredClone(timingProjection);
  changed.beforeTrucks[0].loads[0].stops.reverse();
  await assert.rejects(repairCe94487StaleAddress({timingProjection:changed}),/assignments changed/iu);
  assert.deepEqual(await snapshot(),before);
  const result=await repairCe94487StaleAddress({apply:true,expectedRevision:11,backupPath,timingProjection});
  assert.equal(result.applied,true);
  const repaired=await snapshot();
  assert.deepEqual(repaired.trucks[0].loads[0].stops.map(({timing:_timing,...stop})=>stop),before.trucks[0].loads[0].stops);
  assert.deepEqual(repaired.trucks[0].loads[0].stops.map(stop=>stop.timing),timingProjection.loads[0].stops.map(stop=>stop.timing));
  assert.equal(repaired.trucks[0].loads[0].routeEstimate,undefined);
  assert.deepEqual(repaired.orders[0].items,before.orders[0].items);
}));
