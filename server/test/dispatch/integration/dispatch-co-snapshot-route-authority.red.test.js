import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { reconcileDispatchPlanLocalCos } from "../../../src/dispatch-co-lifecycle.js";

after(closeDb);

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

test("an active local CO row repairs a stale standalone CO snapshot route without changing plan evidence", async () => {
  await inRollback(async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const sourceRef = `GOA-CO-ROUTE-${suffix}`;
    const coRef = `CO-${sourceRef}`;
    const childRefs = [`SOA-CO-ROUTE-A-${suffix}`, `SOA-CO-ROUTE-B-${suffix}`];
    await query(
      `INSERT INTO local_co_orders (
         co_ref, source_order_ref, from_location_id, from_location,
         to_location_id, to_location, status, delivery_order_id,
         created_by, details
       ) VALUES ($1, $2, 28, '2967', 15, '12441', 'pending_load', $3, 'co-route-authority-test', $4::jsonb)`,
      [coRef, sourceRef, -9_800_000_000, JSON.stringify({ testOnly: true })]
    );
    const staleCo = {
      id: coRef,
      type: "CO",
      sourceYard: "2967",
      pickupLocations: ["2967"],
      sourceAddress: "2967 Kennedy Road, Toronto, ON",
      destinationYard: "3445",
      destinationLocationId: "1",
      address: "3445 Kennedy Road, Toronto, ON",
      destinationAddress: "3445 Kennedy Road, Toronto, ON",
      sourceOrderId: "",
      childOrders: childRefs,
      childOrderDetails: childRefs.map((id) => ({ id, type: "CO" })),
      localDispatchStatus: "open",
      arbitraryPlanEvidence: { keep: true }
    };
    const trucks = [{
      id: `TRUCK-${suffix}`,
      loads: [{
        id: `LOAD-${suffix}`,
        stops: [{ id: `STOP-${suffix}`, type: "drop", orderId: coRef }]
      }]
    }];
    const plan = {
      id: "265",
      planDate: "2026-09-01",
      orders: [staleCo],
      trucks
    };
    const before = structuredClone(plan);

    const reconciled = await reconcileDispatchPlanLocalCos(plan);
    const repaired = reconciled.orders[0];

    assert.equal(repaired.sourceYard, "2967");
    assert.deepEqual(repaired.pickupLocations, ["2967"]);
    assert.equal(repaired.destinationYard, "12441");
    assert.equal(Number(repaired.destinationLocationId), 15);
    assert.equal(repaired.sourceOrderId, sourceRef);
    assert.equal(repaired.address, "12441 Woodbine Avenue, Whitchurch-Stouffville, ON");
    assert.equal(repaired.destinationAddress, "12441 Woodbine Avenue, Whitchurch-Stouffville, ON");
    assert.equal(repaired.localYardOrderStatus, "pending_load");
    assert.deepEqual(repaired.childOrders, childRefs);
    assert.deepEqual(repaired.arbitraryPlanEvidence, { keep: true });
    assert.deepEqual(reconciled.trucks, trucks);
    assert.deepEqual(plan, before, "reconciliation must not mutate saved or archived snapshot bytes");

    const repeated = await reconcileDispatchPlanLocalCos(reconciled);
    assert.deepEqual(repeated, reconciled, "reconciliation must be idempotent");
  });
});

test("an active local CO read overlay preserves a linked PO vendor pickup", async () => {
  await inRollback(async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const sourceRef = `GOB-PO-CO-${suffix}`;
    const coRef = `CO-${sourceRef}`;
    await query(
      `INSERT INTO local_co_orders (
         co_ref, source_order_ref, from_location_id, from_location,
         to_location_id, to_location, status, delivery_order_id,
         created_by, details
       ) VALUES ($1, $2, 1, '3445', 15, '12441', 'pending_load', $3, 'po-co-route-test', $4::jsonb)`,
      [coRef, sourceRef, -9_810_000_000, JSON.stringify({ testOnly: true })]
    );
    const order = {
      id: sourceRef,
      type: "SO",
      sourceYard: "3445",
      pickupLocations: ["3445", "TECHO BLOC Vaughan"],
      poPickupManifest: [{
        poOrderRef: "LOINC-030542",
        location: "TECHO BLOC Vaughan",
        address: "720 Arrow Rd. North York, ON M9M 2M1"
      }],
      transitCo: {
        id: coRef,
        fromYard: "3445",
        toYard: "12441",
        sourceOrderId: sourceRef
      },
      childOrders: [`SO-A-${suffix}`, `SO-B-${suffix}`],
      childOrderDetails: []
    };
    const plan = {
      id: "267",
      planDate: "2026-09-03",
      orders: [order],
      trucks: [{
        id: `TRUCK-${suffix}`,
        loads: [{
          id: `LOAD-${suffix}`,
          stops: [
            { id: `PICK-YARD-${suffix}`, type: "pick", orderId: sourceRef, location: "12441" },
            { id: `PICK-PO-${suffix}`, type: "pick", orderId: sourceRef, location: "TECHO BLOC Vaughan" },
            { id: `DROP-${suffix}`, type: "drop", orderId: sourceRef }
          ]
        }]
      }]
    };

    const reconciled = await reconcileDispatchPlanLocalCos(plan);
    const projected = reconciled.orders[0];

    assert.deepEqual(projected.pickupLocations, ["12441", "TECHO BLOC Vaughan"]);
    assert.deepEqual(projected.poPickupManifest, order.poPickupManifest);
    assert.deepEqual(projected.transitOriginalPickupLocations, ["3445"]);
    assert.deepEqual(reconciled.trucks, plan.trucks, "the read overlay must not remove the vendor stop");
    assert.deepEqual(await reconcileDispatchPlanLocalCos(reconciled), reconciled);
  });
});

test("a cancelled local CO removes a legacy aggregate-classified standalone card and its plan references", async () => {
  await inRollback(async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const sourceRef = `GOA-CO-CANCEL-${suffix}`;
    const coRef = `CO-${sourceRef}`;
    const unrelatedRef = `SOA-CO-KEEP-${suffix}`;
    const childRefs = [`SOA-CO-CANCEL-A-${suffix}`, `SOA-CO-CANCEL-B-${suffix}`];
    await query(
      `INSERT INTO local_co_orders (
         co_ref, source_order_ref, from_location_id, from_location,
         to_location_id, to_location, status, delivery_order_id,
         created_by, details
       ) VALUES ($1, $2, 28, '2967', 15, '12441', 'cancelled', $3, 'co-cancel-authority-test', $4::jsonb)`,
      [coRef, sourceRef, -9_800_000_001, JSON.stringify({ testOnly: true })]
    );
    const staleCo = {
      id: coRef,
      type: "CO",
      sourceYard: "2967",
      destinationYard: "3445",
      childOrders: childRefs,
      childOrderDetails: childRefs.map((id) => ({ id, type: "CO" })),
      globalGroupDefinition: true
    };
    const unrelated = { id: unrelatedRef, type: "SO", address: "Keep this order" };
    const plan = {
      id: "265",
      planDate: "2026-09-01",
      orders: [staleCo, unrelated],
      trucks: [{
        id: `TRUCK-${suffix}`,
        loads: [{
          id: `LOAD-${suffix}`,
          orders: [coRef, unrelatedRef],
          stops: [
            { id: `STOP-CO-${suffix}`, type: "drop", orderId: coRef },
            { id: `STOP-KEEP-${suffix}`, type: "drop", orderId: unrelatedRef }
          ]
        }]
      }]
    };
    const before = structuredClone(plan);

    const reconciled = await reconcileDispatchPlanLocalCos(plan);

    assert.deepEqual(reconciled.orders.map((order) => order.id), [unrelatedRef]);
    assert.deepEqual(reconciled.trucks[0].loads[0].orders, [unrelatedRef]);
    assert.deepEqual(reconciled.trucks[0].loads[0].stops.map((stop) => stop.orderId), [unrelatedRef]);
    assert.deepEqual(plan, before, "cancelled-card reconciliation must not mutate the saved snapshot input");
    assert.deepEqual(await reconcileDispatchPlanLocalCos(reconciled), reconciled,
      "cancelled-card reconciliation must be idempotent");
  });
});
