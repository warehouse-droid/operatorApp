import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { cancelDispatchCoGlobally } from "../../../src/dispatch-co-lifecycle.js";
import { listDriverPwaCompletedDispatchRefs } from "../../../src/dispatch-history-mode.js";
import { listDispatchOrders, upsertLocalCoOrder } from "../../../src/dispatch-repository.js";
import { findDispatchCoSequenceConflicts } from "../../../src/server.js";
import {
  confirmLocalCoReceivingLine,
  listLocalCoReceivingOrders,
  receiveLocalCoOrder
} from "../../../src/receiving-repository.js";

after(closeDb);

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

function fixtureIdentity(label) {
  const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
  return {
    coRef: `CO-SO-${label}-${suffix}`,
    soRef: `SO-${label}-${suffix}`,
    jobId: `CO-COMPLETION-${label}-${suffix}`
  };
}

async function insertSalesOrder(soRef) {
  const orderId = 9_993_000_000 + Math.floor(Math.random() * 100_000);
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, customer, status, status_text,
       fulfillment_status, outbound_location_id, outbound_location,
       sales_order_type, dispatch_address, netsuite_active, synced_at
     ) VALUES (
       $1, $2, 'CO completion customer', 'B', 'Sales Order : Pending Fulfillment',
       'not_fulfilled', 28, '2967',
       'Delivery', '41 Completion Way, Markham, ON', true, now()
     )`,
    [orderId, soRef]
  );
  await query(
    `INSERT INTO sales_order_lines (
       id, sales_order_id, line_id, item_id, item_name, sku,
       quantity, unit, pallet_qty, netsuite_active, synced_at
     ) VALUES ($1, $2, 1, 991001, 'CO lifecycle fixture', 'CO-LIFECYCLE', 1, 'EA', 1, true, now())`,
    [orderId + 100_000, orderId]
  );
}

async function insertLocalCo({ coRef, soRef, status = "pending_load", updatedAt, details = {} }) {
  const inserted = await query(
    `INSERT INTO local_co_orders (
       co_ref, source_order_ref, from_location_id, from_location,
       to_location_id, to_location, status, delivery_order_id,
       created_by, created_at, updated_at, details
     ) VALUES (
       $1, $2, 28, '2967', 15, '12441', $3,
       -9993000000 - nextval('local_co_orders_id_seq'),
       'co-completion-test', $4::timestamptz, $4::timestamptz, $5::jsonb
     )
     RETURNING id`,
    [coRef, soRef, status, updatedAt, JSON.stringify(details)]
  );
  const line = await query(
    `INSERT INTO local_co_order_lines (
       co_id, line_id, item_id, item_name, sku, quantity, unit,
       item_weight, pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs, raw
     ) VALUES ($1, 1, 991001, 'CO lifecycle fixture', 'CO-LIFECYCLE', 1, 'EA',
               10, 1, 0, 0, 0, 1, 0, 0, 0, '{}'::jsonb)
     RETURNING id`,
    [inserted.rows[0].id]
  );
  return { coId: inserted.rows[0].id, lineId: line.rows[0].id };
}

async function insertDriverStop({
  coRef,
  jobId,
  stopType = "dropoff",
  status = "complete",
  completedAt = "2039-10-01T16:00:00.000Z"
}) {
  await query(
    `INSERT INTO driver_job_records (
       job_id, plan_date, driver_login, truck_plate, load_id, load_name,
       stop_id, stop_type, order_refs, status, started_at, completed_at, job_details
     ) VALUES (
       $1, $2::date, 'co-completion-driver', 'CO-001', $3, 'CO Completion Load',
       $4, $5, $6::jsonb, $7, $8::timestamptz, $8::timestamptz, $9::jsonb
     )`,
    [
      jobId,
      completedAt.slice(0, 10),
      `LOAD-${jobId}`,
      `STOP-${jobId}`,
      stopType,
      JSON.stringify([coRef]),
      status,
      completedAt,
      JSON.stringify({
        location: stopType === "dropoff" ? "12441" : "2967",
        address: stopType === "dropoff"
          ? "12441 Woodbine Avenue, Whitchurch-Stouffville, ON"
          : "2967 Kennedy Road, Toronto, ON",
        orderTypes: ["CO"],
        orders: [{ orderRef: coRef, orderType: "CO_ORDER", source: "local_co" }]
      })
    ]
  );
}

test("a completed CO drop terminalizes only the transfer leg and keeps the source SO available from its destination yard", async () => {
  await inRollback(async () => {
    const identity = fixtureIdentity("DROP");
    const completedAt = "2039-10-01T16:00:00.000Z";
    await insertSalesOrder(identity.soRef);
    const localCo = await insertLocalCo({
      ...identity,
      updatedAt: "2039-10-01T12:00:00.000Z",
      details: { sourceOrderId: identity.soRef, sourceOrderType: "SO" }
    });

    const before = await listDispatchOrders({
      exactOrderRefs: [identity.soRef, identity.coRef],
      unboundedPerType: true
    });
    assert.ok(before.some((order) => order.id === identity.coRef));
    assert.ok(before.some((order) => order.id === identity.soRef));

    await insertDriverStop({ ...identity, completedAt });

    const local = (await query(
      `SELECT status, details
         FROM local_co_orders
        WHERE co_ref = $1`,
      [identity.coRef]
    )).rows[0];
    const canonical = (await query(
      `SELECT status, details
         FROM co_orders
        WHERE co_ref = $1`,
      [identity.coRef]
    )).rows[0];
    assert.equal(local.status, "completed");
    assert.equal(canonical.status, "completed");
    assert.equal(local.details.driverCompletionJobId, identity.jobId);
    assert.equal(local.details.driverCompletionSource, "driver_pwa");
    assert.equal(new Date(local.details.driverCompletedAt).toISOString(), completedAt);

    const completedRefs = await listDriverPwaCompletedDispatchRefs({
      candidateRefs: [identity.coRef, identity.soRef]
    });
    assert.equal(completedRefs.has(identity.coRef.toLowerCase()), true);
    assert.equal(completedRefs.has(identity.soRef.toLowerCase()), false);

    const afterOrders = await listDispatchOrders({
      exactOrderRefs: [identity.soRef, identity.coRef],
      unboundedPerType: true
    });
    assert.equal(afterOrders.some((order) => order.id === identity.coRef), false,
      "the completed transfer card must leave the global planning pool");
    const sourceOrder = afterOrders.find((order) => order.id === identity.soRef);
    assert.ok(sourceOrder, "the final customer-delivery SO must remain available");
    assert.deepEqual(sourceOrder.pickupLocations, ["12441"]);
    assert.equal(sourceOrder.transitCo?.id, identity.coRef);
    assert.equal(sourceOrder.transitCo?.status, "completed",
      "the source card must carry terminal CO evidence even though the CO card is hidden");

    const sequenceConflicts = await findDispatchCoSequenceConflicts({
      id: "999999991",
      planDate: "2039-10-02",
      orders: [sourceOrder],
      trucks: [{
        loads: [{
          id: "source-delivery-load",
          timing: { start: 480, finish: 600 },
          stops: [
            { id: "source-pick", type: "pick", orderId: identity.soRef, timing: { arrival: 480, depart: 510 } },
            { id: "source-drop", type: "drop", orderId: identity.soRef, timing: { arrival: 570, depart: 600 } }
          ]
        }]
      }]
    });
    assert.deepEqual(sequenceConflicts, [],
      "a physically completed hidden CO must satisfy the backend source-order sequence guard");

    await assert.rejects(
      () => upsertLocalCoOrder({
        sourceOrderRef: identity.soRef,
        fromYard: "2967",
        toYard: "12441",
        order: {
          ...sourceOrder,
          transitCo: { id: identity.coRef, fromYard: "2967", toYard: "12441" }
        },
        requestedBy: "co-completion-test"
      }),
      (error) => error?.code === "DISPATCH_CO_COMPLETED" && error?.status === 409
    );

    assert.equal(await cancelDispatchCoGlobally(identity.coRef, {
      requestedBy: "co-completion-test"
    }), null, "a physically completed CO must not be changed back to cancelled");
    assert.equal((await query(
      "SELECT status FROM local_co_orders WHERE co_ref = $1",
      [identity.coRef]
    )).rows[0].status, "completed");

    const receiving = await listLocalCoReceivingOrders({ search: identity.coRef });
    assert.equal(receiving.some((order) => order.tranid === identity.coRef), true,
      "transport completion must remain available for destination-yard Receiving");
    await confirmLocalCoReceivingLine(identity.coRef, localCo.lineId, {
      pallets: 1,
      layers: 0,
      sections: 0,
      pieces: 0,
      salesQty: 1
    }, null);
    const receipt = await receiveLocalCoOrder(identity.coRef, null, {
      photoDataUrls: [
        "data:image/jpeg;base64,Y28tY29tcGxldGlvbi0x",
        "data:image/jpeg;base64,Y28tY29tcGxldGlvbi0y"
      ]
    });
    assert.equal(receipt.receiptStatus, "local_co_received");
    assert.equal((await query(
      "SELECT status FROM local_co_orders WHERE id = $1",
      [localCo.coId]
    )).rows[0].status, "received");
    assert.equal((await listDispatchOrders({
      exactOrderRefs: [identity.coRef],
      unboundedPerType: true
    })).some((order) => order.id === identity.coRef), false,
      "a received CO must not return to Dispatch planning");
  });
});

test("later physical completion supersedes an earlier cancellation without making the CO plannable again", async () => {
  await inRollback(async () => {
    const identity = fixtureIdentity("CANCELLED-FIRST");
    const cancelledAt = "2039-10-02T12:00:00.000Z";
    const completedAt = "2039-10-02T16:00:00.000Z";
    await insertLocalCo({
      ...identity,
      status: "cancelled",
      updatedAt: cancelledAt,
      details: { cancelledAt, cancelledBy: "co-completion-test" }
    });

    await insertDriverStop({ ...identity, completedAt });

    const row = (await query(
      "SELECT status, details FROM local_co_orders WHERE co_ref = $1",
      [identity.coRef]
    )).rows[0];
    assert.equal(row.status, "completed");
    assert.equal(row.details.cancelledAt, cancelledAt);
    assert.equal(row.details.completedAfterCancellation, true);
    assert.equal(row.details.driverCompletionJobId, identity.jobId);
  });
});

test("backend sequencing accepts a source delivery whose hidden CO is already completed", async () => {
  await inRollback(async () => {
    const identity = fixtureIdentity("SEQUENCE");
    await insertLocalCo({
      ...identity,
      status: "completed",
      updatedAt: "2039-10-05T16:00:00.000Z",
      details: {
        driverCompletionSource: "driver_pwa",
        driverCompletedAt: "2039-10-05T16:00:00.000Z"
      }
    });

    const conflicts = await findDispatchCoSequenceConflicts({
      id: "999999992",
      planDate: "2039-10-06",
      orders: [{
        id: identity.soRef,
        type: "SO",
        pickupLocations: ["12441"],
        transitCo: {
          id: identity.coRef,
          fromYard: "2967",
          toYard: "12441",
          status: "completed"
        }
      }],
      trucks: [{
        loads: [{
          id: "completed-co-source-load",
          timing: { start: 480, finish: 600 },
          stops: [
            { id: "completed-co-source-pick", type: "pick", orderId: identity.soRef, timing: { arrival: 480, depart: 510 } },
            { id: "completed-co-source-drop", type: "drop", orderId: identity.soRef, timing: { arrival: 570, depart: 600 } }
          ]
        }]
      }]
    });
    assert.deepEqual(conflicts, []);
  });
});

test("backend sequencing trusts terminal database state, not a spoofed or stale frontend status", async () => {
  await inRollback(async () => {
    const pending = fixtureIdentity("SEQUENCE-PENDING");
    const received = fixtureIdentity("SEQUENCE-RECEIVED");
    await insertLocalCo({
      ...pending,
      status: "pending_load",
      updatedAt: "2039-10-06T12:00:00.000Z"
    });
    await insertLocalCo({
      ...received,
      status: "received",
      updatedAt: "2039-10-06T13:00:00.000Z"
    });
    const planFor = (identity, claimedStatus) => ({
      id: "999999993",
      planDate: "2039-10-07",
      orders: [{
        id: identity.soRef,
        type: "SO",
        transitCo: { id: identity.coRef, status: claimedStatus }
      }],
      trucks: [{ loads: [{ stops: [
        { type: "pick", orderId: identity.soRef },
        { type: "drop", orderId: identity.soRef }
      ] }] }]
    });

    const pendingConflicts = await findDispatchCoSequenceConflicts(planFor(pending, "completed"));
    assert.equal(pendingConflicts.length, 1);
    assert.match(pendingConflicts[0].reason, /requires .* to be planned first/u);
    assert.deepEqual(
      await findDispatchCoSequenceConflicts(planFor(received, "pending_load")),
      [],
      "a stale nonterminal browser payload must not hide terminal Receiving evidence"
    );

    const missing = fixtureIdentity("SEQUENCE-MISSING");
    const missingConflicts = await findDispatchCoSequenceConflicts(planFor(missing, "completed"));
    assert.equal(missingConflicts.length, 1);
  });
});

test("a later cancellation wins over delayed older completion evidence", async () => {
  await inRollback(async () => {
    const identity = fixtureIdentity("CANCELLED-LATER");
    const completedAt = "2039-10-03T12:00:00.000Z";
    const cancelledAt = "2039-10-03T16:00:00.000Z";
    await insertLocalCo({
      ...identity,
      status: "cancelled",
      updatedAt: cancelledAt,
      details: { cancelledAt, cancelledBy: "co-completion-test" }
    });

    await insertDriverStop({ ...identity, completedAt });

    const row = (await query(
      "SELECT status, details FROM local_co_orders WHERE co_ref = $1",
      [identity.coRef]
    )).rows[0];
    assert.equal(row.status, "cancelled");
    assert.equal(row.details.driverCompletionJobId, undefined);
  });
});

test("pickup completion and incomplete dropoff states do not terminalize a CO", async () => {
  await inRollback(async () => {
    const pickup = fixtureIdentity("PICKUP");
    const startedDrop = fixtureIdentity("STARTED-DROP");
    for (const identity of [pickup, startedDrop]) {
      await insertLocalCo({
        ...identity,
        updatedAt: "2039-10-04T12:00:00.000Z"
      });
    }

    await insertDriverStop({
      ...pickup,
      stopType: "pickup",
      completedAt: "2039-10-04T16:00:00.000Z"
    });
    await insertDriverStop({
      ...startedDrop,
      status: "in_progress",
      completedAt: "2039-10-04T16:05:00.000Z"
    });

    const rows = await query(
      `SELECT co_ref, status
         FROM local_co_orders
        WHERE co_ref = ANY($1::text[])
        ORDER BY co_ref`,
      [[pickup.coRef, startedDrop.coRef]]
    );
    assert.deepEqual(rows.rows.map((row) => row.status), ["pending_load", "pending_load"]);
  });
});
