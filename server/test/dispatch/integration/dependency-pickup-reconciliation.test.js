import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { resolveDispatchSalesTarget } from "../../../src/dispatch-order-target-repository.js";
import { getDispatchPlan } from "../../../src/dispatch-plan-repository.js";
import { createOrderDependency, enrichDispatchOrdersWithDependencies } from "../../../src/order-dependency-repository.js";
import { executeScmDependencyCommand, scmDependencyPayloadHash } from "../../../src/scm-dependency-command-service.js";
import { validateDispatchPickupVisits } from "../../../src/dispatch-pickup-visits.js";

after(closeDb);
const date = "2099-10-30";
async function seed() {
  const base = 8_500_000_000 + Number.parseInt(crypto.randomBytes(4).toString("hex"), 16);
  await query("INSERT INTO dispatch_trucks(plate,active) VALUES('TEST-PLATE',true)");
  const salesRef = `SOA${base}`, transferRef = `TOB${base}`, groupRef = `GOA-${base}`;
  await query(`INSERT INTO inventory_items(item_id,item_name,item_type,stock_unit,to_pcs)
    VALUES($1,'Dependency pickup fixture','InvtPart','EA',1)`, [base]);
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,trandate,customer,status,status_text,
    outbound_location_id,outbound_location,sales_order_type,fulfillment_status,
    operator_status,local_yard_order_status,dispatch_address,netsuite_active)
    VALUES($1,$2,current_date,'Synthetic fixture','B','Sales Order : Pending Fulfillment',
      1,'3445','Delivery','open','open','Open','100 Test Street',true)`, [base + 1, salesRef]);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,
    item_type,quantity,unit,piece_qty,to_pcs,netsuite_backordered_qty,netsuite_active)
    VALUES($1,1,$2,'Fixture','FIXTURE','InvtPart',10,'EA',10,1,10,true)`, [base + 1, base]);
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,trandate,status,status_text,
    from_location_id,from_location,to_location_id,to_location,outbound_operator_status,
    local_yard_order_status,fulfillment_status,receiving_status,dispatch_planned,netsuite_active)
    VALUES($1,$2,current_date,'B','Transfer Order : Pending Fulfillment',28,'2967',1,'3445',
      'open','Open','not_fulfilled','pending',false,true)`, [base + 2, transferRef]);
  await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_id,item_id,item_name,sku,
    item_type,quantity,unit,piece_qty,to_pcs,netsuite_active,line_stage)
    SELECT $1,1,$2,'Fixture','FIXTURE','InvtPart',5,'EA',5,1,true,stage
    FROM unnest(ARRAY['outbound','receiving']) stage`, [base + 2, base]);
  const child = { id: salesRef, type: "SO", sourceYard: "3445", pickupLocations: ["3445"],
    address: "100 Test Street", items: [{ itemId: base, quantity: 10, pieces: 10, unit: "EA" }] };
  const group = { ...child, id: groupRef, childOrders: [salesRef], childOrderDetails: [child] };
  const transfer = { id: transferRef, type: "TO", sourceYard: "2967", destinationYard: "3445",
    pickupLocations: ["2967"], items: [{ itemId: base, quantity: 5, pieces: 5, unit: "EA" }] };
  const planId = (await query(`INSERT INTO dispatch_plans(plan_date,status,revision)
    VALUES($1,'draft',0) RETURNING id`, [date])).rows[0].id;
  await query(`INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2,'[]','{}')`,
    [planId, JSON.stringify([group, transfer])]);
  const target = await resolveDispatchSalesTarget({ dispatchTargetRef: groupRef, planDate: date });
  const dependency = await createOrderDependency({ dispatchTargetRef: groupRef, transferOrderRef: transferRef,
    planDate: date, mode: "direct_to_customer",
    allocations: [{ targetLineKey: target.lines[0].targetLineKey, quantities: { pieces: 5 } }] });
  const orders = await enrichDispatchOrdersWithDependencies([group, transfer]);
  const trucks = [{ id: "TEST-TRUCK", plate: "TEST-PLATE", loads: [{ id: "TEST-LOAD", pickupVisitSchemaVersion: 1, stops: [
    { id: "to-pick", type: "pick", location: "2967", orderId: transferRef, orderRefs: [transferRef] },
    { id: "to-drop", type: "drop", orderId: transferRef, location: "3445" },
    { id: "group-native", type: "pick", location: "3445", orderId: groupRef, orderRefs: [groupRef] },
    { id: "group-direct", type: "pick", location: "2967", orderId: groupRef, orderRefs: [groupRef] },
    { id: "group-drop", type: "drop", orderId: groupRef, location: "100 Test Street" }
  ] }] }];
  await query("UPDATE dispatch_plan_snapshots SET orders=$2,trucks=$3 WHERE plan_id=$1", [planId, JSON.stringify(orders), JSON.stringify(trucks)]);
  await query("UPDATE order_dependencies SET planned_plan_id=$2 WHERE id=$1", [dependency.id, planId]);
  return { planId, dependency, groupRef };
}
async function execute(fixture, action, extra = {}) {
  const plan = await getDispatchPlan(fixture.planId);
  const command = { requestId: crypto.randomUUID(), action, targetRef: fixture.groupRef, planDate: date,
    planId: fixture.planId, expectedPlanRevision: plan.revision, expectedPlanDigest: plan.digest,
    payload: { dependencyId: fixture.dependency.id, mode: "yard_replenishment" }, ...extra };
  command.payloadHash = scmDependencyPayloadHash(command);
  return executeScmDependencyCommand(command, { id: "dependency-regression", sessionId: "dependency-regression" });
}
for (const action of ["unlink_to", "change_mode"]) {
  test(`${action} commits the grouped relationship and removes its obsolete explicit pickup`, async () => {
    const context = await beginRollbackContext();
    try {
      await context.run(async () => {
        const fixture = await seed();
        const result = await execute(fixture, action);
        assert.equal(result.status, "applied");
        const saved = await getDispatchPlan(fixture.planId);
        const stops = saved.trucks.flatMap(truck => truck.loads.flatMap(load => load.stops));
        assert.equal(stops.some(stop => stop.id === "group-direct"), false);
        assert.ok(stops.some(stop => stop.id === "group-native"));
        assert.ok(stops.some(stop => stop.id === "to-pick"));
        assert.deepEqual(validateDispatchPickupVisits(saved), []);
        const row = (await query("SELECT status,dependency_mode FROM order_dependencies WHERE id=$1", [fixture.dependency.id])).rows[0];
        assert.equal(action === "unlink_to" ? row.status : row.dependency_mode,
          action === "unlink_to" ? "cancelled" : "yard_replenishment");
      });
    } finally { await context.rollback(); }
  });
}

test("stale dependency commands leave both relationship and saved route unchanged", async () => {
  const context = await beginRollbackContext();
  try {
    await context.run(async () => {
      const fixture = await seed();
      const snapshot = async () => (await query("SELECT orders,trucks FROM dispatch_plan_snapshots WHERE plan_id=$1", [fixture.planId])).rows[0];
      const before = await snapshot();
      await assert.rejects(execute(fixture, "unlink_to", { expectedPlanRevision: -1 }), error => error.status === 409);
      assert.deepEqual(await snapshot(), before);
      assert.equal((await query("SELECT status FROM order_dependencies WHERE id=$1", [fixture.dependency.id])).rows[0].status, "active");
    });
  } finally { await context.rollback(); }
});
