// @ts-check

import crypto from "node:crypto";

import { query } from "../../src/db.js";

function fixtureNumber() {
  return Number.parseInt(crypto.randomUUID().replaceAll("-", "").slice(0, 8), 16);
}

/**
 * @param {{actorId?: string, label?: string}} [options]
 */
export async function createSalesOrderReattemptCorrectionFixture(options = {}) {
  const { actorId, label = "fixture" } = options;
  if (!actorId) {
    throw new Error("A fixture actor is required.");
  }
  const suffix = fixtureNumber();
  const orderId = 9_600_000_000 + suffix;
  const netsuiteLineId = 5_100_000_000 + suffix;
  const historicalItemId = 6_100_000_000 + suffix;
  const currentItemId = historicalItemId + 1;
  const orderRef = `SO-REAT-CORR-${label}-${suffix}`.toUpperCase();
  const childRef = `${orderRef}-R1`;

  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       outbound_location_id, outbound_location, sales_order_type,
       operator_status, local_yard_order_status, fulfillment_status,
       netsuite_active, dispatch_address, dispatch_planned
     ) VALUES (
       $1, $2, CURRENT_DATE, 'Correction fixture customer', 'B',
       'Sales Order : Pending Fulfillment', 15, '12441', 'Delivery',
       'loaded', 'Loaded', 'not_fulfilled', true,
       '77 Clarence St, Woodbridge, ON L4L 1L4', true
     )`,
    [orderId, orderRef]
  );
  const line = await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku, item_description,
       item_type, quantity, unit, location_id, location,
       pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs, loaded_qty, loaded_uom,
       item_weight, netsuite_active, confirmed
     ) VALUES (
       $1, $2, $3, 'CURRENT-GN', 'CURRENT-GN', 'Current granite',
       'InvtPart', 1470.08, 'SQFT', 15, '12441', 16, 0, 0, 0,
       91.88, 10.21, 0, 0, 1470.08, 'SQFT', 32.02, true, false
     ) RETURNING id`,
    [orderId, netsuiteLineId, currentItemId]
  );
  const sourceLoad = await query(
    `INSERT INTO operator_load_records (
       load_type, order_family, order_id, order_ref, operator_id,
       photo_data_url, photo_data_urls, line_snapshot, response
     ) VALUES (
       'sales_order_delivery_load', 'sales_order', $1, $2, $3,
       'data:image/jpeg;base64,aGlzdG9yaWNhbA==',
       '["data:image/jpeg;base64,aGlzdG9yaWNhbA=="]'::jsonb,
       $4::jsonb, '{}'::jsonb
     ) RETURNING id`,
    [orderId, orderRef, actorId, JSON.stringify([{
      lineId: String(netsuiteLineId),
      itemId: String(historicalItemId),
      itemName: "HISTORICAL-CG",
      sku: "HISTORICAL-CG",
      loadedQty: 1470.08,
      loadedUom: "SQFT"
    }])]
  );
  const cycle = await query(
    `INSERT INTO operator_reload_cycles (
       sales_order_id, order_ref, outbound_location_id, cycle_number,
       request_id, status, reason, netsuite_status, netsuite_status_text,
       authorized_by, workflow_kind, source_load_record_id, reattempt_order_ref
     ) VALUES (
       $1, $2, 15, 1, $3::uuid, 'authorized',
       'Correction concurrency fixture', 'B', 'Pending Fulfillment',
       $4, 'sales_order_reattempt', $5, $6
     ) RETURNING id`,
    [orderId, orderRef, crypto.randomUUID(), actorId, sourceLoad.rows[0].id, childRef]
  );
  await query(
    `INSERT INTO operator_reload_cycle_lines (
       cycle_id, sales_order_line_id, netsuite_line_id, item_id,
       item_name, sku, item_description, sales_uom,
       target_sales_qty, target_pallet_qty, to_plt,
       line_key, historical_line_index, historical_line_id, historical_item_id,
       historical_item_name, historical_sku, historical_description, historical_sales_uom,
       historical_loaded_sales_qty, historical_pallet_qty,
       current_sales_order_line_id, current_line_id, current_item_id,
       current_item_name, current_sku, current_description, current_sales_qty, current_sales_uom,
       sku_mismatch, item_mismatch, selected_for_reattempt, selection_reason,
       already_delivered_sales_qty, already_delivered_pallet_qty, item_weight
     ) VALUES (
       $1, $2, $3, $4,
       'HISTORICAL-CG', 'HISTORICAL-CG', 'Historical grey', 'SQFT',
       1470.08, 16, 91.88,
       $5, 0, $3, $4,
       'HISTORICAL-CG', 'HISTORICAL-CG', 'Historical grey', 'SQFT',
       1470.08, 16,
       $2, $3, $6,
       'CURRENT-GN', 'CURRENT-GN', 'Current granite', 1470.08, 'SQFT',
       true, true, true, 'Physically deliver the current item',
       0, 0, 32.02
     )`,
    [cycle.rows[0].id, line.rows[0].id, netsuiteLineId, historicalItemId, `fixture:${suffix}:0`, currentItemId]
  );
  const lineSnapshot = [{
    lineId: netsuiteLineId,
    itemId: historicalItemId,
    itemName: "HISTORICAL-CG",
    sku: "HISTORICAL-CG",
    description: "Historical grey",
    unit: "SQFT",
    quantity: 1470.08,
    salesQty: 1470.08,
    pallets: 16,
    historicalItemId,
    historicalSku: "HISTORICAL-CG",
    currentItemId,
    currentSku: "CURRENT-GN"
  }];
  const child = await query(
    `INSERT INTO dispatch_custom_orders (
       ref_number, pickup_location, dropoff_location, order_details, weight_lbs,
       status, completed_at, created_by, updated_by,
       order_kind, system_managed, parent_sales_order_id, parent_order_ref,
       reload_cycle_id, line_snapshot, pallet_qty, sales_qty, billing_disposition
     ) VALUES (
       $1, '12441', '77 Clarence St, Woodbridge, ON L4L 1L4',
       'Sales Order re-attempt fixture', 47071.9616,
       'completed', now(), $2, 'driver:fixture',
       'sales_order_reattempt', true, $3, $4,
       $5, $6::jsonb, 16, 1470.08, 'linked_parent_no_charge'
     ) RETURNING id`,
    [childRef, actorId, orderId, orderRef, cycle.rows[0].id, JSON.stringify(lineSnapshot)]
  );
  await query(
    "UPDATE operator_reload_cycles SET reattempt_order_id = $2 WHERE id = $1",
    [cycle.rows[0].id, child.rows[0].id]
  );
  const plan = await query(
    `INSERT INTO dispatch_plans (plan_date, status, note)
     VALUES (DATE '2098-12-30', 'confirmed', 'Correction shared fixture plan')
     ON CONFLICT (plan_date) DO UPDATE SET note = EXCLUDED.note
     RETURNING id`
  );
  await query(
    `INSERT INTO driver_job_records (
       job_id, plan_id, plan_date, driver_login, truck_plate, load_id, load_name,
       stop_id, stop_type, order_refs, photo_data_urls, status, started_at, completed_at
     ) VALUES (
       $1, $2, DATE '2098-12-30', 'fixture-driver', 'FIXTURE-TRUCK',
       'FIXTURE-L1', 'Fixture Load', $3, 'dropoff', $4::jsonb,
       '["r2://driver/immutable-fixture-photo.jpg"]'::jsonb,
       'complete', now() - interval '15 minutes', now() - interval '5 minutes'
     )`,
    [`CORRECTION-FIXTURE-${suffix}`, plan.rows[0].id, `FIXTURE-DROP-${suffix}`, JSON.stringify([childRef])]
  );

  return {
    actorId,
    orderId,
    orderRef,
    childId: Number(child.rows[0].id),
    childRef,
    cycleId: Number(cycle.rows[0].id),
    lineId: Number(line.rows[0].id),
    netsuiteLineId,
    historicalItemId,
    currentItemId,
    sourceLoadId: Number(sourceLoad.rows[0].id),
    planId: Number(plan.rows[0].id)
  };
}

/**
 * @param {Array<Awaited<ReturnType<typeof createSalesOrderReattemptCorrectionFixture>>>} [fixtures]
 */
export async function removeSalesOrderReattemptCorrectionFixtures(fixtures = []) {
  const values = fixtures.filter(Boolean);
  if (!values.length) {
    return;
  }
  const childIds = values.map((entry) => entry.childId);
  const cycleIds = values.map((entry) => entry.cycleId);
  const sourceLoadIds = values.map((entry) => entry.sourceLoadId);
  const lineIds = values.map((entry) => entry.lineId);
  const orderIds = values.map((entry) => entry.orderId);
  const childRefs = values.map((entry) => entry.childRef);
  const operatorIds = [...new Set(values.map((entry) => entry.actorId))];

  await query("DELETE FROM delivery_audit_log WHERE order_id = ANY($1::bigint[])", [orderIds]);
  await query("DELETE FROM dispatch_order_completion_events WHERE lower(order_ref) = ANY($1::text[])", [childRefs.map((ref) => ref.toLowerCase())]);
  await query(
    `DELETE FROM driver_job_records record
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(record.order_refs) reference(value)
         WHERE lower(btrim(reference.value)) = ANY($1::text[])
      )`,
    [childRefs.map((ref) => ref.toLowerCase())]
  );
  await query("DELETE FROM sales_order_reattempt_item_corrections WHERE reattempt_order_id = ANY($1::bigint[])", [childIds]);
  await query("UPDATE operator_reload_cycles SET reattempt_order_id = NULL WHERE id = ANY($1::bigint[])", [cycleIds]);
  await query("DELETE FROM dispatch_custom_orders WHERE id = ANY($1::bigint[])", [childIds]);
  await query("DELETE FROM operator_reload_cycle_lines WHERE cycle_id = ANY($1::bigint[])", [cycleIds]);
  await query("DELETE FROM operator_reload_cycles WHERE id = ANY($1::bigint[])", [cycleIds]);
  await query("DELETE FROM operator_load_records WHERE id = ANY($1::bigint[])", [sourceLoadIds]);
  await query("DELETE FROM sales_order_lines WHERE id = ANY($1::bigint[])", [lineIds]);
  await query("DELETE FROM sales_orders WHERE netsuite_id = ANY($1::bigint[])", [orderIds]);
  await query("DELETE FROM operator_sessions WHERE operator_id = ANY($1::text[])", [operatorIds]);
  await query("DELETE FROM operators WHERE id = ANY($1::text[])", [operatorIds]);
  await query(
    `DELETE FROM dispatch_plans plan
      WHERE plan.id = ANY($1::bigint[])
        AND plan.note = 'Correction shared fixture plan'
        AND NOT EXISTS (SELECT 1 FROM driver_job_records record WHERE record.plan_id = plan.id)`,
    [[...new Set(values.map((entry) => entry.planId))]]
  );
}
