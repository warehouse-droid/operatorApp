import assert from "node:assert/strict";
import { query, withTransaction, closeDb } from "../src/db.js";
import { getDispatchPlan } from "../src/dispatch-plan-repository.js";
import { dispatchPhysicalStopVisits, dispatchRequiredPickupLocations } from "../src/dispatch-load-assignment.js";
import { pickupUi } from "../test/support/direct-to-same-yard-fixture.mjs";

try {
  await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const assignment = (await query(`SELECT plan_id FROM dispatch_plan_order_assignments
      WHERE order_ref='SOA08838' ORDER BY plan_date DESC,plan_id DESC LIMIT 1`)).rows[0];
    assert.ok(assignment);
    const plan = await getDispatchPlan(assignment.plan_id);
    const order = plan.orders.find(row => row.id === "SOA08838");
    const ui = pickupUi();
    const original = structuredClone(order);
    const pickup = ui.tooltipItemsForOrder(order, { pickupLocation: "3445" });
    const material = pickup.filter(item => Number(item.itemId) === 1356);
    assert.equal(material.length, 1);
    assert.equal(Number(material[0].quantity), 52.25);
    assert.equal(Number(material[0].layers), 5);
    const html = ui.tooltipItemRowsForOrder(order, { pickupLocation: "3445", includeOrderHeader: true });
    assert.equal((html.match(/<b>TOB01102<\/b>/gu) || []).length, 1);
    assert.match(html, /For SOA08838/u);
    assert.equal((html.match(/<b>BWS-TRE50S-RDM-CAR<\/b>/gu) || []).length, 1);
    const drop = ui.tooltipItemsForOrder(order, { stop: { type: "drop" } });
    assert.equal(drop.find(item => Number(item.itemId) === 1356)?.quantity, 52.25);
    for (const item of drop.filter(row => Number(row.itemId) !== 1356)) {
      assert.equal(pickup.filter(row => Number(row.itemId) === Number(item.itemId))
        .reduce((sum, row) => sum + Number(row.quantity), 0), Number(item.quantity));
    }
    assert.ok(dispatchRequiredPickupLocations(plan, order).includes("3445"));
    const truck = plan.trucks.find(row => row.loads.some(load => load.stops.some(stop => stop.orderId === order.id)));
    const load = truck.loads.find(row => row.stops.some(stop => stop.orderId === order.id));
    const visit = dispatchPhysicalStopVisits(plan, truck, load).find(row => row.type === "pick" && row.entries.some(entry => entry.stop.location === "3445"));
    assert.ok(visit.pallets > 0);
    assert.deepEqual(order, original);
    console.log(JSON.stringify({ salesOrder: order.id, transferOrder: "TOB01102", planId: plan.id,
      revision: plan.revision, pickupQuantity: Number(material[0].quantity), pickupLayers: Number(material[0].layers),
      pickupRows: pickup.length, pickupWeightLbs: ui.pickupWeightForOrderLocation(order, "3445"),
      dropRows: drop.length, toHeaderCount: 1, sourceCo: order.transitCo?.id || "", inputUnchanged: true }));
  });
} finally {await closeDb();}
