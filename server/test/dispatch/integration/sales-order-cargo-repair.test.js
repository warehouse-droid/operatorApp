import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test, { after } from "node:test";
import { beginRollbackContext, withIndependentTransaction, query, closeDb } from "../../../src/db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "../../../src/dispatch-fleet-status.js";
import { listDispatchOrders } from "../../../src/dispatch-repository.js";
import { repairSob119965Cargo } from "../../../tools/repair-sob119965-cargo.mjs";
import { soLines } from "../../support/sales-order-cargo-fixture.mjs";

after(closeDb);

async function fixture(operation) {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1", "Repair fixtures require an isolated test database");
  const rollback = await beginRollbackContext();
  const directory = await fs.mkdtemp("/tmp/sales-cargo-repair-");
  try {
    return await rollback.run(async () => {
      for (const [id, ref] of [[986406, "SOB119965"], [986405, "SOB119964"]]) {
        await query(`INSERT INTO sales_orders (netsuite_id,tranid,trandate,customer,status,status_text,
          outbound_location_id,outbound_location,sales_order_type,fulfillment_status,operator_status,local_yard_order_status,
          dispatch_address,netsuite_active) VALUES ($1,$2,'2026-09-11','Cargo repair test','B','Pending Fulfillment',
          15,'12441','Delivery','open','open','Open','100 Test Street',true)`, [id,ref]);
      }
      const rows = [...soLines, { transaction_id: 986405, line_id: 4928720, item_id: 1784, item_name: "PALLET", quantity: 12 },
        { transaction_id: 986405, line_id: 4928721, item_id: 1987, item_name: "Delivery Charge", quantity: 1 }];
      for (const row of rows) {
        await query(`INSERT INTO sales_order_lines (sales_order_id,line_id,item_id,item_name,sku,item_type,item_type_text,
          quantity,unit,pallet_qty,layer_qty,pack_quantity_source,netsuite_active,location_id,location,
          packed_sales_qty,loaded_qty) VALUES ($1,$2,$3,$4,$4,'InvtPart','Inventory Item',$5,'EA',$6,$7,'netsuite_manual',true,15,'12441',3,1)`,
        [row.transaction_id,row.line_id,row.item_id,row.item_name,row.quantity,row.pallet_qty || 0,row.layer_qty || 0]);
      }
      const children = await listDispatchOrders({ type: "SO", exactOrderRefs: ["SOB119965", "SOB119964"] });
      assert.equal(children.length, 2);
      const original = { id: "GOB-119964-119965", type: "SO", childOrders: children.map((child) => child.id), childOrderDetails: children,
        items: children.flatMap((child) => child.items), pallets: 8, layers: 5, catalogHydrated: true };
      const reduced = structuredClone(original);
      const keep = (item) => ![4928727,4928728,4928730,4928731,4928732].includes(Number(item.lineId));
      reduced.items = reduced.items.filter(keep);
      reduced.pallets = 0;
      reduced.layers = 0;
      for (const child of reduced.childOrderDetails) {
        child.items = child.items.filter(keep);
        child.pallets = 0;
        child.layers = 0;
      }
      await query("UPDATE sales_order_lines SET netsuite_active=false WHERE sales_order_id=986406 AND line_id NOT IN (4928729,4928733)");
      await query("INSERT INTO dispatch_plans(id,plan_date,status,revision) VALUES (323,'2026-09-11','confirmed',32)");
      const trucks = [{ id: "T4", plate: "TEST", loads: [{ id: "L1", driverLogin: "dao", stops: [
        { id: "P", type: "pick", orderId: original.id }, { id: "D", type: "drop", orderId: original.id }
      ] }] }];
      await query(`INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES (323,$1::jsonb,$2::jsonb,'{"unchanged":true}')`,
        [JSON.stringify([reduced, { id: "OTHER", items: [{ itemId: 42, quantity: 17 }], notes: "keep" }]),JSON.stringify(trucks)]);
      await query(`INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_id,source_plan_date,full_order,card)
        VALUES ($1,'SO',323,'2026-09-11',$2::jsonb,$2::jsonb)`, [original.id,JSON.stringify(reduced)]);
      for (const [index, ref] of original.childOrders.entries()) {
        await query("INSERT INTO dispatch_global_order_group_members(group_ref,member_order_ref,position) VALUES ($1,$2,$3)", [original.id,ref,index]);
      }
      await query("INSERT INTO dispatch_audit_log(id,action,after_state) VALUES (20096,'plan_confirmed',$1::jsonb)", [JSON.stringify({ orders: [original] })]);
      await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,truck_id,truck_plate,load_id,stop_id,
        stop_type,order_refs,status,started_at) VALUES ('cargo-repair-driver',323,'2026-09-11','dao','T4','TEST','L1','P','pickup',$1::jsonb,'in_progress',now())`,
        [JSON.stringify([original.id])]);
      const snapshot = async () => (await query(`SELECT p.revision,s.orders,s.trucks,s.summary FROM dispatch_plans p
        JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=323`)).rows[0];
      return operation({ snapshot, backupPath: `${directory}/before.json` });
    });
  } finally {
    await rollback.rollback();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("SO-03 repair rehearsal rolls back; apply restores only cargo, archives and increments once", async () => fixture(async ({ snapshot, backupPath }) => {
  const before = await snapshot();
  const dry = await repairSob119965Cargo();
  assert.equal(dry.rolledBack, true);
  assert.equal(dry.reactivatedLines, 5);
  assert.deepEqual(await snapshot(), before);
  const applied = await repairSob119965Cargo({ apply: true, expectedRevision: 32, backupPath });
  assert.equal(applied.applied, true);
  assert.equal(applied.driverJobsPreserved, 1);
  const current = await snapshot();
  assert.equal(Number(current.revision), 33);
  assert.equal(current.orders[0].items.length, 9);
  assert.equal(current.orders[0].pallets, 8);
  assert.equal(current.orders[0].layers, 5);
  assert.deepEqual(current.orders.slice(1), before.orders.slice(1));
  assert.deepEqual(current.trucks, before.trucks);
  assert.deepEqual(current.summary, before.summary);
  const competitor = await withIndependentTransaction(async (execute) => (
    await execute("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired", [DISPATCH_FLEET_PLANNING_LOCK])
  ).rows[0]);
  assert.equal(competitor.acquired, false, "a concurrent plan writer must wait for the repair transaction");
  assert.deepEqual(JSON.parse(await fs.readFile(backupPath, "utf8")).plan.orders, before.orders);
  const archive = (await query("SELECT orders,trucks FROM dispatch_plan_snapshot_history WHERE plan_id=323 AND archive_reason='sales_order_cargo_repair'")).rows;
  assert.deepEqual(archive, [{ orders: before.orders, trucks: before.trucks }]);
  const repeat = await repairSob119965Cargo({ apply: true });
  assert.equal(repeat.alreadyCorrect, true);
  assert.equal(repeat.applied, false);
  assert.deepEqual(await snapshot(), current);
}));

test("SO-03 stale revision or changed source quantities refuse the repair", async () => fixture(async ({ snapshot, backupPath }) => {
  const before = await snapshot();
  await assert.rejects(repairSob119965Cargo({ apply: true, expectedRevision: 31, backupPath }), /revision/iu);
  await query("UPDATE sales_order_lines SET quantity=38 WHERE sales_order_id=986406 AND line_id=4928729");
  await assert.rejects(repairSob119965Cargo(), /ordered quantities changed/iu);
  assert.deepEqual(await snapshot(), before);
}));

test("SO-03 a failure after source reactivation rolls back all repair writes", async () => fixture(async ({ snapshot }) => {
  const before = await snapshot();
  await query("DELETE FROM dispatch_global_order_group_members WHERE group_ref='GOB-119964-119965'");
  await assert.rejects(repairSob119965Cargo(), /Expected values/iu);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await query("SELECT count(*)::int AS n FROM sales_order_lines WHERE sales_order_id=986406 AND netsuite_active=false")).rows[0].n, 5);
  assert.equal((await query("SELECT count(*)::int AS n FROM dispatch_plan_snapshot_history WHERE plan_id=323")).rows[0].n, 0);
}));
