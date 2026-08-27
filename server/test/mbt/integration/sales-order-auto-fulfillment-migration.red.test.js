// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  claimSalesOrderAutoFulfillmentCandidate,
  prepareSalesOrderAutoFulfillmentCandidate,
  previewHistoricalSalesOrderAutoFulfillmentEvents,
  queueHistoricalSalesOrderAutoFulfillmentCandidates
} from "../../../src/sales-order-auto-fulfillment-repository.js";

after(closeDb);

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

async function seedDirectPoRoute() {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
  const salesOrderId = 9_820_000_000 + Math.floor(Math.random() * 100_000);
  const purchaseOrderId = salesOrderId + 1;
  const salesOrderRef = `SO-AUTOIF-${suffix}`;
  const purchaseOrderRef = `PO-AUTOIF-${suffix}`;
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       outbound_location_id, outbound_location, sales_order_type,
       operator_status, local_yard_order_status, fulfillment_status,
       netsuite_active, is_test_fixture
     ) VALUES ($1, $2, current_date, 'Auto IF customer', 'B', 'Pending Fulfillment',
               15, '12441', 'Delivery', 'loaded', 'Loaded', 'not_fulfilled', true, false)`,
    [salesOrderId, salesOrderRef]
  );
  const salesLine = await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku, item_type,
       quantity, unit, location_id, location, pallet_qty, piece_qty,
       to_plt, to_pcs, loaded_qty, netsuite_active
     ) VALUES ($1, 551001, 881001, 'Auto IF item', 'AUTO-IF-ITEM', 'InvtPart',
               10, 'EA', 15, '12441', 1, 10, 10, 1, 4, true)
     RETURNING id`,
    [salesOrderId]
  );
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor, status, status_text,
       destination_location_id, destination_location, receipt_status,
       netsuite_active
     ) VALUES ($1, $2, current_date, 'Auto IF vendor', 'B', 'Pending Receipt',
               15, '12441', 'open', true)`,
    [purchaseOrderId, purchaseOrderRef]
  );
  const purchaseLine = await query(
    `INSERT INTO purchase_order_lines (
       purchase_order_id, line_id, item_id, item_name, sku, item_type,
       quantity, unit, location_id, location, pallet_qty, piece_qty,
       to_plt, to_pcs, netsuite_active
     ) VALUES ($1, 661001, 881001, 'Auto IF item', 'AUTO-IF-ITEM', 'InvtPart',
               6, 'EA', 15, '12441', 0.6, 6, 10, 1, true)
     RETURNING id`,
    [purchaseOrderId]
  );
  const allocation = await query(
    `INSERT INTO dispatch_so_po_allocations (
       sales_order_id, sales_order_ref, sales_line_id,
       po_order_id, po_order_ref, po_line_id,
       item_id, item_name, sku,
       allocated_pallet_qty, allocated_piece_qty, allocated_sales_qty,
       status, details, dispatch_target_ref, dispatch_target_kind, dispatch_target_line_key
     ) VALUES ($1, $2, $3, $4, $5, $6, 881001, 'Auto IF item', 'AUTO-IF-ITEM',
               0.6, 6, 6, 'active', $7::jsonb, $2, 'normal', $8)
     RETURNING id`,
    [
      salesOrderId,
      salesOrderRef,
      salesLine.rows[0].id,
      purchaseOrderId,
      purchaseOrderRef,
      purchaseLine.rows[0].id,
      JSON.stringify({ poVendorYard: "AUTO IF Vendor Yard", poAddress: "1 Vendor Test Road" }),
      `${salesOrderRef}::${salesOrderRef}::${salesLine.rows[0].id}`
    ]
  );
  return {
    salesOrderId,
    salesOrderRef,
    salesLineId: salesLine.rows[0].id,
    salesOrderLine: 551001,
    allocationId: allocation.rows[0].id
  };
}

test("L7/L11 migration gates new completions and records immutable allocation-scoped PO execution", async () => {
  await inRollback(async () => {
    const fixture = await seedDirectPoRoute();
    const flagKey = "dispatch_netsuite_sales_order_if_12441";
    const flag = await query(
      `SELECT enabled, revision::int
         FROM mbt_feature_flags
        WHERE flag_key = $1`,
      [flagKey]
    );
    assert.equal(flag.rowCount, 1);
    assert.equal(flag.rows[0].enabled, false, "automatic SO IF gates must default off");

    const beforeEnable = await query(
      `SELECT COALESCE(MAX(id), 0)::bigint AS id FROM dispatch_order_completion_events`
    );
    await query(
      `UPDATE mbt_feature_flags
          SET enabled = true, revision = revision + 1,
              updated_by = 'auto-if-migration-test', updated_at = now()
        WHERE flag_key = $1`,
      [flagKey]
    );
    const watermark = await query(
      `SELECT activation_event_id, gate_revision::int
         FROM dispatch_sales_order_if_gate_watermarks
        WHERE gate_key = $1`,
      [flagKey]
    );
    assert.equal(watermark.rowCount, 1);
    assert.equal(String(watermark.rows[0].activation_event_id), String(beforeEnable.rows[0].id));

    const planId = 9_820_001;
    const loadId = `AUTO-IF-LOAD-${crypto.randomUUID()}`;
    const pickupJobId = `AUTO-IF-PICK-${crypto.randomUUID()}`;
    const dropJobId = `AUTO-IF-DROP-${crypto.randomUUID()}`;
    await query(
      `INSERT INTO dispatch_plans (id, plan_date, status, note, revision)
       VALUES ($1, current_date, 'confirmed', 'Auto IF migration fixture', 1)`,
      [planId]
    );
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_id, plan_date, driver_login, truck_plate, load_id, load_name,
         stop_id, stop_type, order_refs, status, completed_at, job_details
       ) VALUES (
         $1, $2, current_date, 'auto-if-driver', 'AUTOIF', $3, 'Load 1',
         'AUTO-IF-PICKUP', 'pickup', $4::jsonb, 'complete', now(), $5::jsonb
       )`,
      [
        pickupJobId,
        planId,
        loadId,
        JSON.stringify([fixture.salesOrderRef]),
        JSON.stringify({ pickupLocation: "AUTO IF Vendor Yard", location: "AUTO IF Vendor Yard" })
      ]
    );
    const pickupEvidence = await query(
      `SELECT allocation_id, phase, driver_job_id, load_id
         FROM dispatch_so_po_allocation_execution_events
        WHERE allocation_id = $1`,
      [fixture.allocationId]
    );
    assert.equal(pickupEvidence.rowCount, 1);
    assert.equal(pickupEvidence.rows[0].phase, "pickup");
    assert.equal(pickupEvidence.rows[0].driver_job_id, pickupJobId);

    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_id, plan_date, driver_login, truck_plate, load_id, load_name,
         stop_id, stop_type, order_refs, status, completed_at, job_details
       ) VALUES (
         $1, $2, current_date, 'auto-if-driver', 'AUTOIF', $3, 'Load 1',
         'AUTO-IF-DROPOFF', 'dropoff', $4::jsonb, 'complete', now(), $5::jsonb
       )`,
      [
        dropJobId,
        planId,
        loadId,
        JSON.stringify([fixture.salesOrderRef]),
        JSON.stringify({
          orders: [{ orderType: "SO", orderRef: fixture.salesOrderRef }],
          location: "Customer destination",
          dropLocation: "Customer destination"
        })
      ]
    );
    const execution = await query(
      `SELECT phase, driver_job_id
         FROM dispatch_so_po_allocation_execution_events
        WHERE allocation_id = $1
        ORDER BY phase`,
      [fixture.allocationId]
    );
    assert.deepEqual(execution.rows.map((row) => row.phase).sort(), ["delivered", "pickup"]);
    assert.equal(execution.rows.find((row) => row.phase === "delivered")?.driver_job_id, dropJobId);

    const candidate = await query(
      `SELECT candidate.id, candidate.status, candidate.dispatch_order_ref,
              candidate.completion_event_id, event.id AS event_id
         FROM dispatch_sales_order_if_candidates candidate
         JOIN dispatch_order_completion_events event ON event.id = candidate.completion_event_id
        WHERE lower(candidate.dispatch_order_ref) = lower($1)`,
      [fixture.salesOrderRef]
    );
    assert.equal(candidate.rowCount, 1);
    assert.equal(candidate.rows[0].status, "discovered");
    assert.equal(String(candidate.rows[0].completion_event_id), String(candidate.rows[0].event_id));
    assert.ok(Number(candidate.rows[0].completion_event_id) > Number(watermark.rows[0].activation_event_id));

    await query(
      `INSERT INTO operator_load_records (
         load_type, order_family, order_id, order_ref,
         operator_id, line_snapshot, response
       ) VALUES (
         'sales_order_delivery_load', 'sales_order', $1, $2,
         NULL, $3::jsonb, $4::jsonb
       )`,
      [
        fixture.salesOrderId,
        fixture.salesOrderRef,
        JSON.stringify([{ lineId: fixture.salesOrderLine, loadedQty: 4, loadedUom: "EA" }]),
        JSON.stringify({ localOnly: true, netSuiteUpdated: false })
      ]
    );
    const materialized = await prepareSalesOrderAutoFulfillmentCandidate(candidate.rows[0].id);
    assert.equal(materialized.status, "queued");
    assert.equal(materialized.sourceSalesOrderId, fixture.salesOrderId);
    assert.equal(materialized.lineSnapshot.length, 1);
    assert.deepEqual({
      target: materialized.lineSnapshot[0].targetQuantity,
      operator: materialized.lineSnapshot[0].operatorLoadedQuantity,
      po: materialized.lineSnapshot[0].completedPoQuantity,
      directTo: materialized.lineSnapshot[0].completedDirectToQuantity,
      delivered: materialized.lineSnapshot[0].deliveredQuantity
    }, { target: 10, operator: 4, po: 6, directTo: 0, delivered: 10 });
    assert.match(materialized.lineSnapshot[0].operatorLoadRecordId, /^\d+$/u);
    assert.equal(materialized.lineSnapshot[0].poEvidence[0].pickupLoadId, loadId);
    assert.equal(materialized.lineSnapshot[0].poEvidence[0].deliveryLoadId, loadId);

    await query(
      `UPDATE mbt_feature_flags
          SET enabled = false, revision = revision + 1,
              updated_by = 'auto-if-cutover-test', updated_at = now()
        WHERE flag_key = $1`,
      [flagKey]
    );
    const claimInput = {
      candidateId: materialized.id,
      workerId: "auto-if-cutover-test",
      payload: { externalId: materialized.externalId, item: { items: [] } },
      liveOrder: { closed: false, lines: [] },
      selectedLines: []
    };
    assert.equal(
      await claimSalesOrderAutoFulfillmentCandidate(claimInput),
      null,
      "turning the yard gate off must atomically fence a previously queued candidate"
    );
    const stoppedByGate = await prepareSalesOrderAutoFulfillmentCandidate(materialized.id);
    assert.equal(
      stoppedByGate.status,
      "gate_disabled",
      "a fenced candidate must leave the runnable queue instead of polling NetSuite repeatedly"
    );
    await query(
      `UPDATE mbt_feature_flags
          SET enabled = true, revision = revision + 1,
              updated_by = 'auto-if-cutover-test', updated_at = now()
        WHERE flag_key = $1`,
      [flagKey]
    );
    assert.equal(
      await claimSalesOrderAutoFulfillmentCandidate(claimInput),
      null,
      "re-enabling must not release a completion behind the new activation watermark"
    );

    const secondDropJobId = `AUTO-IF-DROP-${crypto.randomUUID()}`;
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_id, plan_date, driver_login, truck_plate, load_id, load_name,
         stop_id, stop_type, order_refs, status, completed_at, job_details
       ) VALUES (
         $1, $2, current_date, 'auto-if-driver', 'AUTOIF', $3, 'Load 1',
         'AUTO-IF-DROPOFF-REPLAY', 'dropoff', $4::jsonb, 'complete', now(), $5::jsonb
       )`,
      [
        secondDropJobId,
        planId,
        loadId,
        JSON.stringify([fixture.salesOrderRef]),
        JSON.stringify({ orders: [{ orderType: "SO", orderRef: fixture.salesOrderRef }] })
      ]
    );
    const secondCandidate = await query(
      `SELECT candidate.id
         FROM dispatch_sales_order_if_candidates candidate
         JOIN dispatch_order_completion_events event ON event.id = candidate.completion_event_id
        WHERE event.completion_evidence_id = $1`,
      [secondDropJobId]
    );
    assert.equal(secondCandidate.rowCount, 1);
    const contended = await prepareSalesOrderAutoFulfillmentCandidate(secondCandidate.rows[0].id);
    assert.equal(contended.status, "waiting_evidence");
    assert.match(contended.lastError, /already reserved/u);

    await assert.rejects(
      query(
        `UPDATE dispatch_so_po_allocation_execution_events
            SET driver_job_id = 'forged'
          WHERE allocation_id = $1 AND phase = 'pickup'`,
        [fixture.allocationId]
      ),
      /immutable|cannot be updated|mutation|append-only/iu
    );
  });
});

test("L11 an activation watermark stops backlog until Admin selects an exact historical event", async () => {
  await inRollback(async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
    const salesOrderId = 9_830_000_000 + Math.floor(Math.random() * 100_000);
    const salesOrderRef = `SO-HIST-${suffix}`;
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, trandate, customer, status, status_text,
         outbound_location_id, outbound_location, sales_order_type,
         operator_status, local_yard_order_status, fulfillment_status,
         netsuite_active, is_test_fixture
       ) VALUES (
         $1, $2, current_date, 'Historical IF customer', 'B', 'Pending Fulfillment',
         15, '12441', 'Delivery', 'loaded', 'Loaded', 'not_fulfilled', true, false
       )`,
      [salesOrderId, salesOrderRef]
    );
    await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, line_id, item_id, item_name, sku, item_type,
         quantity, unit, location_id, location, piece_qty, to_pcs,
         loaded_qty, netsuite_active
       ) VALUES (
         $1, 771001, 991001, 'Historical IF item', 'HIST-IF-ITEM', 'InvtPart',
         8, 'EA', 15, '12441', 8, 1, 8, true
       )`,
      [salesOrderId]
    );
    await query(
      `INSERT INTO operator_load_records (
         load_type, order_family, order_id, order_ref, line_snapshot, response
       ) VALUES (
         'sales_order_delivery_load', 'sales_order', $1, $2, $3::jsonb, '{}'::jsonb
       )`,
      [salesOrderId, salesOrderRef, JSON.stringify([{ lineId: 771001, loadedQty: 8 }])]
    );
    const completion = await query(
      `INSERT INTO dispatch_order_completion_events (
         order_kind, order_ref, dispatch_completed_at,
         completion_evidence_type, completion_evidence_id,
         actor_type, actor_id, reason
       ) VALUES (
         'SO', $1, now(), 'driver_job', $2, 'driver', 'historical-driver', ''
       ) RETURNING id`,
      [salesOrderRef, `HIST-JOB-${suffix}`]
    );
    await query(
      `UPDATE mbt_feature_flags
          SET enabled = true, revision = revision + 1,
              updated_by = 'historical-admin', updated_at = now()
        WHERE flag_key = 'dispatch_netsuite_sales_order_if_12441'`
    );
    const candidate = await query(
      `SELECT id FROM dispatch_sales_order_if_candidates WHERE completion_event_id = $1`,
      [completion.rows[0].id]
    );
    const stopped = await prepareSalesOrderAutoFulfillmentCandidate(candidate.rows[0].id);
    assert.equal(stopped.status, "historical");

    const preview = await previewHistoricalSalesOrderAutoFulfillmentEvents({ search: salesOrderRef });
    assert.equal(preview.length, 1);
    assert.equal(preview[0].eventId, String(completion.rows[0].id));
    assert.equal(preview[0].supported, true);

    const queued = await queueHistoricalSalesOrderAutoFulfillmentCandidates({
      completionEventIds: [completion.rows[0].id],
      reason: "Reviewed immutable Driver completion before activation",
      actorId: "historical-admin"
    });
    assert.equal(queued.length, 1);
    const materialized = await prepareSalesOrderAutoFulfillmentCandidate(queued[0].id);
    assert.equal(materialized.status, "queued");
    assert.equal(materialized.lineSnapshot[0].deliveredQuantity, 8);
    const audit = await query(
      `SELECT actor_id, reason
         FROM dispatch_sales_order_if_audit_events
        WHERE candidate_id = $1 AND action = 'admin_historical_backfill'`,
      [queued[0].id]
    );
    assert.deepEqual(audit.rows[0], {
      actor_id: "historical-admin",
      reason: "Reviewed immutable Driver completion before activation"
    });
  });
});

test("L2/L7 direct TO quantity requires the exact dependency pickup and customer-drop job", async () => {
  await inRollback(async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
    const salesOrderId = 9_850_000_000 + Math.floor(Math.random() * 100_000);
    const transferOrderId = salesOrderId + 1;
    const salesOrderRef = `SO-DIRECT-TO-${suffix}`;
    const transferOrderRef = `TO-DIRECT-${suffix}`;
    const planId = 9_850_001 + Math.floor(Math.random() * 10_000);
    const loadId = `DIRECT-TO-LOAD-${suffix}`;
    const pickupJobId = `DIRECT-TO-PICK-${suffix}`;
    const exactDropJobId = `DIRECT-TO-DROP-${suffix}`;
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, trandate, customer, status, status_text,
         outbound_location_id, outbound_location, sales_order_type,
         operator_status, local_yard_order_status, fulfillment_status,
         netsuite_active, is_test_fixture
       ) VALUES (
         $1, $2, current_date, 'Direct TO customer', 'B', 'Pending Fulfillment',
         15, '12441', 'Delivery', 'loaded', 'Loaded', 'not_fulfilled', true, false
       )`,
      [salesOrderId, salesOrderRef]
    );
    const salesLine = await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, line_id, item_id, item_name, sku, item_type,
         quantity, unit, location_id, location, piece_qty, to_pcs,
         loaded_qty, netsuite_active
       ) VALUES (
         $1, 991001, 993001, 'Direct TO item', 'DIRECT-TO-ITEM', 'InvtPart',
         10, 'EA', 15, '12441', 10, 1, 4, true
       ) RETURNING id`,
      [salesOrderId]
    );
    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, trandate, status, status_text,
         from_location_id, from_location, to_location_id, to_location,
         outbound_operator_status, local_yard_order_status,
         fulfillment_status, netsuite_active
       ) VALUES (
         $1, $2, current_date, 'B', 'Pending Fulfillment',
         28, '2967', 15, '12441', 'open', 'Open', 'not_fulfilled', true
       )`,
      [transferOrderId, transferOrderRef]
    );
    await query(
      `INSERT INTO dispatch_plans (id, plan_date, status, note, revision)
       VALUES ($1, current_date, 'confirmed', 'Direct TO IF fixture', 1)`,
      [planId]
    );
    const dependency = await query(
      `INSERT INTO order_dependencies (
         sales_order_id, sales_order_ref, transfer_order_id, transfer_order_ref,
         dependency_mode, same_load_required, status,
         source_location_id, source_location,
         accounting_destination_location_id, accounting_destination_location,
         planned_plan_id, planned_date, planned_load_id, planned_load_name,
         direct_receipt_job_id, direct_received_at,
         dispatch_target_ref, dispatch_target_kind
       ) VALUES (
         $1, $2, $3, $4, 'direct_to_customer', true, 'received_local',
         28, '2967', 15, '12441', $5, current_date, $6, 'Load 1',
         $7, now(), $2, 'normal'
       ) RETURNING id`,
      [salesOrderId, salesOrderRef, transferOrderId, transferOrderRef, planId, loadId, exactDropJobId]
    );
    await query(
      `INSERT INTO order_dependency_lines (
         dependency_id, sales_line_id, item_id, item_name, unit,
         allocated_quantity, piece_qty, line_role, dispatch_target_line_key
       ) VALUES (
         $1, $2, 993001, 'Direct TO item', 'EA',
         6, 6, 'sales_allocation', $3
       )`,
      [dependency.rows[0].id, salesLine.rows[0].id, `${salesOrderRef}::${salesOrderRef}::${salesLine.rows[0].id}`]
    );
    await query(
      `INSERT INTO operator_load_records (
         load_type, order_family, order_id, order_ref, line_snapshot, response
       ) VALUES (
         'sales_order_delivery_load', 'sales_order', $1, $2, $3::jsonb, '{}'::jsonb
       )`,
      [salesOrderId, salesOrderRef, JSON.stringify([{ lineId: 991001, loadedQty: 4 }])]
    );
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_id, plan_date, driver_login, truck_plate, load_id, load_name,
         stop_id, stop_type, order_refs, status, completed_at, job_details
       ) VALUES (
         $1, $2, current_date, 'direct-to-driver', 'DIRECTTO', $3, 'Load 1',
         'DIRECT-TO-PICKUP', 'pickup', $4::jsonb, 'complete', now(), $5::jsonb
       )`,
      [
        pickupJobId,
        planId,
        loadId,
        JSON.stringify([transferOrderRef]),
        JSON.stringify({ orders: [{ source: "direct_dependency", orderRef: transferOrderRef }] })
      ]
    );
    await query(
      `UPDATE mbt_feature_flags
          SET enabled = true, revision = revision + 1,
              updated_by = 'direct-to-admin', updated_at = now()
        WHERE flag_key = 'dispatch_netsuite_sales_order_if_12441'`
    );
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_id, plan_date, driver_login, truck_plate, load_id, load_name,
         stop_id, stop_type, order_refs, status, completed_at, job_details
       ) VALUES (
         $1, $2, current_date, 'direct-to-driver', 'DIRECTTO', $3, 'Load 1',
         'DIRECT-TO-DROPOFF', 'dropoff', $4::jsonb, 'complete', now(), $5::jsonb
       )`,
      [
        exactDropJobId,
        planId,
        loadId,
        JSON.stringify([salesOrderRef, transferOrderRef]),
        JSON.stringify({ orders: [{ orderType: "SO", orderRef: salesOrderRef }] })
      ]
    );
    const exactCandidate = await query(
      `SELECT candidate.id
         FROM dispatch_sales_order_if_candidates candidate
         JOIN dispatch_order_completion_events event ON event.id = candidate.completion_event_id
        WHERE event.order_kind = 'SO' AND event.completion_evidence_id = $1`,
      [exactDropJobId]
    );
    const exact = await prepareSalesOrderAutoFulfillmentCandidate(exactCandidate.rows[0].id);
    assert.equal(exact.status, "queued");
    assert.deepEqual({
      operator: exact.lineSnapshot[0].operatorLoadedQuantity,
      directTo: exact.lineSnapshot[0].completedDirectToQuantity,
      delivered: exact.lineSnapshot[0].deliveredQuantity
    }, { operator: 4, directTo: 6, delivered: 10 });
    assert.equal(exact.lineSnapshot[0].toEvidence[0].pickupJobId, pickupJobId);
    assert.equal(exact.lineSnapshot[0].toEvidence[0].deliveryJobId, exactDropJobId);
    assert.equal(exact.lineSnapshot[0].toEvidence[0].planId, planId);
    assert.equal(exact.lineSnapshot[0].toEvidence[0].loadId, loadId);

    const wrongDropJobId = `DIRECT-TO-WRONG-DROP-${suffix}`;
    await query(
      `INSERT INTO driver_job_records (
         job_id, plan_id, plan_date, driver_login, truck_plate, load_id, load_name,
         stop_id, stop_type, order_refs, status, completed_at, job_details
       ) VALUES (
         $1, $2, current_date, 'direct-to-driver', 'DIRECTTO', $3, 'Load 1',
         'DIRECT-TO-WRONG-DROPOFF', 'dropoff', $4::jsonb, 'complete', now(), $5::jsonb
       )`,
      [wrongDropJobId, planId, loadId, JSON.stringify([salesOrderRef]), JSON.stringify({ orders: [{ orderType: "SO", orderRef: salesOrderRef }] })]
    );
    const wrongCandidate = await query(
      `SELECT candidate.id
         FROM dispatch_sales_order_if_candidates candidate
         JOIN dispatch_order_completion_events event ON event.id = candidate.completion_event_id
        WHERE event.order_kind = 'SO' AND event.completion_evidence_id = $1`,
      [wrongDropJobId]
    );
    const rejected = await prepareSalesOrderAutoFulfillmentCandidate(wrongCandidate.rows[0].id);
    assert.equal(rejected.status, "waiting_evidence");
    assert.match(rejected.lastError, /does not conserve/u);
  });
});
