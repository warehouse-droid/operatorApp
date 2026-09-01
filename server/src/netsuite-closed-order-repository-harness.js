import assert from "node:assert/strict";

import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  assertNoClosedNetSuiteOrders,
  listClosedNetSuiteOrders,
  scrubClosedNetSuiteOrdersFromOperationalPlan
} from "./netsuite-closed-order-repository.js";
import { confirmDeliveryLine, getDeliveryOrder, listDeliveryOrders } from "./delivery-repository.js";
import {
  confirmLocalCoReceivingLine,
  confirmReceivingLine,
  getLocalCoReceivingOrder,
  getReceivingOrder,
  listLocalCoReceivingOrders,
  searchLocalCoItems,
  unconfirmReceivingLine
} from "./receiving-repository.js";
import { getDriverDayJobs, listDriverHistory, startDriverJob, recordDriverJobPhotos } from "./driver-repository.js";
import { driverCompanyDate } from "./driver-plan-date-policy.js";
import { assertScmReconciliationOrderEditable } from "./scm-reconciliation-repository.js";
import {
  createDispatchOperatorRequest,
  listDispatchOrders,
  listScmSchedule,
  updateDispatchOrderDetails,
  updateSalesOrderLocalMethod
} from "./dispatch-repository.js";
import { manuallyCompleteDispatchOrder } from "./dispatch-completion-repository.js";
import { getDeliveryInstruction } from "./delivery-instruction-repository.js";
import { getDispatchPlan, getDispatchPlanSnapshot } from "./dispatch-plan-repository.js";
import { applyDispatchV2Command, getDispatchV2Bootstrap } from "./dispatch-planner-v2-repository.js";

const rollback = await beginRollbackContext();
try {
  await rollback.run(async () => {
    const soId = 9_914_000_101;
    const poId = 9_914_000_201;
    const toId = 9_914_000_301;
    const soSplitId = -soId;
    const poSplitId = -poId;
    const toSplitId = -toId;

    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, status, status_text, sales_order_type,
         operator_status, local_yard_order_status, netsuite_active, synced_at
       ) VALUES
         ($1, 'TST-SO-CLOSED', 'H', 'Sales Order : Closed', 'Delivery', 'open', 'Open', true, now()),
         ($2, 'TST-SO-CLOSED-S1', 'B', 'Sales Order : Pending Fulfillment', 'Delivery', 'open', 'Open', true, now()),
         ($3, 'TST-SO-OPEN', 'B', 'Not Closed Yet', 'Delivery', 'open', 'Open', true, now())`,
      [soId, soSplitId, soId + 1]
    );
    await query(
      `INSERT INTO dispatch_scm_so_splits (
         source_so_id, source_so_ref, split_so_id, split_so_ref, status, details
       ) VALUES ($1, 'TST-SO-CLOSED', $2, 'TST-SO-CLOSED-S1', 'active', '{}'::jsonb)`,
      [soId, soSplitId]
    );

    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, status, status_text, netsuite_active, synced_at
       ) VALUES
         ($1, 'TST-PO-CLOSED', 'H', 'Purchase Order : Closed', true, now()),
         ($2, 'TST-PO-CLOSED-S1', 'B', 'Purchase Order : Pending Receipt', true, now()),
         ($3, 'TST-PO-OPEN', 'B', 'Purchase Order : Pending Receipt', true, now())`,
      [poId, poSplitId, poId + 1]
    );
    await query(
      `INSERT INTO dispatch_scm_po_splits (
         source_po_id, source_po_ref, split_po_id, split_po_ref, status, details
       ) VALUES ($1, 'TST-PO-CLOSED', $2, 'TST-PO-CLOSED-S1', 'active', '{}'::jsonb)`,
      [poId, poSplitId]
    );

    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, status, status_text, netsuite_active, synced_at
       ) VALUES
         ($1, 'TST-TO-CLOSED', 'G', 'Transfer Order : Closed', true, now()),
         ($2, 'TST-TO-CLOSED-S1', 'B', 'Transfer Order : Pending Fulfillment', true, now()),
         ($3, 'TST-TO-OPEN', 'B', 'Transfer Order : Pending Fulfillment', true, now())`,
      [toId, toSplitId, toId + 1]
    );
    await query(
      `UPDATE transfer_orders
          SET from_location_id = 1, from_location = 'Test source',
              to_location_id = 2, to_location = 'Test destination'
        WHERE netsuite_id = ANY($1::bigint[])`,
      [[toId, toSplitId, toId + 1]]
    );

    const localCos = await query(
      `INSERT INTO local_co_orders (
         co_ref, source_order_ref, from_location_id, from_location,
         to_location_id, to_location, status, delivery_order_id, details
       ) VALUES
         ('CO-TST-CLOSED-RECEIVING', 'TST-SO-CLOSED', 1, '3445', 28, '2967', 'planned', -9914000401, '{}'::jsonb),
         ('CO-TST-OPEN-RECEIVING', 'TST-SO-OPEN', 28, '2967', 1, '3445', 'planned', -9914000402, '{}'::jsonb),
         ('CO-TST-CLOSED-DELIVERY', 'TST-SO-CLOSED', 1, '3445', 28, '2967', 'pending_load', -9914000403, '{}'::jsonb),
         ('CO-TST-OPEN-DELIVERY', 'TST-SO-OPEN', 28, '2967', 1, '3445', 'pending_load', -9914000404, '{}'::jsonb)
       RETURNING id, co_ref`
    );
    const localCoIdByRef = new Map(localCos.rows.map((row) => [row.co_ref, row.id]));
    const closedCoLine = await query(
      `INSERT INTO local_co_order_lines (
         co_id, line_id, item_id, item_name, sku, item_type, item_type_text,
         quantity, unit, pallet_qty, to_plt
       ) VALUES
         ($1, 9914000501, 9914000601, 'CLOSED-CO-ITEM', 'CLOSED-CO-ITEM', 'InvtPart', 'Inventory Item', 1, 'EA', 1, 1),
         ($2, 9914000502, 9914000602, 'OPEN-CO-ITEM', 'OPEN-CO-ITEM', 'InvtPart', 'Inventory Item', 1, 'EA', 1, 1)
       RETURNING id, co_id`,
      [
        localCoIdByRef.get("CO-TST-CLOSED-RECEIVING"),
        localCoIdByRef.get("CO-TST-OPEN-RECEIVING")
      ]
    );
    const closedCoLineId = closedCoLine.rows.find((row) =>
      String(row.co_id) === String(localCoIdByRef.get("CO-TST-CLOSED-RECEIVING")))?.id;
    await query(
      `INSERT INTO dispatch_scm_to_splits (
         source_to_id, source_to_ref, split_to_id, split_to_ref, status, details
       ) VALUES ($1, 'TST-TO-CLOSED', $2, 'TST-TO-CLOSED-S1', 'active', '{}'::jsonb)`,
      [toId, toSplitId]
    );
    await query(
      `UPDATE sales_orders
          SET dispatch_planned = true
        WHERE netsuite_id = ANY($1::bigint[])`,
      [[soId, soSplitId, soId + 1]]
    );
    await query(
      `UPDATE transfer_orders
          SET dispatch_planned = true
        WHERE netsuite_id = ANY($1::bigint[])`,
      [[toId, toSplitId, toId + 1]]
    );

    for (const [kind, closedRef, openRef] of [
      ["SO", "TST-SO-CLOSED", "TST-SO-OPEN"],
      ["PO", "TST-PO-CLOSED", "TST-PO-OPEN"],
      ["TO", "TST-TO-CLOSED", "TST-TO-OPEN"]
    ]) {
      const hiddenDispatchRows = await listDispatchOrders({
        type: kind,
        includeHiddenScm: true,
        search: closedRef
      });
      assert.equal(hiddenDispatchRows.length, 0, `Closed ${kind} must be absent from the Dispatch order pool.`);
      const visibleDispatchRows = await listDispatchOrders({
        type: kind,
        includeHiddenScm: true,
        search: openRef
      });
      assert.ok(
        visibleDispatchRows.some((row) => row.id === openRef),
        `The open ${kind} control must remain in the Dispatch order pool.`
      );
    }
    for (const [kind, closedRef, openRef] of [
      ["PO", "TST-PO-CLOSED", "TST-PO-OPEN"],
      ["TO", "TST-TO-CLOSED", "TST-TO-OPEN"]
    ]) {
      const hiddenScmRows = await listScmSchedule({ kind, exactRef: closedRef });
      assert.equal(hiddenScmRows.length, 0, `Closed ${kind} must be absent from the SCM schedule.`);
      const visibleScmRows = await listScmSchedule({ kind, exactRef: openRef });
      assert.ok(
        visibleScmRows.some((row) => row.orderRef === openRef),
        `The open ${kind} control must remain in the SCM schedule.`
      );
    }
    assert.equal(await getLocalCoReceivingOrder("CO-TST-CLOSED-RECEIVING"), null);
    assert.ok(await getLocalCoReceivingOrder("CO-TST-OPEN-RECEIVING"));
    assert.equal(
      (await listLocalCoReceivingOrders({ search: "CO-TST-CLOSED-RECEIVING" })).length,
      0,
      "A local CO sourced from a Closed NetSuite order must be absent from Receiving."
    );
    assert.ok((await listLocalCoReceivingOrders({ search: "CO-TST-OPEN-RECEIVING" }))
      .some((row) => row.tranid === "CO-TST-OPEN-RECEIVING"));
    assert.equal((await searchLocalCoItems({ search: "CLOSED-CO-ITEM" })).length, 0);
    assert.ok((await searchLocalCoItems({ search: "OPEN-CO-ITEM" }))
      .some((row) => row.item_name === "OPEN-CO-ITEM"));
    await assert.rejects(
      confirmLocalCoReceivingLine(
        "CO-TST-CLOSED-RECEIVING",
        closedCoLineId,
        { pallets: 1, layers: 0, sections: 0, pieces: 0, salesQty: 1 },
        1
      ),
      (error) => error?.code === "NETSUITE_ORDER_CLOSED"
    );
    const unchangedClosedCoLine = await query(
      `SELECT received_pallet_qty, confirmed_at
         FROM local_co_order_lines
        WHERE id = $1`,
      [closedCoLineId]
    );
    assert.equal(Number(unchangedClosedCoLine.rows[0].received_pallet_qty || 0), 0);
    assert.equal(unchangedClosedCoLine.rows[0].confirmed_at, null);
    assert.equal(await getDeliveryOrder("CO-TST-CLOSED-DELIVERY"), null);
    assert.ok(await getDeliveryOrder("CO-TST-OPEN-DELIVERY"));
    const localCoDeliveryRows = await listDeliveryOrders({
      locationId: 28,
      status: "active",
      orderType: "sales_order"
    });
    assert.equal(localCoDeliveryRows.some((row) => row.tranid === "CO-TST-CLOSED-DELIVERY"), false);
    assert.equal(localCoDeliveryRows.some((row) => row.tranid === "CO-TST-OPEN-DELIVERY"), true);

    const closed = await listClosedNetSuiteOrders([
      "TST-SO-CLOSED-S1",
      "tst-po-closed-s1",
      "TST-TO-CLOSED-S1",
      "TST-SO-OPEN",
      "TST-PO-OPEN",
      "TST-TO-OPEN"
    ]);
    assert.deepEqual(
      closed.map((entry) => [entry.requestedRef, entry.kind, entry.canonicalRef]),
      [
        ["TST-PO-CLOSED-S1", "PO", "TST-PO-CLOSED"],
        ["TST-SO-CLOSED-S1", "SO", "TST-SO-CLOSED"],
        ["TST-TO-CLOSED-S1", "TO", "TST-TO-CLOSED"]
      ]
    );

    await assert.doesNotReject(assertNoClosedNetSuiteOrders([
      "TST-SO-OPEN", "TST-PO-OPEN", "TST-TO-OPEN"
    ], "update operational work"));
    await assert.rejects(
      assertNoClosedNetSuiteOrders(["TST-TO-CLOSED-S1"], "complete driver stop"),
      (error) => error?.code === "NETSUITE_ORDER_CLOSED"
        && error?.status === 409
        && error?.conflicts?.[0]?.canonicalRef === "TST-TO-CLOSED"
    );

    const stalePlan = {
      orders: [
        { id: "TST-SO-CLOSED", type: "SO" },
        { id: "TST-PO-OPEN", type: "PO" }
      ],
      trucks: [{ loads: [{ stops: [
        { orderId: "TST-SO-CLOSED", orderRefs: ["TST-SO-CLOSED"] },
        { orderId: "TST-PO-OPEN", orderRefs: ["TST-PO-OPEN"] }
      ] }] }]
    };
    const sanitized = await scrubClosedNetSuiteOrdersFromOperationalPlan(stalePlan);
    assert.equal(sanitized.changed, true);
    assert.deepEqual(sanitized.plan.orders.map((order) => order.id), ["TST-PO-OPEN"]);
    assert.deepEqual(sanitized.plan.trucks[0].loads[0].stops.map((stop) => stop.orderId), ["TST-PO-OPEN"]);

    assert.equal(await getDeliveryOrder(soId), null, "A Closed SO must be hidden from Operator Delivery.");
    assert.equal(await getDeliveryOrder(toId), null, "A Closed TO must be hidden from Operator Delivery.");
    assert.ok(
      await getDeliveryOrder(soId, { includeNetSuiteClosed: true }),
      "The internal posting finalizer must retain access to an already-fulfilled SO record."
    );
    assert.ok(
      await getDeliveryOrder(toId, { includeNetSuiteClosed: true }),
      "The internal posting finalizer must retain access to an already-fulfilled TO record."
    );
    assert.ok(await getDeliveryOrder(soId + 1), "An open SO must remain visible to Operator Delivery.");
    assert.ok(await getDeliveryOrder(toId + 1), "An open TO must remain visible to Operator Delivery.");
    assert.equal(await getReceivingOrder(poId), null, "A Closed PO must be hidden from Operator Receiving.");
    assert.equal(await getReceivingOrder(toId), null, "A Closed TO must be hidden from Operator Receiving.");
    assert.ok(
      await getReceivingOrder(poId, { includeNetSuiteClosed: true }),
      "The internal posting finalizer must retain access to an already-received PO record."
    );
    assert.ok(
      await getReceivingOrder(toId, { includeNetSuiteClosed: true }),
      "The internal posting finalizer must retain access to an already-received TO record."
    );
    assert.ok(await getReceivingOrder(poId + 1), "An open PO must remain visible to Operator Receiving.");
    assert.ok(await getReceivingOrder(toId + 1), "An open TO must remain visible to Operator Receiving.");

    await assert.rejects(
      assertScmReconciliationOrderEditable({ orderRef: "TST-PO-CLOSED-S1" }),
      (error) => error?.code === "NETSUITE_ORDER_CLOSED"
    );
    const closedDriverJob = {
      jobId: "closed-order-policy-driver-job",
      planDate: driverCompanyDate(),
      orderRefs: ["TST-TO-CLOSED-S1"],
      requiredPhotos: 0
    };
    await assert.rejects(
      startDriverJob("closed-policy-driver", closedDriverJob.jobId, { job: closedDriverJob }),
      (error) => error?.code === "NETSUITE_ORDER_CLOSED"
    );
    await assert.rejects(
      recordDriverJobPhotos("closed-policy-driver", closedDriverJob.jobId, { job: closedDriverJob }),
      (error) => error?.code === "NETSUITE_ORDER_CLOSED"
    );
    const driverRecord = await query(
      "SELECT COUNT(*)::int AS count FROM driver_job_records WHERE job_id = $1",
      [closedDriverJob.jobId]
    );
    assert.equal(driverRecord.rows[0].count, 0, "Rejected Driver events must not leave a partial record.");

    await assert.rejects(
      confirmDeliveryLine(soId, 1, {}, 1),
      (error) => error?.code === "NETSUITE_ORDER_CLOSED"
    );
    await assert.rejects(
      confirmReceivingLine(poId, 1, {}, 1),
      (error) => error?.code === "NETSUITE_ORDER_CLOSED"
    );
    await assert.rejects(
      unconfirmReceivingLine(toId, 1, 1),
      (error) => error?.code === "NETSUITE_ORDER_CLOSED"
    );
    await assert.rejects(
      updateSalesOrderLocalMethod("TST-SO-CLOSED", { method: "Pick-Up", updatedBy: "test" }),
      (error) => error?.code === "NETSUITE_ORDER_CLOSED"
    );
    await assert.rejects(
      updateDispatchOrderDetails("TST-TO-CLOSED-S1", { type: "TO", address: "Changed" }),
      (error) => error?.code === "NETSUITE_ORDER_CLOSED"
    );
    await assert.rejects(
      createDispatchOperatorRequest({ requestType: "unpack_for_split", orderRef: "TST-SO-CLOSED" }),
      (error) => error?.code === "NETSUITE_ORDER_CLOSED"
    );
    await assert.rejects(
      manuallyCompleteDispatchOrder({
        actor: { operatorId: "1", role: "admin" },
        orderKind: "SO",
        orderRef: "TST-SO-CLOSED",
        reason: "Closed-order guard test",
        confirm: true
      }),
      (error) => error?.code === "NETSUITE_ORDER_CLOSED"
    );
    await assert.rejects(
      getDeliveryInstruction(soId),
      (error) => error?.code === "DELIVERY_INSTRUCTION_NOT_FOUND"
    );

    await query(
      `INSERT INTO driver_job_records (
         job_id, driver_login, stop_type, order_refs, photo_data_urls, status, completed_at, job_details
       ) VALUES
         ('closed-order-policy-history-closed', 'closed-policy-driver', 'dropoff', '["TST-SO-CLOSED"]'::jsonb, '[]'::jsonb, 'complete', now(), '{}'::jsonb),
         ('closed-order-policy-history-open', 'closed-policy-driver', 'dropoff', '["TST-SO-OPEN"]'::jsonb, '[]'::jsonb, 'complete', now(), '{}'::jsonb)`
    );
    const history = await listDriverHistory("closed-policy-driver");
    assert.deepEqual(
      history.filter((entry) => entry.type === "stop").map((entry) => entry.reference),
      ["TST-SO-OPEN"],
      "Driver history must retain open work but hide Closed NetSuite orders."
    );

    const planDate = "2099-12-29";
    const planRow = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note, confirmed_at, revision)
       VALUES ($1::date, 'confirmed', 'Closed-order visibility harness', now(), 0)
       RETURNING id`,
      [planDate]
    );
    const planId = planRow.rows[0].id;
    const planOrders = [
      { id: "TST-SO-CLOSED", type: "SO", address: "Closed destination" },
      { id: "TST-SO-OPEN", type: "SO", address: "Open destination" }
    ];
    const planTrucks = [{
      id: "closed-policy-truck",
      plate: "CLOSED-POLICY",
      driver: "Closed Policy Driver",
      driverLogin: "closed-policy-driver",
      loads: [{
        id: "closed-policy-load",
        name: "Load 1",
        driverLogin: "closed-policy-driver",
        driverName: "Closed Policy Driver",
        truckId: "closed-policy-truck",
        truckPlate: "CLOSED-POLICY",
        stops: [
          { id: "closed-policy-stop-closed", type: "drop", orderId: "TST-SO-CLOSED", location: "Closed destination" },
          { id: "closed-policy-stop-open", type: "drop", orderId: "TST-SO-OPEN", location: "Open destination" }
        ]
      }]
    }];
    await query(
      `INSERT INTO dispatch_plan_snapshots (
         plan_id, orders, trucks, summary, schema_version, plan_digest,
         order_count, truck_count, load_count, stop_count
       ) VALUES ($1, $2::jsonb, $3::jsonb, '{}'::jsonb, 2, 'closed-policy-stale', 2, 1, 1, 2)`,
      [planId, JSON.stringify(planOrders), JSON.stringify(planTrucks)]
    );

    const legacyPlan = await getDispatchPlan(planId);
    assert.deepEqual(legacyPlan.orders.map((order) => order.id), ["TST-SO-OPEN"]);
    assert.deepEqual(legacyPlan.trucks[0].loads[0].stops.map((stop) => stop.orderId), ["TST-SO-OPEN"]);
    const currentSnapshot = await getDispatchPlanSnapshot(`current-${planId}`);
    assert.deepEqual(currentSnapshot.orders.map((order) => order.id), ["TST-SO-OPEN"]);
    const v2Plan = await getDispatchV2Bootstrap({ planId });
    assert.doesNotMatch(JSON.stringify(v2Plan), /TST-SO-CLOSED/);
    assert.match(JSON.stringify(v2Plan), /TST-SO-OPEN/);
    const rejectedCommandId = "closed-order-policy-v2-command";
    await assert.rejects(
      applyDispatchV2Command({
        planId,
        command: {
          commandId: rejectedCommandId,
          commandType: "assign_order",
          baseRevision: v2Plan.plan.revision,
          baseDigest: v2Plan.plan.digest,
          payload: {
            orderRef: "TST-SO-CLOSED",
            loadId: "closed-policy-load",
            truckId: "closed-policy-truck"
          }
        },
        actorId: 1
      }),
      (error) => error?.code === "NETSUITE_ORDER_CLOSED"
    );
    const rejectedCommandEffects = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM dispatch_plan_commands WHERE command_id = $1) AS command_count,
         (SELECT COUNT(*)::int FROM dispatch_plan_followup_outbox WHERE command_id = $1) AS outbox_count`,
      [rejectedCommandId]
    );
    assert.deepEqual(
      rejectedCommandEffects.rows[0],
      { command_count: 0, outbox_count: 0 },
      "Rejected Dispatch commands must not leave a receipt or follow-up event."
    );
    const driverDay = await getDriverDayJobs("closed-policy-driver", { date: planDate });
    assert.equal(driverDay.jobs.some((job) => job.orderRefs?.includes("TST-SO-CLOSED")), false);
    assert.equal(driverDay.jobs.some((job) => job.orderRefs?.includes("TST-SO-OPEN")), true);
  });
  console.log("NetSuite Closed-order repository harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}
