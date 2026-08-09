import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { closeDb, query, withTransaction } from "./db.js";
import {
  loadSmartScmPlanningDemandStates
} from "./smart-scm-planning-repository.js";
import {
  addSmartScmProposalLine,
  createSmartScmManualLoad,
  getSmartScmProposalInventorySnapshot,
  groupSmartScmProposals,
  reevaluateSmartScmProposalUrgency,
  updateSmartScmProposalLine
} from "./smart-scm-proposal-editor.js";
import {
  markMissingInboundOrderLines,
  upsertInboundTransferOrderLines
} from "./order-sync-repository.js";

const migrationSource = await fs.readFile(
  new URL("../migrations/138_smart_scm_authoritative_on_order.sql", import.meta.url),
  "utf8"
);

function numeric(value) {
  return Number(value || 0);
}

try {
  await withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext('smart-scm-authoritative-inbound-integration-harness'))");
    await query(migrationSource);

    const identity = await query(
      `SELECT GREATEST(COALESCE((SELECT MAX(item_id) FROM inventory_items), 0), 9700000) + 1 AS item_id,
              GREATEST(COALESCE((SELECT MAX(netsuite_id) FROM purchase_orders WHERE netsuite_id > 0), 0), 9700000) + 100 AS order_id`
    );
    const itemId = Number(identity.rows[0].item_id);
    const regularPoId = Number(identity.rows[0].order_id);
    const blanketPoId = regularPoId + 1;
    const ownToId = regularPoId + 2;
    const unrelatedToId = regularPoId + 3;
    const closedBlanketPoId = regularPoId + 4;
    const itemName = `HARNESS AUTHORITATIVE INBOUND ${itemId}`;

    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, display_name, item_description, stock_unit,
         to_plt, to_lyr, to_sec, to_pcs, item_weight, vendor_id, vendor
       ) VALUES ($1, $2, $2, 'Authoritative inbound fixture', 'EA', 10, 5, 2, 1, 10, $3, 'Harness Vendor')`,
      [itemId, itemName, itemId + 100000]
    );
    await query(
      `INSERT INTO scm_smart_item_policies (
         item_id, item_name, item_description, vendor, vendor_code, stock_unit,
         to_plt, to_lyr, to_sec, to_pcs, lead_time_days, pallet_weight_lbs,
         inactive, discontinued, planning_enabled, updated_by
       ) VALUES ($1, $2, 'Authoritative inbound fixture', 'Harness Vendor', $3,
                 'EA', 10, 5, 2, 1, 7, 100, false, false, true, 'harness:fixture')`,
      [itemId, itemName, String(itemId + 100000)]
    );
    await query(
      `INSERT INTO scm_smart_item_yard_policies (
         item_id, location_id, yard_code, eligible, capacity_pallets,
         service_quantile, minimum_safety_pallets, updated_by
       ) VALUES
         ($1, 1, '3445', true, 25, 0.90, 1, 'harness:fixture'),
         ($1, 15, '12441', true, 25, 0.95, 1, 'harness:fixture')`,
      [itemId]
    );
    await query(
      `INSERT INTO inventory_balances (
         item_id, location_id, location, quantity_on_hand, quantity_available,
         quantity_on_order, quantity_backordered, synced_at
       ) VALUES
         ($1, 1, '3445', 0, 0, 1100, 0, now()),
         ($1, 15, '12441', 1000, 1000, 0, 0, now())`,
      [itemId]
    );

    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, status, status_text, destination_location_id,
         destination_location, is_blanket_po, netsuite_active, synced_at
       ) VALUES
         ($1, $2, 'B', 'Purchase Order : Pending Receipt', 1, '3445', false, true, now()),
         ($3, $4, 'B', 'Purchase Order : Pending Receipt', 1, '3445', true, true, now())`,
      [regularPoId, `PO-HARNESS-${regularPoId}`, blanketPoId, `PO-BLANKET-HARNESS-${blanketPoId}`]
    );
    await query(
      `INSERT INTO purchase_order_lines (
         purchase_order_id, line_id, item_id, item_name, quantity, unit,
         location_id, location, pallet_qty, to_plt, item_weight,
         netsuite_received_qty, netsuite_active, synced_at
       ) VALUES
         ($1, $2, $3, $4, 20, 'EA', 1, '3445', 2, 10, 10, 0, true, now()),
         ($5, $6, $3, $4, 1000, 'EA', 1, '3445', 100, 10, 10, 0, true, now())`,
      [regularPoId, regularPoId + 1000, itemId, itemName, blanketPoId, blanketPoId + 1000]
    );
    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, status, status_text, destination_location_id,
         destination_location, is_blanket_po, netsuite_active, synced_at
       ) VALUES ($1, $2, 'H', 'Purchase Order : Closed', 1, '3445', true, true, now())`,
      [closedBlanketPoId, `PO-CLOSED-BLANKET-HARNESS-${closedBlanketPoId}`]
    );
    await query(
      `INSERT INTO purchase_order_lines (
         purchase_order_id, line_id, item_id, item_name, quantity, unit,
         location_id, location, pallet_qty, to_plt, item_weight,
         netsuite_received_qty, netsuite_closed, netsuite_active, synced_at
       ) VALUES ($1, $2, $3, $4, 500, 'EA', 1, '3445', 50, 10, 10, 0, false, true, now())`,
      [closedBlanketPoId, closedBlanketPoId + 1000, itemId, itemName]
    );
    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, status, status_text, from_location_id, from_location,
         to_location_id, to_location, receiving_status, netsuite_active, synced_at
       ) VALUES
         ($1, $2, 'B', 'Transfer Order : Pending Fulfillment', 15, '12441', 1, '3445', 'not_received', true, now()),
         ($3, $4, 'B', 'Transfer Order : Pending Fulfillment', 15, '12441', 1, '3445', 'not_received', true, now())`,
      [ownToId, `TO-OWN-HARNESS-${ownToId}`, unrelatedToId, `TO-OTHER-HARNESS-${unrelatedToId}`]
    );
    await query(
      `INSERT INTO transfer_order_lines (
         line_stage, transfer_order_id, line_id, item_id, item_name, quantity, unit,
         location_id, location, pallet_qty, to_plt, item_weight,
         netsuite_received_qty, netsuite_active, synced_at
       ) VALUES
         ('receiving', $1, $2, $3, $4, 50, 'EA', 1, '3445', 5, 10, 10, 0, true, now()),
         ('receiving', $5, $6, $3, $4, 30, 'EA', 1, '3445', 3, 10, 10, 0, true, now()),
         ('receiving', $5, $7, $3, $4, 30, 'EA', 1, '3445', 3, 10, 10, 0, true, now())`,
      [ownToId, ownToId + 1000, itemId, itemName, unrelatedToId, unrelatedToId + 1000, unrelatedToId + 2000]
    );

    const authoritative = await getSmartScmProposalInventorySnapshot(itemId, 1, 10, {
      excludeTransferOrderIds: [ownToId]
    });
    assert.equal(authoritative.quantityOnOrderAuthoritative, 1100);
    assert.equal(
      authoritative.quantityBlanketExcluded,
      1000,
      "A closed flagged blanket PO must not be subtracted from NetSuite aggregate on-order."
    );
    assert.equal(authoritative.quantityTransferOrderExcluded, 50);
    assert.equal(authoritative.quantityOnOrder, 50);
    assert.equal(authoritative.expectedAvailablePallets, 5);
    assert.equal(
      authoritative.quantityOnOrder,
      50,
      "The regular 20 + unrelated TO 30 are already inside NetSuite's 1,100; duplicate local TO rows and a closed blanket must not be added or subtracted."
    );

    const newOwnLineId = ownToId + 3000;
    await upsertInboundTransferOrderLines(ownToId, [{
      line_id: newOwnLineId,
      item_id: itemId,
      item_name: itemName,
      item_type: "InvtPart",
      item_type_text: "Inventory Item",
      quantity: 50,
      netsuite_received_qty: 0,
      unit: "EA",
      item_weight: 10,
      location_id: 1,
      location: "3445",
      pallet_qty: 5,
      to_plt: 10,
      to_lyr: 5,
      to_sec: 2,
      to_pcs: 1
    }]);
    await markMissingInboundOrderLines(ownToId, [newOwnLineId]);
    const rekeyed = await query(
      `SELECT COUNT(*) FILTER (WHERE netsuite_active)::int AS active_count,
              ARRAY_AGG(line_id) FILTER (WHERE netsuite_active) AS active_line_ids
         FROM transfer_order_lines
        WHERE transfer_order_id = $1 AND line_stage = 'receiving'`,
      [ownToId]
    );
    assert.equal(rekeyed.rows[0].active_count, 1, "A changed NetSuite line key must not leave two active own-TO rows.");
    assert.deepEqual(rekeyed.rows[0].active_line_ids.map(Number), [newOwnLineId]);

    const forecastRun = await query(
      `INSERT INTO scm_smart_forecast_runs (status, trigger_source, completed_at)
       VALUES ('completed', 'harness', now()) RETURNING id`
    );
    const runResult = await query(
      `INSERT INTO scm_smart_planning_runs (
         status, trigger_source, forecast_run_id, settings_snapshot, totals, completed_at
       ) VALUES ('ready', 'harness', $1, '{}'::jsonb, '{}'::jsonb, now()) RETURNING id`,
      [forecastRun.rows[0].id]
    );
    const runId = Number(runResult.rows[0].id);

    // This represents the moment before the proposal's own TO exists: NetSuite
    // on-order contains only the blanket quantity. Local order rows must not be
    // added on top, and manual creation must persist calculated urgency.
    await query(
      `UPDATE inventory_balances
          SET quantity_on_order = 1000, quantity_backordered = 0, synced_at = now()
        WHERE item_id = $1 AND location_id = 1`,
      [itemId]
    );
    for (let index = 0; index < 2; index += 1) {
      await createSmartScmManualLoad(runId, {
        proposalType: "TO",
        itemId,
        proposedPallets: 1,
        sourceLocationId: 15,
        destinationLocationId: 1
      });
    }
    const manualRows = await query(
      `SELECT proposal.id, proposal.urgent AS proposal_urgent,
              line.id AS line_id, line.urgent AS line_urgent,
              line.urgency_level, line.reason
         FROM scm_smart_proposals proposal
         JOIN scm_smart_proposal_lines line ON line.proposal_id = proposal.id
        WHERE proposal.run_id = $1 AND proposal.proposal_key LIKE 'manual-load:%'
        ORDER BY proposal.id`,
      [runId]
    );
    assert.equal(manualRows.rowCount, 2);
    for (const row of manualRows.rows) {
      assert.equal(row.proposal_urgent, true, "A manual proposal must roll up recalculated line urgency.");
      assert.equal(row.line_urgent, true, "Manual creation must not hardcode urgent=false.");
      assert.notEqual(row.urgency_level, "normal");
      assert.equal(numeric(row.reason.quantityOnOrder), 0);
      assert.equal(numeric(row.reason.quantityOnOrderAuthoritative), 1000);
      assert.equal(
        numeric(row.reason.quantityBlanketExcluded),
        1000,
        "A closed flagged blanket PO must not be subtracted during automatic or manual planning."
      );
    }

    await groupSmartScmProposals(manualRows.rows.map((row) => Number(row.id)));
    const grouped = await query(
      `SELECT proposal.id, proposal.urgent, line.id AS line_id, line.urgent AS line_urgent,
              line.proposed_pallets
         FROM scm_smart_proposals proposal
         JOIN scm_smart_proposal_lines line ON line.proposal_id = proposal.id
        WHERE proposal.run_id = $1 AND proposal.manually_grouped = true
        ORDER BY proposal.id DESC LIMIT 1`,
      [runId]
    );
    assert.equal(grouped.rows[0].urgent, true, "Grouping must recalculate instead of copying stale urgency.");
    assert.equal(grouped.rows[0].line_urgent, true);

    const groupedProposalId = Number(grouped.rows[0].id);
    const groupedLineId = Number(grouped.rows[0].line_id);
    await query(
      "UPDATE scm_smart_proposal_lines SET urgent = false, urgency_level = 'normal', urgency_score = 0 WHERE id = $1",
      [groupedLineId]
    );
    await query(
      "UPDATE scm_smart_proposals SET urgent = false, urgency_level = 'normal', urgency_score = 0 WHERE id = $1",
      [groupedProposalId]
    );
    await addSmartScmProposalLine(groupedProposalId, { itemId, proposedPallets: 1 });
    let adjusted = await query("SELECT * FROM scm_smart_proposal_lines WHERE id = $1", [groupedLineId]);
    assert.equal(adjusted.rows[0].urgent, true, "Adding to an existing manual line must recalculate urgency.");

    await query(
      "UPDATE scm_smart_proposal_lines SET urgent = false, urgency_level = 'normal', urgency_score = 0 WHERE id = $1",
      [groupedLineId]
    );
    await query(
      "UPDATE scm_smart_proposals SET urgent = false, urgency_level = 'normal', urgency_score = 0 WHERE id = $1",
      [groupedProposalId]
    );
    await updateSmartScmProposalLine(
      groupedProposalId,
      groupedLineId,
      { proposedPallets: numeric(adjusted.rows[0].proposed_pallets) }
    );
    adjusted = await query("SELECT urgent, reason FROM scm_smart_proposal_lines WHERE id = $1", [groupedLineId]);
    assert.equal(adjusted.rows[0].urgent, true, "Editing a manual line must recalculate urgency.");

    // This represents the moment after the proposal created its own TO. The
    // aggregate now includes that TO; re-evaluating this proposal subtracts it
    // without changing the executed proposal or NetSuite link.
    await query(
      `UPDATE inventory_balances
          SET quantity_on_order = 1050, quantity_backordered = 0, synced_at = now()
        WHERE item_id = $1 AND location_id = 1`,
      [itemId]
    );
    const completed = await query(
      `INSERT INTO scm_smart_proposals (
         run_id, proposal_key, proposal_type, phase, source_kind, source_location_id,
         source_name, destination_location_id, destination_name, status,
         netsuite_transfer_order_id, netsuite_transfer_order_ref, urgent, urgency_level
       ) VALUES ($1, $2, 'TO', 'internal_transfer', 'yard', 15, '12441', 1, '3445',
                 'completed', $3, $4, false, 'normal') RETURNING id`,
      [runId, `harness-completed:${itemId}`, ownToId, `TO-OWN-HARNESS-${ownToId}`]
    );
    const completedProposalId = Number(completed.rows[0].id);
    await query(
      `INSERT INTO scm_smart_proposal_lines (
         proposal_id, item_id, item_name, item_description, unit,
         required_pallets, proposed_pallets, confirmed_pallets, residual_pallets,
         sales_quantity, pallet_weight_lbs, line_weight_lbs,
         to_plt, to_lyr, to_sec, to_pcs, manual_planning_required, reason,
         destination_location_id, destination_name, added_source, urgent, urgency_level
       ) VALUES ($1, $2, $3, 'Authoritative inbound fixture', 'EA',
                 0, 5, 5, 0, 50, 100, 500,
                 10, 5, 2, 1, false,
                 '{"staleUrgency":true,"expectedAvailablePallets":99,"destinationExpectedAvailablePallets":99}'::jsonb,
                 1, '3445', 'manual', false, 'normal')`,
      [completedProposalId, itemId, itemName]
    );

    await reevaluateSmartScmProposalUrgency(completedProposalId, null);
    const after = await query(
      `SELECT proposal.status, proposal.netsuite_transfer_order_id,
              proposal.netsuite_transfer_order_ref, proposal.urgent,
              line.proposed_pallets, line.sales_quantity, line.urgent AS line_urgent,
              line.urgency_level, line.reason
         FROM scm_smart_proposals proposal
         JOIN scm_smart_proposal_lines line ON line.proposal_id = proposal.id
        WHERE proposal.id = $1`,
      [completedProposalId]
    );
    assert.equal(after.rows[0].status, "completed");
    assert.equal(Number(after.rows[0].netsuite_transfer_order_id), ownToId);
    assert.equal(after.rows[0].netsuite_transfer_order_ref, `TO-OWN-HARNESS-${ownToId}`);
    assert.equal(numeric(after.rows[0].proposed_pallets), 5);
    assert.equal(numeric(after.rows[0].sales_quantity), 50);
    assert.equal(after.rows[0].urgent, true);
    assert.equal(after.rows[0].line_urgent, true);
    assert.notEqual(after.rows[0].urgency_level, "normal");
    assert.equal(numeric(after.rows[0].reason.quantityOnOrderAuthoritative), 1050);
    assert.equal(numeric(after.rows[0].reason.quantityBlanketExcluded), 1000);
    assert.equal(numeric(after.rows[0].reason.quantityTransferOrderExcluded), 50);
    assert.equal(numeric(after.rows[0].reason.quantityOnOrder), 0);
    assert.equal(
      numeric(after.rows[0].reason.expectedAvailablePallets),
      0,
      "Re-evaluation must replace stale legacy expected-availability evidence."
    );
    assert.equal(
      numeric(after.rows[0].reason.destinationExpectedAvailablePallets),
      0,
      "Re-evaluation must replace stale manual destination-availability evidence."
    );

    const planning = await loadSmartScmPlanningDemandStates({ forecastRunId: Number(forecastRun.rows[0].id) });
    const automaticState = planning.states.find((state) => Number(state.policy.item_id) === itemId
      && Number(state.policy.location_id) === 1);
    assert.equal(automaticState.onOrderSales, 50, "Automatic planning must count the real TO after subtracting only the blanket.");
    assert.equal(automaticState.authoritativeOnOrderSales, 1050);
    assert.equal(automaticState.blanketExcludedSales, 1000);
    assert.equal(automaticState.excludedTransferOrderSales, 0);
  }, { rollback: true });
  console.log("Smart SCM authoritative inbound integration harness passed.");
} finally {
  await closeDb();
}
