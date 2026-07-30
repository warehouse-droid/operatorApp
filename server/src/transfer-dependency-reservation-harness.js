import assert from "node:assert/strict";
import { config } from "./config.js";
import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  generateTransferDependencySuggestion,
  getDependencyInventoryMatrix,
  getTransferDependencyBatch,
  validateTransferDependencyBatchForCreation
} from "./order-dependency-repository.js";
import { searchTransferDependencyProposalItems } from "./transfer-dependency-manual-items.js";

const rollback = await beginRollbackContext();
const suffix = Number(String(Date.now()).slice(-7));
const salesOrderId = 9881000000 + suffix;
const competingSalesOrderId = salesOrderId + 1;
const itemId = 9882000000 + suffix;
const manualItemId = itemId + 1;
const salesLineKey = 9883000000 + suffix;
const competingSalesLineKey = salesLineKey + 1;
const competingManualSalesLineKey = salesLineKey + 2;
const transferOrderId = 9884000000 + suffix;
const salesOrderRef = `TST-RESERVE-SO-${suffix}`;
const competingSalesOrderRef = `TST-RESERVE-OTHER-${suffix}`;
const transferOrderRef = `TST-RESERVE-TO-${suffix}`;
const operatorId = `reservation-harness-${suffix}`;
const savedMapsKey = config.googleMapsApiKey;

try {
  await rollback.run(async () => {
    config.googleMapsApiKey = "";
    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, display_name, item_type, item_type_text,
         stock_unit, to_plt, to_lyr, to_sec, to_pcs, item_weight
       ) VALUES (
         $1, 'RESERVATION-OVERRIDE-ITEM', 'Reservation Override Fixture',
         'InvtPart', 'Inventory Item', 'EA', 1, 0, 0, 1, 1
       )`,
      [itemId]
    );
    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, display_name, item_type, item_type_text,
         stock_unit, to_plt, to_lyr, to_sec, to_pcs, item_weight
       ) VALUES (
         $1, 'LINKED-TO-MANUAL-ITEM', 'Linked TO Manual Item',
         'InvtPart', 'Inventory Item', 'EA', 1, 0, 0, 1, 1
       )`,
      [manualItemId]
    );
    await query(
      `INSERT INTO inventory_balances (
         item_id, location_id, location, quantity_on_hand, quantity_available
       ) VALUES
         ($1, 1, '3445', 10, 10),
         ($1, 28, '2967', 0, 0),
         ($1, 15, '12441', 0, 0),
         ($1, 26, '150', 0, 0)`,
      [itemId]
    );
    await query(
      `INSERT INTO inventory_balances (
         item_id, location_id, location, quantity_on_hand, quantity_available
       ) VALUES
         ($1, 1, '3445', 20, 20),
         ($1, 28, '2967', 0, 0),
         ($1, 15, '12441', 0, 0),
         ($1, 26, '150', 0, 0)`,
      [manualItemId]
    );
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, trandate, customer, status, status_text,
         outbound_location_id, outbound_location, sales_order_type,
         fulfillment_status, operator_status, local_yard_order_status,
         dispatch_address, netsuite_active
       ) VALUES
         ($1, $2, DATE '2097-07-29', 'Reservation Override Customer',
          'B', 'Pending Fulfillment', 15, '12441', 'Delivery',
          'open', 'open', 'Open', '100 Test Street, Toronto, ON', true),
         ($3, $4, DATE '2097-07-29', 'Competing Reservation Customer',
          'B', 'Pending Fulfillment', 15, '12441', 'Delivery',
          'open', 'open', 'Open', '200 Test Street, Toronto, ON', true)`,
      [salesOrderId, salesOrderRef, competingSalesOrderId, competingSalesOrderRef]
    );
    await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, line_id, item_id, item_name, sku, item_type,
         item_type_text, quantity, unit, pallet_qty, to_plt, to_pcs,
         netsuite_committed_qty, netsuite_backordered_qty, netsuite_active,
         location_id, location
       ) VALUES (
         $1, $2, $3, 'RESERVATION-OVERRIDE-ITEM', 'RESERVATION-OVERRIDE-ITEM',
         'InvtPart', 'Inventory Item', 6, 'EA', 6, 1, 1,
         0, 6, true, 15, '12441'
       )`,
      [salesOrderId, salesLineKey, itemId]
    );
    const competingSalesLine = await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, line_id, item_id, item_name, sku, item_type,
         item_type_text, quantity, unit, pallet_qty, to_plt, to_pcs,
         netsuite_committed_qty, netsuite_backordered_qty, netsuite_active,
         location_id, location
       ) VALUES (
         $1, $2, $3, 'RESERVATION-OVERRIDE-ITEM', 'RESERVATION-OVERRIDE-ITEM',
         'InvtPart', 'Inventory Item', 10, 'EA', 10, 1, 1,
         0, 10, true, 15, '12441'
       ) RETURNING id`,
      [competingSalesOrderId, competingSalesLineKey, itemId]
    );
    const competingManualSalesLine = await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, line_id, item_id, item_name, sku, item_type,
         item_type_text, quantity, unit, pallet_qty, to_plt, to_pcs,
         netsuite_committed_qty, netsuite_backordered_qty, netsuite_active,
         location_id, location
       ) VALUES (
         $1, $2, $3, 'LINKED-TO-MANUAL-ITEM', 'LINKED-TO-MANUAL-ITEM',
         'InvtPart', 'Inventory Item', 7, 'EA', 7, 1, 1,
         0, 7, true, 15, '12441'
       ) RETURNING id`,
      [competingSalesOrderId, competingManualSalesLineKey, manualItemId]
    );
    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, status, status_text,
         from_location_id, from_location, to_location_id, to_location,
         netsuite_active
       ) VALUES (
         $1, $2, 'B', 'Pending Fulfillment',
         1, '3445', 15, '12441', true
       )`,
      [transferOrderId, transferOrderRef]
    );
    const linkedDependency = await query(
      `INSERT INTO order_dependencies (
         sales_order_id, sales_order_ref, dispatch_target_ref, dispatch_target_kind,
         transfer_order_id, transfer_order_ref, dependency_mode, same_load_required,
         status, source_location_id, source_location,
         accounting_destination_location_id, accounting_destination_location,
         created_by, updated_by
       ) VALUES (
         $1, $2, $2, 'normal', $3, $4, 'yard_replenishment', false,
         'active', 1, '3445', 15, '12441', $5, $5
       ) RETURNING id`,
      [
        competingSalesOrderId,
        competingSalesOrderRef,
        transferOrderId,
        transferOrderRef,
        operatorId
      ]
    );
    await query(
      `INSERT INTO order_dependency_lines (
         dependency_id, sales_line_id, item_id, item_name, unit,
         allocated_quantity, line_role, dispatch_target_line_key
       ) VALUES (
         $1, $2, $3, 'RESERVATION-OVERRIDE-ITEM', 'EA',
         10, 'sales_allocation', $4
       )`,
      [
        linkedDependency.rows[0].id,
        competingSalesLine.rows[0].id,
        itemId,
        `${competingSalesOrderRef}::${competingSalesOrderRef}::${competingSalesLine.rows[0].id}`
      ]
    );
    await query(
      `INSERT INTO order_dependency_lines (
         dependency_id, sales_line_id, item_id, item_name, unit,
         allocated_quantity, line_role, dispatch_target_line_key
       ) VALUES (
         $1, $2, $3, 'LINKED-TO-MANUAL-ITEM', 'EA',
         7, 'sales_allocation', $4
       )`,
      [
        linkedDependency.rows[0].id,
        competingManualSalesLine.rows[0].id,
        manualItemId,
        `${competingSalesOrderRef}::${competingSalesOrderRef}::${competingManualSalesLine.rows[0].id}`
      ]
    );
    const competingBatch = await query(
      `INSERT INTO scm_transfer_dependency_batches (
         sales_order_id, sales_order_ref, idempotency_key, status,
         inventory_snapshot, inventory_snapshot_at, uncovered_shortage_qty,
         created_by, updated_by
       ) VALUES (
         $1, $2, $3, 'suggested', '{}'::jsonb, now(), 0, $4, $4
       ) RETURNING id`,
      [
        competingSalesOrderId,
        competingSalesOrderRef,
        `reservation-competing-${suffix}`,
        operatorId
      ]
    );
    const competingProposal = await query(
      `INSERT INTO scm_transfer_dependency_proposals (
         batch_id, proposal_key, dependency_mode,
         from_location_id, from_location, to_location_id, to_location,
         memo, creation_status
       ) VALUES (
         $1, '1:15', 'yard_replenishment',
         1, '3445', 15, '12441', 'Competing reservation fixture', 'draft'
       ) RETURNING id`,
      [competingBatch.rows[0].id]
    );
    await query(
      `INSERT INTO scm_transfer_dependency_proposal_lines (
         proposal_id, sales_line_id, item_id, item_name, unit,
         proposed_quantity, line_source, to_plt, to_lyr, to_sec, to_pcs
       ) VALUES (
         $1, null, $2, 'RESERVATION-OVERRIDE-ITEM', 'EA',
         10, 'manual', 1, 0, 0, 1
       )`,
      [competingProposal.rows[0].id, itemId]
    );

    const matrix = await getDependencyInventoryMatrix(salesOrderId);
    const item = matrix.items.find((entry) => Number(entry.itemId) === itemId);
    const sourceBalance = item?.balances?.find((entry) => Number(entry.locationId) === 1);
    assert.equal(Number(sourceBalance?.quantityAvailable), 10);
    assert.equal(Number(sourceBalance?.reservedQuantity), 10);
    assert.equal(Number(sourceBalance?.linkedTransferQuantity), 10);
    assert.equal(Number(sourceBalance?.effectiveAvailable), 0);

    await query(
      `UPDATE scm_transfer_dependency_proposals
          SET creation_status = 'cancelled'
        WHERE id = $1`,
      [competingProposal.rows[0].id]
    );
    const linkedOnlyMatrix = await getDependencyInventoryMatrix(salesOrderId);
    const linkedOnlySource = linkedOnlyMatrix.items
      .find((entry) => Number(entry.itemId) === itemId)
      ?.balances?.find((entry) => Number(entry.locationId) === 1);
    assert.equal(Number(linkedOnlySource?.quantityAvailable), 10);
    assert.equal(Number(linkedOnlySource?.reservedQuantity), 0);
    assert.equal(Number(linkedOnlySource?.linkedTransferQuantity), 10);
    assert.equal(
      Number(linkedOnlySource?.effectiveAvailable),
      10,
      "A created linked TO is already protected inside NetSuite Available and must not be subtracted again."
    );
    await query(
      `UPDATE scm_transfer_dependency_proposals
          SET creation_status = 'draft'
        WHERE id = $1`,
      [competingProposal.rows[0].id]
    );

    const protectedBatch = await generateTransferDependencySuggestion({
      salesOrderId,
      mode: "yard_replenishment",
      operatorId
    });
    assert.equal(protectedBatch.proposals.length, 0);
    assert.equal(Number(protectedBatch.uncoveredShortageQuantity), 6);
    assert.deepEqual(protectedBatch.reservationOverrides, []);

    let overrideBatch = await generateTransferDependencySuggestion({
      salesOrderId,
      mode: "yard_replenishment",
      reservationOverrides: [{ itemId, locationId: 1 }],
      operatorId
    });
    assert.equal(overrideBatch.proposals.length, 1);
    assert.equal(Number(overrideBatch.uncoveredShortageQuantity), 0);
    assert.equal(Number(overrideBatch.proposals[0].fromLocationId), 1);
    assert.equal(Number(overrideBatch.proposals[0].lines[0].proposedQuantity), 6);
    assert.equal(overrideBatch.reservationOverrides.length, 1);
    assert.equal(Number(overrideBatch.reservationOverrides[0].itemId), itemId);
    assert.equal(Number(overrideBatch.reservationOverrides[0].locationId), 1);
    assert.equal(Number(overrideBatch.reservationOverrides[0].reservedQuantity), 10);
    assert.equal(Number(overrideBatch.reservationOverrides[0].quantityAvailable), 10);
    const manualItems = await searchTransferDependencyProposalItems(
      overrideBatch.id,
      overrideBatch.proposals[0].id,
      { search: "Linked TO Manual Item", limit: 12 }
    );
    assert.equal(manualItems.length, 1);
    assert.equal(Number(manualItems[0].quantityAvailable), 20);
    assert.equal(Number(manualItems[0].reservedQuantity), 0);
    assert.equal(Number(manualItems[0].linkedTransferQuantity), 7);
    assert.equal(
      Number(manualItems[0].effectiveAvailable),
      20,
      "Manual item autocomplete must also treat NetSuite Available as usable after a linked TO."
    );

    await query(
      `UPDATE scm_transfer_dependency_proposals
          SET pallet_transfer_qty = 0,
              calculated_pallet_qty = 0,
              pallet_calculation_complete = true,
              pallet_qty_overridden = true
        WHERE batch_id = $1`,
      [overrideBatch.id]
    );
    overrideBatch = await getTransferDependencyBatch(overrideBatch.id);
    const protectedCopy = {
      ...overrideBatch,
      reservationOverrides: []
    };
    await assert.rejects(
      validateTransferDependencyBatchForCreation(protectedCopy),
      /has 0 available.*below the proposed 6/i,
      "Default creation validation must continue protecting stock reserved by another draft."
    );
    const validation = await validateTransferDependencyBatchForCreation(overrideBatch);
    assert.equal(validation.pendingProposals.length, 1);
    assert.equal(Number(validation.uncovered), 0);

    const audit = await query(
      `SELECT details
         FROM dispatch_audit_log
        WHERE action = 'scm.transfer_dependency.suggested'
          AND entity_id = $1
        ORDER BY id DESC
        LIMIT 1`,
      [String(overrideBatch.id)]
    );
    assert.equal(Number(audit.rows[0]?.details?.reservationOverrideCount), 1);
    assert.equal(
      Number(audit.rows[0]?.details?.reservationOverrides?.[0]?.itemId),
      itemId
    );
  });
  console.log("Transfer dependency reservation override database harness passed.");
} finally {
  config.googleMapsApiKey = savedMapsKey;
  await rollback.rollback();
  await closeDb();
}
