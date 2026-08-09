import assert from "node:assert/strict";
import { closeDb, query, withTransaction } from "./db.js";
import { getYardMovementDetail, listYardMovementCsvRows } from "./yard-movement-repository.js";
import { assertSalesOrderReloadEligibility } from "./sales-order-reload.js";
import {
  createReloadCycle,
  lockReloadAuthorizationSnapshot,
  recordReloadLoadAttempt,
  updateReloadCycleStatus,
  updateReloadPackedQuantity
} from "./sales-order-reload-repository.js";

const runId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const orderId = 9990000000 + Number(runId.slice(-7));
const orderRef = `SOMRH${runId}`;
const operatorId = `reload-history-${runId}`;
const photos = [
  "data:image/jpeg;base64,cmVsb2FkLWhpc3RvcnktMQ==",
  "data:image/jpeg;base64,cmVsb2FkLWhpc3RvcnktMg=="
];
const today = new Date().toISOString().slice(0, 10);

try {
  await withTransaction(async () => {
    await query(
      `INSERT INTO operators (
         id, username, display_name, password_hash, password_salt, role, roles, yard_location_ids
       ) VALUES ($1, $2, 'Re-load History Operator', 'hash', 'salt', 'yard_manager', $3::text[], $4::integer[])`,
      [operatorId, operatorId, ["yard_manager"], [15]]
    );
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, trandate, customer, status, status_text,
         outbound_location_id, outbound_location, sales_order_type,
         operator_status, local_yard_order_status, fulfillment_status, netsuite_active
       ) VALUES (
         $1, $2, CURRENT_DATE, 'Re-load History Customer', 'B', 'Sales Order : Pending Fulfillment',
         15, '12441', 'Delivery', 'loaded', 'Loaded', 'not_fulfilled', true
       )`,
      [orderId, orderRef]
    );
    const lineResult = await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, line_id, item_id, item_name, sku, item_description,
         item_type, quantity, unit, location_id, location, pallet_qty,
         to_plt, to_lyr, to_sec, to_pcs, loaded_qty, loaded_uom, netsuite_active
       ) VALUES (
         $1, 73001, 1354, 'History Item', 'RELOAD-HISTORY', 'Attempt history item',
         'InvtPart', 61.5, 'SQFT', 15, '12441', 1,
         61.5, 10.25, 0, 0, 61.5, 'SQFT', true
       ) RETURNING id`,
      [orderId]
    );
    const lineId = Number(lineResult.rows[0].id);
    await query(
      `INSERT INTO operator_load_records (
         load_type, order_family, order_id, order_ref, operator_id,
         photo_data_url, photo_data_urls, line_snapshot, response
       ) VALUES (
         'sales_order_delivery_load', 'sales_order', $1, $2, $3,
         $4, $5::jsonb, $6::jsonb, $7::jsonb
       )`,
      [
        orderId,
        orderRef,
        operatorId,
        photos[0],
        JSON.stringify(photos),
        JSON.stringify([{ lineId: 73001, itemId: 1354, itemName: "History Item", sku: "RELOAD-HISTORY", description: "Attempt history item", loadedQty: 61.5, loadedUom: "SQFT" }]),
        JSON.stringify({ localYardOrderStatus: "Loaded" })
      ]
    );

    const eligibility = assertSalesOrderReloadEligibility(await lockReloadAuthorizationSnapshot(orderId));
    const cycle = await createReloadCycle({
      order: eligibility.order,
      targets: eligibility.targets,
      reason: "History must keep both physical attempts",
      requestId: "c3f63fd5-7b2c-4f18-9f8e-5de2a0e0e301",
      actor: { id: operatorId }
    });
    await updateReloadPackedQuantity({
      orderId,
      lineId,
      values: { pallets: 1 },
      operatorId,
      absolute: true
    });
    await updateReloadCycleStatus({ orderId, status: "packed", operatorId });
    await recordReloadLoadAttempt(orderId, operatorId, {
      photoDataUrls: photos,
      requestId: "c3f63fd5-7b2c-4f18-9f8e-5de2a0e0e302"
    });

    const detail = await getYardMovementDetail({
      direction: "outbound",
      orderType: "sales_order",
      orderId,
      from: today,
      to: today
    });
    assert.ok(detail);
    assert.equal(detail.loadAttempts.length, 2, "Original load and re-load must render as separate physical attempts.");
    assert.deepEqual(detail.loadAttempts.map((attempt) => attempt.attemptKind).sort(), ["original", "reload"]);
    const original = detail.loadAttempts.find((attempt) => attempt.attemptKind === "original");
    const reload = detail.loadAttempts.find((attempt) => attempt.attemptKind === "reload");
    assert.equal(original.quantityBasis, "legacy_recorded_state");
    assert.equal(reload.quantityBasis, "exact_attempt");
    assert.equal(reload.cycleNumber, 1);
    assert.equal(reload.reason, "History must keep both physical attempts");
    assert.equal(reload.operatorName, "Re-load History Operator");
    assert.equal(reload.authorizedByName, "Re-load History Operator");
    assert.equal(reload.photos.length, 2);
    assert.equal(reload.attemptLines.length, 1);
    assert.equal(Number(reload.attemptLines[0].loadedQty), 61.5);
    assert.equal(detail.activeReloadCycle, null);

    const csvRows = await listYardMovementCsvRows({
      from: today,
      to: today,
      yard: "15",
      direction: "outbound",
      orderType: "sales_order",
      search: orderRef
    });
    assert.equal(csvRows.length, 2, "CSV must emit one row per line per physical load attempt.");
    assert.deepEqual(csvRows.map((row) => row.attempt_kind).sort(), ["original", "reload"]);
    assert.ok(csvRows.every((row) => Number(row.processed_qty) === 61.5));
    const reloadCsv = csvRows.find((row) => row.attempt_kind === "reload");
    assert.equal(reloadCsv.attempt_cycle_number, 1);
    assert.equal(reloadCsv.attempt_reason, "History must keep both physical attempts");
    assert.equal(reloadCsv.attempt_operator, "Re-load History Operator");
    assert.equal(reloadCsv.attempt_authorized_by, "Re-load History Operator");
    assert.equal(reloadCsv.attempt_quantity_basis, "exact_attempt");
    assert.equal(Number(reloadCsv.attempt_id) > 0, true);
    assert.equal(String(reloadCsv.attempt_processed_at).length > 0, true);
    assert.equal(cycle.cycleNumber, 1);
  }, { rollback: true });

  console.log(JSON.stringify({ ok: true, scenarios: 25, separateAttempts: 2, csvAttemptRows: 2 }));
} finally {
  await closeDb();
}
