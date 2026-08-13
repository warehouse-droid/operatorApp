import assert from "node:assert/strict";
import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  reconcileSalesOrderFromNetSuite
} from "./sales-order-reconciliation-repository.js";
import {
  cleanupBilledSalesOrderFamiliesFromDispatchPlan,
  getDispatchPlan
} from "./dispatch-plan-repository.js";

const rollback = await beginRollbackContext();

function authoritativeSalesOrder({ id, ref, lineKey, billed = false }) {
  return {
    id,
    kind: "SO",
    tranid: ref,
    status: billed ? "G" : "F",
    statusText: billed ? "Sales Order : Billed" : "Sales Order : Pending Billing",
    entityId: 44,
    entity: "Grouped SO Test Customer",
    sourceLocationId: 15,
    sourceLocation: "12441",
    deliveryMethodId: 2,
    deliveryMethod: "Delivery",
    lines: [{
      sourceLineKey: String(lineKey),
      itemId: 25,
      itemName: "Grouped SO reconciliation item",
      itemType: "Assembly",
      quantity: 10,
      cumulativeProgressQuantity: 10,
      unit: "EA",
      locationId: 15,
      location: "12441"
    }]
  };
}

try {
  await rollback.run(async () => {
    const seed = 9_882_000_000 + Math.floor(Math.random() * 100_000);
    const soIds = [seed + 1, seed + 2];
    const soRefs = [`TST-SOA${seed + 1}`, `TST-SOA${seed + 2}`];
    const lineKeys = [seed + 101, seed + 102];
    const groupRef = `GOA-${seed + 1}-${seed + 2}`;
    for (let index = 0; index < soIds.length; index += 1) {
      await query(
        `INSERT INTO sales_orders (
           netsuite_id, tranid, status, status_text, customer, outbound_location_id,
           outbound_location, sales_order_type, operator_status,
           local_yard_order_status, fulfillment_status, netsuite_active, synced_at
         ) VALUES (
           $1, $2, 'B', 'Sales Order : Pending Fulfillment', 'Grouped SO Test Customer', 15,
           '12441', 'Delivery', 'open', 'Open', 'not_fulfilled', true, now()
         )`,
        [soIds[index], soRefs[index]]
      );
      await query(
        `INSERT INTO sales_order_lines (
           sales_order_id, line_id, item_id, item_name, item_type, quantity, unit,
           packed_sales_qty, pack_quantity_source, netsuite_active, synced_at
         ) VALUES ($1, $2, 25, 'Grouped SO reconciliation item', 'Assembly', 10, 'EA',
                   0, 'sales_only', true, now())`,
        [soIds[index], lineKeys[index]]
      );
    }

    await query(
      `INSERT INTO dispatch_trucks (plate, active)
       SELECT 'TST-GROUPED-SO', true
        WHERE NOT EXISTS (
          SELECT 1 FROM dispatch_trucks WHERE upper(BTRIM(plate)) = 'TST-GROUPED-SO'
        )`
    );
    const truck = (await query(
      `UPDATE dispatch_trucks
          SET active = true
        WHERE upper(BTRIM(plate)) = 'TST-GROUPED-SO'
        RETURNING id, plate`
    )).rows[0];
    const plan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note)
       VALUES ('2099-11-28', 'draft', 'Grouped SO reconciliation harness')
       ON CONFLICT (plan_date) DO UPDATE SET note = EXCLUDED.note
       RETURNING id`
    );
    await query(
      `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary, saved_at)
       VALUES ($1, $2::jsonb, $3::jsonb, '{}'::jsonb, now())
       ON CONFLICT (plan_id) DO UPDATE SET orders = EXCLUDED.orders, trucks = EXCLUDED.trucks,
         summary = EXCLUDED.summary, saved_at = now()`,
      [
        plan.rows[0].id,
        JSON.stringify([{
          id: groupRef,
          type: "SO",
          customer: "2 orders grouped",
          childOrders: soRefs,
          childOrderDetails: soRefs.map((id) => ({
            id,
            type: "SO",
            fulfillmentStatus: "not_fulfilled",
            netsuiteStatusText: "Sales Order : Pending Fulfillment",
            pallets: 1,
            salesQty: 10,
            items: [{ sku: `${id}-ITEM`, quantity: 10 }]
          })),
          fulfillmentStatus: "not_fulfilled",
          reconciliationApplicationStatus: "Queued",
          pallets: 2,
          salesQty: 20
        }]),
        JSON.stringify([{
          id: String(truck.id),
          plate: truck.plate,
          loads: [{
            id: "GROUPED-SO-LOAD",
            name: "Load 1",
            stops: [{
              id: "GROUPED-SO-STOP",
              type: "drop",
              orderId: groupRef,
              orderRefs: [groupRef]
            }]
          }]
        }])
      ]
    );

    await reconcileSalesOrderFromNetSuite({
      order: authoritativeSalesOrder({
        id: soIds[0], ref: soRefs[0], lineKey: lineKeys[0]
      }),
      source: "manual",
      dryRun: false
    });
    let snapshot = (await query(
      "SELECT orders, trucks FROM dispatch_plan_snapshots WHERE plan_id = $1",
      [plan.rows[0].id]
    )).rows[0];
    assert.equal(snapshot.orders[0].reconciliationApplicationStatus, "Partially Done",
      "One completed grouped SO child must roll the parent to Partially Done.");
    assert.equal(snapshot.orders[0].fulfillmentStatus, "partial_fulfilled");
    assert.equal(snapshot.orders[0].childOrderDetails[0].fulfillmentStatus, "not_fulfilled",
      "Reconciliation must preserve the child operational fulfillment field.");
    assert.equal(snapshot.orders[0].childOrderDetails[0].reconciliationApplicationStatus, "Completed",
      "Reconciliation must publish completed child evidence in its separate calculation field.");

    await query(
      `UPDATE sales_orders
          SET operator_status = 'preparing'
        WHERE netsuite_id = $1`,
      [soIds[1]]
    );
    await query(
      `UPDATE sales_order_lines
          SET packed_sales_qty = 1
        WHERE sales_order_id = $1`,
      [soIds[1]]
    );
    const review = await reconcileSalesOrderFromNetSuite({
      order: authoritativeSalesOrder({
        id: soIds[1], ref: soRefs[1], lineKey: lineKeys[1]
      }),
      source: "manual",
      dryRun: false
    });
    assert.equal(review.reconciliationStatus, "review");
    snapshot = (await query(
      "SELECT orders, trucks FROM dispatch_plan_snapshots WHERE plan_id = $1",
      [plan.rows[0].id]
    )).rows[0];
    assert.equal(snapshot.orders[0].reconciliationApplicationStatus, "Reconcile Review",
      "A grouped SO child in Review must elevate the parent before any completion rollup.");
    const reviewHiddenFromSnapshot = structuredClone(snapshot.orders);
    reviewHiddenFromSnapshot[0].reconciliationApplicationStatus = "Queued";
    reviewHiddenFromSnapshot[0].reconciliationStatus = "current";
    reviewHiddenFromSnapshot[0].reconciliationBlocked = false;
    reviewHiddenFromSnapshot[0].childOrderDetails = reviewHiddenFromSnapshot[0].childOrderDetails
      .map((child) => ({
        ...child,
        reconciliationApplicationStatus: "",
        reconciliationStatus: "current",
        reconciliationBlocked: false,
        reconciliationReason: ""
      }));
    await query(
      `UPDATE dispatch_plan_snapshots
          SET orders = $2::jsonb
        WHERE plan_id = $1`,
      [plan.rows[0].id, JSON.stringify(reviewHiddenFromSnapshot)]
    );
    assert.equal(
      (await getDispatchPlan(plan.rows[0].id)).orders[0].reconciliationApplicationStatus,
      "Reconcile Review",
      "A plan reload must derive Review from an active child packing draft even when its old snapshot is stale."
    );
    await query(
      `UPDATE sales_orders
          SET operator_status = 'open'
        WHERE netsuite_id = $1`,
      [soIds[1]]
    );
    await query(
      `UPDATE sales_order_lines
          SET packed_sales_qty = 0, confirmed = false
        WHERE sales_order_id = $1`,
      [soIds[1]]
    );

    const completed = await reconcileSalesOrderFromNetSuite({
      order: authoritativeSalesOrder({
        id: soIds[1], ref: soRefs[1], lineKey: lineKeys[1]
      }),
      source: "manual",
      dryRun: false
    });
    snapshot = (await query(
      "SELECT orders, trucks FROM dispatch_plan_snapshots WHERE plan_id = $1",
      [plan.rows[0].id]
    )).rows[0];
    assert.equal(snapshot.orders[0].reconciliationApplicationStatus, "Completed",
      "Every active grouped SO child completed must roll the parent to Completed.");
    assert.equal(snapshot.orders[0].fulfillmentStatus, "fulfilled");
    assert.equal(
      await query("SELECT count(*)::int AS count FROM sales_orders WHERE upper(tranid) = upper($1)", [groupRef])
        .then((result) => result.rows[0].count),
      0,
      "A dispatch group must never become a synthetic NetSuite Sales Order."
    );
    const completedRevision = Number((await query(
      "SELECT revision FROM dispatch_plans WHERE id = $1",
      [plan.rows[0].id]
    )).rows[0].revision);
    const completedRetry = await reconcileSalesOrderFromNetSuite({
      order: authoritativeSalesOrder({
        id: soIds[1], ref: soRefs[1], lineKey: lineKeys[1]
      }),
      source: "manual",
      dryRun: false
    });
    assert.equal(completed.applicationStatus, "Completed");
    assert.equal(completedRetry.planCleanup.changedPlans.length, 0,
      "An exact non-billed retry must not rewrite an unchanged grouped SO snapshot.");
    assert.equal(
      Number((await query("SELECT revision FROM dispatch_plans WHERE id = $1", [plan.rows[0].id])).rows[0].revision),
      completedRevision,
      "An exact non-billed retry must not create a phantom dispatch-plan revision."
    );

    const staleOrders = structuredClone(snapshot.orders);
    staleOrders[0].fulfillmentStatus = "not_fulfilled";
    staleOrders[0].reconciliationApplicationStatus = "Queued";
    staleOrders[0].childOrderDetails = staleOrders[0].childOrderDetails.map((child) => ({
      ...child,
      fulfillmentStatus: "not_fulfilled",
      netsuiteStatusText: "Sales Order : Pending Fulfillment"
    }));
    await query(
      `UPDATE dispatch_plan_snapshots
          SET orders = $2::jsonb
        WHERE plan_id = $1`,
      [plan.rows[0].id, JSON.stringify(staleOrders)]
    );
    const repairedRead = await getDispatchPlan(plan.rows[0].id);
    assert.equal(repairedRead.orders[0].reconciliationApplicationStatus, "Completed",
      "A plan reload must repair an older stale group snapshot from current child SO evidence.");
    assert.equal(repairedRead.orders[0].fulfillmentStatus, "fulfilled");
    assert.equal(
      (await query("SELECT orders FROM dispatch_plan_snapshots WHERE plan_id = $1", [plan.rows[0].id]))
        .rows[0].orders[0].reconciliationApplicationStatus,
      "Queued",
      "The read repair must not silently create a new dispatch-plan revision or overwrite its audit snapshot."
    );

    const activeJobId = `TST-GROUPED-SO-${seed}`;
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_id, plan_date, driver_login, load_id, stop_id, stop_type,
         order_refs, status, started_at
       ) VALUES ($1, $2, '2099-11-28', 'grouped-so-harness', 'GROUPED-SO-LOAD',
                 'GROUPED-SO-STOP', 'dropoff', $3::jsonb, 'in_progress', now())`,
      [activeJobId, plan.rows[0].id, JSON.stringify([soRefs[0], soRefs[1]])]
    );
    await query(
      `UPDATE sales_orders
          SET status = 'G',
              status_text = 'Sales Order : Billed',
              synced_at = now()
        WHERE netsuite_id = $1`,
      [soIds[0]]
    );
    const deferred = await reconcileSalesOrderFromNetSuite({
      order: authoritativeSalesOrder({
        id: soIds[0], ref: soRefs[0], lineKey: lineKeys[0], billed: true
      }),
      source: "manual",
      dryRun: false
    });
    assert.equal(deferred.planCleanup.deferred, true,
      "A billed grouped child must not structurally change an in-progress driver route.");
    snapshot = (await query(
      "SELECT orders, trucks FROM dispatch_plan_snapshots WHERE plan_id = $1",
      [plan.rows[0].id]
    )).rows[0];
    assert.equal(snapshot.orders[0].id, groupRef);
    assert.equal(snapshot.trucks[0].loads[0].stops[0].orderId, groupRef);

    await query(
      `UPDATE driver_job_records
          SET status = 'complete', completed_at = now()
        WHERE job_id = $1`,
      [activeJobId]
    );
    const cleanup = await cleanupBilledSalesOrderFamiliesFromDispatchPlan({
      planId: plan.rows[0].id,
      actor: "grouped-so-reconciliation-harness"
    });
    assert.equal(cleanup.deferredFamilies.length, 0);
    assert.equal(cleanup.changedPlans.length, 1);
    snapshot = (await query(
      "SELECT orders, trucks FROM dispatch_plan_snapshots WHERE plan_id = $1",
      [plan.rows[0].id]
    )).rows[0];
    assert.deepEqual(snapshot.orders.map((order) => order.id), [soRefs[1]],
      "Billing one child must dissolve a two-child group into the remaining real SO.");
    assert.deepEqual(
      snapshot.trucks[0].loads[0].stops.map((stop) => stop.orderId),
      [soRefs[1]],
      "Dissolving a group must rewrite its stop instead of leaving an orphan GOA stop."
    );

    const exactRetry = await reconcileSalesOrderFromNetSuite({
      order: authoritativeSalesOrder({
        id: soIds[0], ref: soRefs[0], lineKey: lineKeys[0], billed: true
      }),
      source: "manual",
      dryRun: false
    });
    assert.equal(exactRetry.planCleanup.changedPlans.length, 0,
      "An exact billed retry must not rewrite the already repaired plan again.");

    await query(
      `UPDATE sales_orders
          SET status = 'G',
              status_text = 'Sales Order : Billed',
              synced_at = now()
        WHERE netsuite_id = $1`,
      [soIds[1]]
    );
    await reconcileSalesOrderFromNetSuite({
      order: authoritativeSalesOrder({
        id: soIds[1], ref: soRefs[1], lineKey: lineKeys[1], billed: true
      }),
      source: "manual",
      dryRun: false
    });
    snapshot = (await query(
      "SELECT orders, trucks FROM dispatch_plan_snapshots WHERE plan_id = $1",
      [plan.rows[0].id]
    )).rows[0];
    assert.deepEqual(snapshot.orders, [],
      "Billing the final grouped child must remove the dissolved order.");
    assert.deepEqual(snapshot.trucks[0].loads[0].stops, [],
      "Billing the final grouped child must remove its stop exactly once.");
  });
  console.log("Grouped Sales Order reconciliation integration harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}
