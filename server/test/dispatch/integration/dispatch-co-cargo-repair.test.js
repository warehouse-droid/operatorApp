import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { repairDispatchCoCargo } from "../../../src/dispatch-co-cargo-repair.js";
import { coFixture, staleCoFixture } from "../../support/co-cargo-fixture.mjs";

after(closeDb);

async function fixture(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(async () => {
      const suffix = crypto.randomUUID();
      const full = coFixture(suffix);
      const co = (await query(`INSERT INTO local_co_orders
        (co_ref,source_order_ref,from_location,to_location,status,details)
        VALUES ($1,$2,'2967','12441','pending_load',$3::jsonb) RETURNING id`,
      [full.id,full.sourceOrderId,JSON.stringify({ sourceOrderType: "SO", childOrderIds: full.childOrders, childOrderDetails: full.childOrderDetails })])).rows[0];
      for (const item of full.items) {
        await query(`INSERT INTO local_co_order_lines (co_id,line_id,item_id,sku,quantity,pallet_qty,raw)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [co.id,item.lineId,item.itemId,item.sku,item.quantity,item.pallets,JSON.stringify(item)]);
      }
      const plan = (await query("INSERT INTO dispatch_plans (plan_date,status,revision) VALUES ('2098-10-01','confirmed',7) RETURNING id")).rows[0];
      const trucks = [{ id: "T4", plate: "TEST", loads: [{ id: "L4", name: "Load 4", driverName: "Li", driverLogin: "li", pickupVisitSchemaVersion: 1,
        routeEstimate: { totalMinutes: 30 }, stops: [{ id: "D", type: "drop", orderId: full.id, location: "2967" }] }] },
      { id: "OTHER", loads: [{ id: "OTHER-L", completed: true, stops: [{ id: "KEEP", type: "drop", orderId: "OTHER", status: "completed" }] }] }];
      const orders = [staleCoFixture(suffix), { id: "OTHER", type: "SO", items: [], notes: "Must remain byte-equivalent" }];
      await query(`INSERT INTO dispatch_plan_snapshots (plan_id,orders,trucks,summary)
        VALUES ($1,$2::jsonb,$3::jsonb,'{"stops":2}'::jsonb)`, [plan.id,JSON.stringify(orders),JSON.stringify(trucks)]);
      await query(`INSERT INTO dispatch_global_order_groups (group_ref,order_type,source_plan_id,source_plan_date,full_order,card)
        VALUES ($1,'CO',$2,'2098-10-01',$3::jsonb,$3::jsonb)`, [full.id,plan.id,JSON.stringify(orders[0])]);
      const lines = (await query("SELECT id,line_id,item_id,quantity,pallet_qty FROM local_co_order_lines WHERE co_id=$1 ORDER BY id", [co.id])).rows;
      const target = { planId: plan.id, planDate: "2098-10-01", coRef: full.id, sourceOrderRef: full.sourceOrderId,
        loadId: "L4", driverLogin: "li", fromYard: "2967", toYard: "12441", lines };
      const snapshot = async () => (await query(`SELECT p.revision,s.orders,s.trucks,s.summary FROM dispatch_plans p
        JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1`, [plan.id])).rows[0];
      return operation({ target, full, co, snapshot });
    });
  } finally { await rollback.rollback(); }
}

test("repair dry run is read-only; apply archives and changes only target cargo and its missing pickup; retry is idempotent", async () => fixture(async ({ target, snapshot }) => {
  const before = await snapshot();
  const dry = await repairDispatchCoCargo({ target });
  assert.equal(dry.changed, true);
  assert.deepEqual(await snapshot(), before);
  const applied = await repairDispatchCoCargo({ target, apply: true, expectedRevision: 7, expectedFingerprint: dry.fingerprint });
  const afterState = await snapshot();
  assert.equal(applied.applied, true);
  assert.equal(Number(afterState.revision), 8);
  assert.equal(afterState.orders[0].items.length, 2);
  assert.equal(afterState.orders[0].pallets, 6);
  assert.deepEqual(afterState.orders.slice(1), before.orders.slice(1));
  assert.deepEqual(afterState.trucks.slice(1), before.trucks.slice(1));
  assert.deepEqual(afterState.trucks[0].loads[0].stops.slice(1), before.trucks[0].loads[0].stops);
  assert.equal(afterState.trucks[0].loads[0].stops[0].location, "2967");
  assert.equal(afterState.trucks[0].loads[0].stops[0].type, "pick");
  const history = (await query("SELECT orders,trucks FROM dispatch_plan_snapshot_history WHERE plan_id=$1", [target.planId])).rows;
  assert.equal(history.length, 1);
  assert.deepEqual(history[0], { orders: before.orders, trucks: before.trucks });
  assert.equal((await query("SELECT full_order FROM dispatch_global_order_groups WHERE group_ref=$1", [target.coRef])).rows[0].full_order.items.length, 2);
  assert.equal((await query("SELECT count(*)::int AS n FROM dispatch_audit_log WHERE plan_id=$1 AND action='dispatch.co_cargo_repaired'", [target.planId])).rows[0].n, 1);
  const second = await repairDispatchCoCargo({ target });
  assert.equal(second.changed, false);
  await repairDispatchCoCargo({ target, apply: true, expectedRevision: 8, expectedFingerprint: second.fingerprint });
  assert.deepEqual(await snapshot(), afterState);
}));

test("stale revision, stale fingerprint and unexpected source cargo refuse repair without writes", async () => fixture(async ({ target, snapshot }) => {
  const before = await snapshot();
  const dry = await repairDispatchCoCargo({ target });
  await assert.rejects(repairDispatchCoCargo({ target, apply: true, expectedRevision: 6, expectedFingerprint: dry.fingerprint }), /revision/i);
  await assert.rejects(repairDispatchCoCargo({ target, apply: true, expectedRevision: 7, expectedFingerprint: "wrong" }), /fingerprint/i);
  await assert.rejects(repairDispatchCoCargo({ target: { ...target, lines: [] } }), /source cargo/i);
  assert.deepEqual(await snapshot(), before);
}));

test("loaded cargo and executed target-load evidence block the repair", async () => fixture(async ({ target, co, snapshot }) => {
  const before = await snapshot();
  await query("UPDATE local_co_orders SET loaded_at=now() WHERE id=$1", [co.id]);
  await assert.rejects(repairDispatchCoCargo({ target }), /executed/i);
  await query("UPDATE local_co_orders SET loaded_at=NULL WHERE id=$1", [co.id]);
  await query(`UPDATE dispatch_plan_snapshots SET trucks=jsonb_set(trucks,'{0,loads,0,completed}','true') WHERE plan_id=$1`, [target.planId]);
  await assert.rejects(repairDispatchCoCargo({ target }), /executed/i);
  assert.deepEqual((await snapshot()).orders, before.orders);
}));
