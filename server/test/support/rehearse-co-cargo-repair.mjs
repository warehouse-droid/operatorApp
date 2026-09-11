import assert from "node:assert/strict";
import fs from "node:fs";
import { beginRollbackContext, closeDb, query } from "../../src/db.js";
import { repairDispatchCoCargo } from "../../src/dispatch-co-cargo-repair.js";
import { syncDispatchPlanLoadAssignments } from "../../src/dispatch-load-assignment-repository.js";

assert.equal(process.env.MBT_TEST_ISOLATED, "1", "Realistic repair rehearsal requires the isolated test database");
const { plan, co, lines, global: definition } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const target = { planId: plan.id, planDate: plan.planDate, coRef: co.co_ref, sourceOrderRef: co.source_order_ref,
  fromYard: co.from_location, toYard: co.to_location, driverLogin: "li", loadId: "T4-L1788581352764-2a46c025e1ae78", lines };
const rollback = await beginRollbackContext();
try {
  await rollback.run(async () => {
    await query("INSERT INTO dispatch_plans (id,plan_date,status,revision) VALUES ($1,$2,$3,$4)", [plan.id,plan.planDate,plan.status,plan.revision]);
    await query("INSERT INTO dispatch_plan_snapshots (plan_id,orders,trucks,summary,saved_at) VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5)",
      [plan.id,JSON.stringify(plan.orders),JSON.stringify(plan.trucks),JSON.stringify(plan.summary),plan.saved_at]);
    await query(`INSERT INTO local_co_orders (id,co_ref,source_order_ref,from_location,to_location,status,details)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [co.id,co.co_ref,co.source_order_ref,co.from_location,co.to_location,co.status,JSON.stringify(co.details)]);
    for (const line of lines) {
      await query(`INSERT INTO local_co_order_lines (id,co_id,line_id,item_id,sku,item_name,item_type,item_type_text,item_description,unit,
        quantity,pallet_qty,layer_qty,section_qty,piece_qty,item_weight,raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
      [line.id,co.id,line.line_id,line.item_id,line.sku,line.item_name,line.item_type,line.item_type_text,line.item_description,line.unit,
        line.quantity,line.pallet_qty,line.layer_qty,line.section_qty,line.piece_qty,line.item_weight,JSON.stringify(line.raw)]);
    }
    await query(`INSERT INTO dispatch_global_order_groups (group_ref,order_type,source_plan_id,source_plan_date,full_order,card)
      VALUES ($1,'CO',$2,$3,$4::jsonb,$5::jsonb)`, [co.co_ref,plan.id,plan.planDate,JSON.stringify(definition.full_order),JSON.stringify(definition.card)]);
    const assignments = async () => (await query(`SELECT load_id,driver_login,truck_plate,planned_start_minute,planned_finish_minute,driver_sequence,started,completed
      FROM dispatch_plan_load_assignments WHERE plan_id=$1 AND load_id<>$2 ORDER BY load_id`, [plan.id,target.loadId])).rows;
    await syncDispatchPlanLoadAssignments(plan);
    const beforeAssignments = await assignments();
    const dry = await repairDispatchCoCargo({ target });
    const result = await repairDispatchCoCargo({ target, apply: true, expectedRevision: plan.revision, expectedFingerprint: dry.fingerprint });
    assert.equal(result.applied, true);
    const saved = (await query("SELECT orders,trucks FROM dispatch_plan_snapshots WHERE plan_id=$1", [plan.id])).rows[0];
    assert.deepEqual(saved.orders.filter((order) => order.id !== co.co_ref), plan.orders.filter((order) => order.id !== co.co_ref));
    const restored = saved.orders.find((order) => order.id === co.co_ref);
    assert.equal(restored.items.length, 2);
    assert.equal(restored.pallets, 6);
    const normalizedTrucks = structuredClone(saved.trucks);
    const repairedLoad = normalizedTrucks.flatMap((truck) => truck.loads).find((load) => load.id === target.loadId);
    const originalLoad = plan.trucks.flatMap((truck) => truck.loads).find((load) => load.id === target.loadId);
    assert.equal(repairedLoad.stops[0].type, "pick");
    assert.equal(repairedLoad.stops[0].location, "2967");
    assert.equal(repairedLoad.stops[1].id, originalLoad.stops[0].id);
    repairedLoad.stops.shift();
    repairedLoad.routeEstimate = originalLoad.routeEstimate;
    assert.deepEqual(normalizedTrucks, plan.trucks);
    assert.deepEqual(await assignments(), beforeAssignments);
    assert.equal((await repairDispatchCoCargo({ target })).changed, false);
    console.log(JSON.stringify({ productionFixtureRehearsal: "passed", fromRevision: Number(plan.revision), toRevision: result.revision,
      cargoLines: restored.items.length, pallets: restored.pallets, unrelatedLoadAssignmentsPreserved: beforeAssignments.length }));
  });
} finally {
  await rollback.rollback();
  await closeDb();
}
