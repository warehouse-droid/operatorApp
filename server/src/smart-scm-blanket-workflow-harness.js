import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { closeDb, query, withTransaction } from "./db.js";
import { setPurchaseOrderBlanketFlag } from "./dispatch-repository.js";
import {
  confirmSmartScmBlanketProposal,
  finalizeSmartScmBlanketVendorWorkflow,
  listSmartScmBlanketWorkspace,
  removeSmartScmBlanketProposalLine,
  saveSmartScmBlanketVendorReplyDraft,
  searchSmartScmBlanketAlternatives,
  splitSmartScmBlanketProposalLine,
  updateSmartScmBlanketProposalLine
} from "./smart-scm-blanket-repository.js";
import {
  listSmartScmBlanketPlanningPauses,
  smartScmAvailableBlanketBalanceByItem,
  smartScmBuildPlanningDrafts
} from "./smart-scm-planning-repository.js";
import { updateSmartScmProposalLine } from "./smart-scm-proposal-editor.js";
import { listSmartScmPlanningPauses } from "./smart-scm-repository.js";
import { getSmartScmVendorWorkflowForProposal } from "./smart-scm-vendor-workflow-repository.js";
import { smartScmAllocateBlanketCoverage } from "./smart-scm-blanket-coverage.js";
import { listSmartScmBlanketPoolRows } from "./smart-scm-blanket-pool-repository.js";

const migrationUrl = new URL("../migrations/097_smart_scm_blanket_orders.sql", import.meta.url);
const migrationSource = await fs.readFile(migrationUrl, "utf8");
const destinationMigrationUrl = new URL("../migrations/101_smart_scm_vendor_reply_destinations.sql", import.meta.url);
const destinationMigrationSource = await fs.readFile(destinationMigrationUrl, "utf8");

assert.match(migrationSource, /plan_kind[\s\S]*'blanket'/i,
  "Blanket planning runs must be isolated from normal inventory runs.");
assert.match(migrationSource, /proposal_origin[\s\S]*blanket_source_po_id/i,
  "Blanket proposals must retain source-PO identity.");
assert.match(migrationSource, /UNIQUE \(proposal_line_id, source_line_id\)/i,
  "Blanket allocations must retain exact source-line identity.");
assert.match(destinationMigrationSource, /vendor_destination_updated/i,
  "Blanket destination changes must be allowed as durable release events.");

const seed = Date.now() % 100000000;
const baseId = 700000000000 + (seed * 20);
const sourcePoId = baseId + 1;
const sourceLineId = baseId + 2;
const candidatePoId = baseId + 3;
const itemId = baseId + 4;
const palletItemId = baseId + 5;
const sourcePalletLineId = baseId + 6;
const olderPalletLineId = baseId + 7;
const salesOrderId = baseId + 8;
const salesLineId = baseId + 9;
const sourcePoRef = `BLANKET-WORKFLOW-${seed}`;
const candidatePoRef = `BLANKET-CANDIDATE-${seed}`;
const splitPoRef = `BLANKET-RELEASE-${seed}`;
const actor = `blanket-workflow-harness-${seed}`;

async function insertProposalLine(proposalId, destinationLocationId, destinationName) {
  const inserted = await query(
    `INSERT INTO scm_smart_proposal_lines (
       proposal_id, item_id, item_name, item_description, unit,
       required_pallets, proposed_pallets, confirmed_pallets, residual_pallets,
       sales_quantity, pallet_weight_lbs, line_weight_lbs,
       to_plt, to_lyr, to_sec, to_pcs, manual_planning_required, reason,
       destination_location_id, destination_name, urgent, urgency_level,
       urgency_score, provisional
     ) VALUES (
       $1,$2,$3,$4,'EA',2,2,0,2,20,1000,2000,10,0,0,0,false,$5::jsonb,
       $6,$7,true,'urgent',100,false
     ) RETURNING id`,
    [proposalId, itemId, `Blanket Harness Item ${seed}`, "Exact source-line harness item",
      JSON.stringify({ harness: actor }), destinationLocationId, destinationName]
  );
  const proposalLineId = Number(inserted.rows[0].id);
  await query(
    `INSERT INTO scm_smart_blanket_allocations (
       proposal_id, proposal_line_id, source_po_id, source_po_ref,
       source_line_id, item_id, destination_location_id, destination_name,
       planned_pallets, planned_sales_qty
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,2,20)`,
    [proposalId, proposalLineId, sourcePoId, sourcePoRef, sourceLineId, itemId,
      destinationLocationId, destinationName]
  );
  return proposalLineId;
}

try {
  const rolledBack = await withTransaction(async () => {
    // PostgreSQL DDL is transactional. This permits pre-deployment execution while
    // guaranteeing that the harness leaves the database exactly as it found it.
    await query(migrationSource);
    await query(destinationMigrationSource);

    await query(
      `INSERT INTO operators (
         id, username, display_name, password_hash, password_salt, role, roles, active
       ) VALUES ($1,$2,$2,'harness','harness','admin',ARRAY['admin']::text[],true)`,
      [actor, actor]
    );

    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
         destination_location_id, destination_location, source_location,
         dispatch_vendor_yard, receipt_status, initial_scm_status,
         is_blanket_po, netsuite_active, synced_at
       ) VALUES
         ($1,$2,current_date - 30,$3,$4,'pendingReceipt','Purchase Order : Pending Receipt',
          1,'3445',$5,$5,'not_received','Queued',true,true,now()),
         ($6,$7,current_date - 10,$3,$4,'pendingReceipt','Purchase Order : Pending Receipt',
          1,'3445',$5,$5,'not_received','Queued',false,true,now())`,
      [sourcePoId, sourcePoRef, baseId + 100, `Blanket Harness Vendor ${seed}`,
        `Blanket Vendor Yard ${seed}`, candidatePoId, candidatePoRef]
    );
    await query(
      `INSERT INTO dispatch_local_vendors (name, active, updated_by)
       VALUES ($1, true, $2)`,
      [`Blanket Harness Vendor ${seed}`, actor]
    );
    await query(
      `INSERT INTO dispatch_vendor_mappings (
         netsuite_vendor_id, netsuite_vendor_name, local_vendor, active,
         last_po_ref, updated_by
       ) VALUES ($1,$2,$2,true,$3,$4)`,
      [String(baseId + 100), `Blanket Harness Vendor ${seed}`, sourcePoRef, actor]
    );
    await query(
      `INSERT INTO dispatch_vendor_yards (
         vendor, yard, day_label, window_start, window_end, active
       ) VALUES ($1,$2,'Mon-Fri','08:00','17:00',true)`,
      [`Blanket Harness Vendor ${seed}`, `Blanket Vendor Yard ${seed}`]
    );
    await query(
      `INSERT INTO purchase_order_lines (
         id, purchase_order_id, line_id, item_id, item_name, sku, item_description,
         quantity, unit, location_id, location, pallet_qty, layer_qty, section_qty,
         piece_qty, to_plt, to_lyr, to_sec, to_pcs, netsuite_received_qty,
         netsuite_received_baseline_qty, netsuite_active, synced_at, item_weight, raw
       ) VALUES
       (
         $7,$2,5,$6,'PALLET','PALLET','Older official PALLET batch',50,'EACH',1,'3445',
         0,0,0,0,0,0,0,0,0,0,true,now(),40,'{}'::jsonb
       ),
       (
         $1,$2,10,$3,$4,$4,'Exact source-line harness item',100,'EA',1,'3445',
         10,0,0,0,10,0,0,0,0,0,true,now(),100,'{}'::jsonb
       ),
       (
         $5,$2,11,$6,'PALLET','PALLET','Official PALLET for Blanket releases',100,'EACH',1,'3445',
         0,0,0,0,0,0,0,0,0,0,true,now(),40,'{}'::jsonb
       )`,
      [sourceLineId, sourcePoId, itemId, `BLANKET-ITEM-${seed}`, sourcePalletLineId, palletItemId, olderPalletLineId]
    );
    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, display_name, item_description, stock_unit,
         to_plt, to_lyr, to_sec, to_pcs, item_weight, vendor_id, vendor
       ) VALUES ($1,$2,$2,'Exact source-line harness item','EA',10,0,0,0,100,$3,$4)`,
      [itemId, `BLANKET-ITEM-${seed}`, baseId + 100, `Blanket Harness Vendor ${seed}`]
    );
    await query(
      `INSERT INTO scm_smart_item_policies (
         item_id, item_name, item_description, vendor, vendor_code, stock_unit,
         to_plt, to_lyr, to_sec, to_pcs, lead_time_days, pallet_weight_lbs,
         inactive, discontinued, planning_enabled, updated_by
       ) VALUES ($1,$2,'Exact source-line harness item',$3,$4,'EA',10,0,0,0,7,1000,
                 false,false,true,$5)`,
      [itemId, `BLANKET-ITEM-${seed}`, `Blanket Harness Vendor ${seed}`, String(baseId + 100), actor]
    );
    await query(
      `INSERT INTO scm_smart_item_yard_policies (
         item_id, location_id, yard_code, eligible, capacity_pallets,
         service_quantile, minimum_safety_pallets, updated_by
       ) VALUES
         ($1,1,'3445',true,50,0.90,1,$2),
         ($1,15,'12441',true,50,0.90,1,$2),
         ($1,28,'2967',true,50,0.90,1,$2),
         ($1,26,'150',true,50,0.90,1,$2)`,
      [itemId, actor]
    );
    await query(
      `INSERT INTO inventory_balances (
         item_id, location_id, location, quantity_on_hand, quantity_available
       ) VALUES
         ($1,1,'3445',20,20),
         ($1,15,'12441',30,30),
         ($1,28,'2967',40,40),
         ($1,26,'150',10,10)`,
      [itemId]
    );

    const blanketBalances = await smartScmAvailableBlanketBalanceByItem();
    assert.equal(blanketBalances.get(String(itemId))?.availablePallets, 10,
      "Available Blanket balance must net receipts and active allocations at item level.");
    assert.deepEqual(blanketBalances.get(String(itemId))?.sourcePoRefs, [sourcePoRef]);
    const automaticPauses = await listSmartScmBlanketPlanningPauses({ search: `BLANKET-ITEM-${seed}` });
    assert.equal(automaticPauses.length, 1, "Usable Blanket balance must appear in automatic PO planning pauses.");
    assert.equal(automaticPauses[0].itemId, itemId);
    assert.equal(automaticPauses[0].availablePallets, 10);
    assert.deepEqual(automaticPauses[0].sourcePoRefs, [sourcePoRef]);
    assert.equal(automaticPauses[0].planningEffect, "quantity_offset");
    assert.equal(automaticPauses[0].ordinaryPlanningActive, true);
    const combinedPauses = await listSmartScmPlanningPauses({ search: `BLANKET-ITEM-${seed}`, limit: 20 });
    assert.equal(combinedPauses.blanketCount, 1);
    assert.equal(combinedPauses.combinedActiveCount, 1,
      "Paused Items must count the derived Blanket pause without creating a manual exclusion.");
    const stateBase = {
      requiredPallets: 0,
      toPlt: 10,
      safety: 0,
      rop: 0,
      preferred: 0,
      standardSafety: 0,
      standardRop: 0,
      standardPreferred: 0,
      availablePallets: 0,
      urgent: false,
      urgencyLevel: "normal",
      urgencyScore: 0,
      manualPlanningRequired: false,
      policy: {
        item_id: itemId,
        item_name: `BLANKET-ITEM-${seed}`,
        item_description: "Blanket planning pause fixture",
        stock_unit: "EA",
        to_plt: 10,
        to_lyr: 0,
        to_sec: 0,
        to_pcs: 0,
        pallet_weight_lbs: 1000,
        physical_pallet_weight_lbs: 0,
        vendor: `Blanket Harness Vendor ${seed}`,
        plant: `Blanket Vendor Yard ${seed}`
      }
    };
    const sharedPoolRows = await listSmartScmBlanketPoolRows({
      isBlanket: true,
      sourcePoId,
      limit: 20
    });
    const allocatedCoverage = smartScmAllocateBlanketCoverage({
      states: [
        {
          ...stateBase,
          key: `${itemId}:1`,
          requiredPallets: 12,
          policy: {
            ...stateBase.policy,
            location_id: 1,
            yard_code: "3445"
          }
        },
        {
          ...stateBase,
          key: `${itemId}:28`,
          availablePallets: 6,
          policy: { ...stateBase.policy, location_id: 28, yard_code: "2967" }
        }
      ],
      poolRows: sharedPoolRows
    });
    const coveredDestination = allocatedCoverage.states.find((state) => state.policy.location_id === 1);
    assert.equal(coveredDestination.blanketCoveragePallets, 10,
      "The shared database pool must credit all ten compatible Blanket pallets.");
    assert.equal(coveredDestination.residualRequiredPallets, 2,
      "Demand beyond the shared Blanket pool must remain in ordinary planning.");
    assert.deepEqual(coveredDestination.blanketSourcePoRefs, [sourcePoRef]);
    const planningDrafts = smartScmBuildPlanningDrafts({
      states: allocatedCoverage.states,
      supplyMap: new Map([[String(itemId), { status: "out_of_stock", available_pallets: 0 }]]),
      settings: { truck_capacity_lbs: 78000, hold_load_ratio: 0.5, vendor_response_sla_hours: 24 }
    });
    assert.equal(planningDrafts.drafts.some((draft) => draft.proposalType === "PO"), false,
      "An out-of-stock vendor must not create a PO for the uncovered residual.");
    assert.equal(planningDrafts.drafts.some((draft) => draft.proposalType === "TO"), true,
      "The uncovered two-pallet residual must follow the existing safe TO route.");
    assert.equal(planningDrafts.drafts.flatMap((draft) => draft.lines)
      .reduce((sum, line) => sum + Number(line.proposedPallets), 0), 2);

    await query(
      `UPDATE purchase_order_lines
          SET netsuite_received_baseline_qty = 10
        WHERE id = $1`,
      [sourceLineId]
    );
    const afterReceipt = await smartScmAvailableBlanketBalanceByItem();
    assert.equal(afterReceipt.get(String(itemId))?.availablePallets, 9,
      "Received sales quantity must be removed before Blanket coverage is calculated.");
    await query(
      `UPDATE purchase_order_lines
          SET netsuite_received_baseline_qty = 0
        WHERE id = $1`,
      [sourceLineId]
    );

    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, trandate, status, status_text, netsuite_active, synced_at
       ) VALUES ($1,$2,current_date,'pendingFulfillment','Sales Order : Pending Fulfillment',true,now())`,
      [salesOrderId, `BLANKET-SALES-${seed}`]
    );
    await query(
      `INSERT INTO sales_order_lines (
         id, sales_order_id, line_id, item_id, item_name, sku, quantity, unit,
         pallet_qty, to_plt, netsuite_active, synced_at
       ) VALUES ($1,$2,1,$3,$4,$4,10,'EA',1,10,true,now())`,
      [salesLineId, salesOrderId, itemId, `BLANKET-ITEM-${seed}`]
    );
    const salesAllocation = await query(
      `INSERT INTO dispatch_so_po_allocations (
         sales_order_id, sales_order_ref, sales_line_id,
         po_order_id, po_order_ref, po_line_id,
         item_id, item_name, sku, allocated_pallet_qty, allocated_sales_qty,
         status, created_by, dispatch_target_ref, dispatch_target_kind,
         dispatch_target_line_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,1,10,'active',$9,$2,'normal',$10)
       RETURNING id`,
      [salesOrderId, `BLANKET-SALES-${seed}`, salesLineId, sourcePoId, sourcePoRef,
        sourceLineId, itemId, `BLANKET-ITEM-${seed}`, actor,
        `BLANKET-SALES-${seed}::${salesLineId}`]
    );
    const afterSalesAllocation = await smartScmAvailableBlanketBalanceByItem();
    assert.equal(afterSalesAllocation.get(String(itemId))?.availablePallets, 9,
      "Active Sales allocation must be removed before Blanket coverage is calculated.");
    await query(
      `UPDATE dispatch_so_po_allocations SET status = 'cancelled' WHERE id = $1`,
      [salesAllocation.rows[0].id]
    );

    const run = await query(
      `INSERT INTO scm_smart_planning_runs (
         status, trigger_source, revision, settings_snapshot, totals,
         created_by, completed_at, plan_kind
       ) VALUES ('ready','blanket_manual',1,'{"truck_capacity_lbs":78000}'::jsonb,
         '{}'::jsonb,$1,now(),'blanket')
       RETURNING id`,
      [actor]
    );
    const proposal = await query(
      `INSERT INTO scm_smart_proposals (
         run_id, proposal_key, proposal_type, phase, source_kind, source_name,
         destination_location_id, destination_name, vendor, status, urgent,
         urgency_level, urgency_score, total_pallets, total_weight_lbs,
         utilization, memo, route_stops, proposal_origin,
         blanket_source_po_id, blanket_source_po_ref
       ) VALUES (
         $1,$2,'PO','direct_vendor','vendor',$3,1,'3445',$4,'held',true,
         'urgent',100,4,4000,0.0513,$5,
         '[{"locationId":1,"name":"3445","sequence":1},{"locationId":15,"name":"12441","sequence":2}]'::jsonb,
         'blanket',$6,$7
       ) RETURNING id`,
      [run.rows[0].id, `blanket:${sourcePoId}:load:1`, `Blanket Vendor Yard ${seed}`,
        `Blanket Harness Vendor ${seed}`, actor, sourcePoId, sourcePoRef]
    );
    const proposalId = Number(proposal.rows[0].id);
    const firstLineId = await insertProposalLine(proposalId, 1, "3445");
    const secondLineId = await insertProposalLine(proposalId, 15, "12441");

    await query("UPDATE scm_smart_settings SET truck_capacity_lbs = 3000 WHERE id = 1");
    await query(
      `UPDATE scm_smart_planning_runs
          SET settings_snapshot = jsonb_set(settings_snapshot, '{truck_capacity_lbs}', '3000'::jsonb, true)
        WHERE id = $1`,
      [run.rows[0].id]
    );

    const edited = await updateSmartScmBlanketProposalLine(proposalId, firstLineId, {
      proposedPallets: 3,
      destinationLocationId: 28
    }, actor);
    const editedLine = edited.lines.find((line) => line.id === firstLineId);
    assert.equal(editedLine.proposedPallets, 3);
    assert.equal(editedLine.destinationLocationId, 28);
    assert.equal(editedLine.salesQuantity, 30);
    assert(edited.utilization > 1,
      "An explicit Blanket quantity edit must retain an over-capacity load and expose utilization above 100%.");
    const editedAllocation = await query(
      `SELECT source_line_id, destination_location_id,
              SUM(planned_pallets)::numeric AS pallets,
              SUM(planned_sales_qty)::numeric AS sales_qty
         FROM scm_smart_blanket_allocations
        WHERE proposal_id = $1 AND proposal_line_id = $2
        GROUP BY source_line_id, destination_location_id`,
      [proposalId, firstLineId]
    );
    assert.equal(editedAllocation.rowCount, 1);
    assert.equal(Number(editedAllocation.rows[0].source_line_id), sourceLineId);
    assert.equal(Number(editedAllocation.rows[0].destination_location_id), 28);
    assert.equal(Number(editedAllocation.rows[0].pallets), 3);
    assert.equal(Number(editedAllocation.rows[0].sales_qty), 30);
    await query("UPDATE scm_smart_settings SET truck_capacity_lbs = 78000 WHERE id = 1");
    await query(
      `UPDATE scm_smart_planning_runs
          SET settings_snapshot = jsonb_set(settings_snapshot, '{truck_capacity_lbs}', '78000'::jsonb, true)
        WHERE id = $1`,
      [run.rows[0].id]
    );
    await assert.rejects(
      () => updateSmartScmProposalLine(proposalId, firstLineId, {
        proposedPallets: 4,
        destinationLocationId: 28
      }, actor),
      /must be edited from the Blanket order tab/i,
      "The generic proposal editor must never bypass exact Blanket allocations."
    );
    await assert.rejects(
      () => updateSmartScmBlanketProposalLine(proposalId, firstLineId, {
        proposedPallets: 20,
        destinationLocationId: 28
      }, actor),
      /Only 10 whole PLT remain open/i,
      "A Blanket edit may rebalance sibling proposals but must never exceed the source PO's physical open quantity."
    );
    const afterRejectedEdit = await query(
      `SELECT line.proposed_pallets, line.destination_location_id,
              SUM(allocation.planned_pallets)::numeric AS allocated_pallets
         FROM scm_smart_proposal_lines line
         JOIN scm_smart_blanket_allocations allocation ON allocation.proposal_line_id = line.id
        WHERE line.id = $1
        GROUP BY line.id`,
      [firstLineId]
    );
    assert.equal(Number(afterRejectedEdit.rows[0].proposed_pallets), 3);
    assert.equal(Number(afterRejectedEdit.rows[0].destination_location_id), 28);
    assert.equal(Number(afterRejectedEdit.rows[0].allocated_pallets), 3,
      "A rejected edit must roll back both the proposal line and its source ledger.");
    await updateSmartScmBlanketProposalLine(proposalId, firstLineId, {
      proposedPallets: 2,
      destinationLocationId: 1
    }, actor);
    const restoredAllocation = await query(
      `SELECT destination_location_id, SUM(planned_pallets)::numeric AS pallets
         FROM scm_smart_blanket_allocations
        WHERE proposal_id = $1 AND proposal_line_id = $2
        GROUP BY destination_location_id`,
      [proposalId, firstLineId]
    );
    assert.equal(Number(restoredAllocation.rows[0].destination_location_id), 1);
    assert.equal(Number(restoredAllocation.rows[0].pallets), 2);

    const editorProposal = await query(
      `INSERT INTO scm_smart_proposals (
         run_id, proposal_key, proposal_type, phase, source_kind, source_name,
         destination_location_id, destination_name, vendor, status, urgent,
         urgency_level, urgency_score, total_pallets, total_weight_lbs,
         utilization, memo, route_stops, proposal_origin,
         blanket_source_po_id, blanket_source_po_ref
       ) VALUES (
         $1,$2,'PO','direct_vendor','vendor',$3,1,'3445',$4,'held',true,
         'urgent',100,4,4000,0.0513,$5,
         '[{"locationId":1,"name":"3445","sequence":1},{"locationId":15,"name":"12441","sequence":2}]'::jsonb,
         'blanket',$6,$7
       ) RETURNING id`,
      [run.rows[0].id, `blanket-editor:${sourcePoId}:load:1`, `Blanket Vendor Yard ${seed}`,
        `Blanket Harness Vendor ${seed}`, actor, sourcePoId, sourcePoRef]
    );
    const editorProposalId = Number(editorProposal.rows[0].id);
    const editorFirstLineId = await insertProposalLine(editorProposalId, 1, "3445");
    const editorSecondLineId = await insertProposalLine(editorProposalId, 15, "12441");
    await query(
      `UPDATE scm_smart_proposals
          SET pallet_quantity_overrides = '{"1":9,"15":8}'::jsonb
        WHERE id = $1`,
      [editorProposalId]
    );
    const splitRun = await splitSmartScmBlanketProposalLine(editorProposalId, editorFirstLineId, {}, actor);
    const splitChild = splitRun.proposals.find((candidate) => candidate.proposalOrigin === "blanket"
      && candidate.lines.some((line) => Number(line.reason?.splitFromProposalId) === editorProposalId
        && Number(line.reason?.splitFromLineId) === editorFirstLineId));
    assert.ok(splitChild, "Split to load must create a separate held Blanket proposal.");
    const movedAllocation = await query(
      `SELECT proposal_id, proposal_line_id, source_line_id, planned_pallets, planned_sales_qty, status
         FROM scm_smart_blanket_allocations
        WHERE proposal_id = $1`,
      [splitChild.id]
    );
    assert.equal(movedAllocation.rowCount, 1);
    assert.equal(Number(movedAllocation.rows[0].source_line_id), sourceLineId);
    assert.equal(Number(movedAllocation.rows[0].planned_pallets), 2);
    assert.equal(Number(movedAllocation.rows[0].planned_sales_qty), 20);
    assert.equal(movedAllocation.rows[0].status, "planned");
    assert.notEqual(Number(movedAllocation.rows[0].proposal_line_id), editorFirstLineId,
      "Split to load must relink the exact allocation to the new proposal line.");
    assert.equal(splitChild.physicalPalletLines[0]?.quantity, 2,
      "The split load must recalculate its PALLET quantity from the moved material line.");
    assert.equal(splitChild.physicalPalletLines[0]?.overridden, false,
      "A load-level PALLET override must not be copied to a split item line.");
    const remainingEditorProposal = splitRun.proposals.find((candidate) => candidate.id === editorProposalId);
    assert.equal(remainingEditorProposal.physicalPalletLines[0]?.quantity, 8,
      "An unrelated destination PALLET override must remain on the source load.");

    const removedChild = await removeSmartScmBlanketProposalLine(
      splitChild.id,
      splitChild.lines[0].id,
      actor
    );
    assert.equal(removedChild.deleted, true, "Removing the only line must remove its empty load.");
    const removedSource = await removeSmartScmBlanketProposalLine(editorProposalId, editorSecondLineId, actor);
    assert.equal(removedSource.deleted, true);
    const editorLedgerAfterRemoval = await query(
      "SELECT COUNT(*)::int AS count FROM scm_smart_blanket_allocations WHERE proposal_id = ANY($1::bigint[])",
      [[editorProposalId, splitChild.id]]
    );
    assert.equal(editorLedgerAfterRemoval.rows[0].count, 0,
      "Removing planned Blanket lines must release, not strand, their source allocations.");

    const candidateWorkspace = await listSmartScmBlanketWorkspace({ search: candidatePoRef, limit: 20 });
    assert(candidateWorkspace.candidates.some((order) => order.orderRef === candidatePoRef),
      "Open source POs must remain flaggable even when they have no plannable pallet line.");
    assert(candidateWorkspace.blanketOrders.some((order) => order.orderRef === sourcePoRef));

    const firstConfirmation = await confirmSmartScmBlanketProposal(proposalId, actor, {
      idempotencyKey: `${actor}:reserve`
    });
    const releaseId = firstConfirmation.release.id;
    assert.equal(firstConfirmation.release.status, "reserved");
    assert.equal(firstConfirmation.release.allocations.length, 2);
    assert.equal(firstConfirmation.release.allocations.reduce((sum, row) => sum + row.reservedPallets, 0), 4);
    const blanketVendorWorkflow = await getSmartScmVendorWorkflowForProposal(proposalId);
    assert.equal(blanketVendorWorkflow.workflowKind, "blanket_po");
    assert.equal(blanketVendorWorkflow.canCreatePurchaseOrder, false,
      "A persisted Blanket workflow must never become eligible for NetSuite PO creation.");
    assert.equal(blanketVendorWorkflow.canCreateBlanketSplit, true);
    assert.equal(blanketVendorWorkflow.sourcePurchaseOrderId, sourcePoId);
    assert.equal(blanketVendorWorkflow.sourcePurchaseOrderRef, sourcePoRef);
    assert.match(blanketVendorWorkflow.vendorEmailDraft.subject, /Purchase order request/i,
      "A Blanket workflow must remain email-draftable while it waits for the vendor reply.");
    assert.match(blanketVendorWorkflow.vendorEmailDraft.subject, new RegExp(sourcePoRef),
      "A new Blanket email subject must identify its source PO.");

    await confirmSmartScmBlanketProposal(proposalId, actor, { idempotencyKey: `${actor}:reserve` });
    const reservationCount = await query(
      "SELECT COUNT(*)::int AS count FROM scm_smart_blanket_releases WHERE proposal_id = $1",
      [proposalId]
    );
    const reservationEvents = await query(
      "SELECT COUNT(*)::int AS count FROM scm_smart_blanket_release_events WHERE release_id = $1 AND event_type = 'reserved'",
      [releaseId]
    );
    assert.equal(reservationCount.rows[0].count, 1, "Reservation retries must reuse the durable release.");
    assert.equal(reservationEvents.rows[0].count, 1, "Reservation retries must not duplicate side effects.");

    const reservedWorkspace = await listSmartScmBlanketWorkspace({ limit: 20 });
    const reservedSource = reservedWorkspace.blanketOrders.find((order) => order.orderRef === sourcePoRef);
    assert.equal(reservedSource.remainingPallets, 6, "Pending reservations must reduce the blanket pool immediately.");
    const alternatives = await searchSmartScmBlanketAlternatives(proposalId, { search: `BLANKET-ITEM-${seed}` });
    assert.equal(alternatives.length, 1, "Alternative search must resolve a proposal id and stay on the same source PO.");
    assert.equal(alternatives[0].sourcePoId, sourcePoId);
    assert.equal(alternatives[0].remainingPallets, 6);

    const quantitiesBeforeDraft = await query(
      `SELECT line.id, line.confirmed_pallets, line.residual_pallets,
              allocation.reserved_pallets, allocation.held_pallets,
              allocation.released_pallets, allocation.cancelled_pallets
         FROM scm_smart_proposal_lines line
         JOIN scm_smart_blanket_allocations allocation ON allocation.proposal_line_id = line.id
        WHERE line.proposal_id = $1
        ORDER BY line.id`,
      [proposalId]
    );
    const savedDraft = await saveSmartScmBlanketVendorReplyDraft(proposalId, {
      readyDate: "2026-08-15",
      vendorReference: `DRAFT-${seed}`,
      remarks: "Harness vendor draft",
      lines: [
        { proposalLineId: firstLineId, destinationLocationId: 28, decision: "hold", decisionPallets: 2 },
        { proposalLineId: secondLineId, destinationLocationId: 15, decision: "confirm", decisionPallets: 2 }
      ]
    }, actor);
    assert.equal(savedDraft.vendorReference, `DRAFT-${seed}`);
    assert.equal(savedDraft.lines.find((line) => line.id === firstLineId)?.reason?.vendorReplyDraft?.decision, "hold");
    assert.equal(savedDraft.lines.find((line) => line.id === firstLineId)?.destinationLocationId, 28,
      "A reserved Blanket line must remain destination-editable in Vendor Replies.");
    const movedReservation = await query(
      `SELECT destination_location_id, reserved_pallets, reserved_sales_qty,
              planned_pallets, planned_sales_qty
         FROM scm_smart_blanket_allocations
        WHERE proposal_id = $1 AND proposal_line_id = $2`,
      [proposalId, firstLineId]
    );
    assert.equal(movedReservation.rowCount, 1);
    assert.equal(Number(movedReservation.rows[0].destination_location_id), 28);
    assert.deepEqual({
      reservedPallets: Number(movedReservation.rows[0].reserved_pallets),
      reservedSalesQty: Number(movedReservation.rows[0].reserved_sales_qty),
      plannedPallets: Number(movedReservation.rows[0].planned_pallets),
      plannedSalesQty: Number(movedReservation.rows[0].planned_sales_qty)
    }, { reservedPallets: 2, reservedSalesQty: 20, plannedPallets: 2, plannedSalesQty: 20 },
    "Changing a Blanket destination must preserve exact source quantity lineage.");
    const quantitiesAfterDraft = await query(
      `SELECT line.id, line.confirmed_pallets, line.residual_pallets,
              allocation.reserved_pallets, allocation.held_pallets,
              allocation.released_pallets, allocation.cancelled_pallets
         FROM scm_smart_proposal_lines line
         JOIN scm_smart_blanket_allocations allocation ON allocation.proposal_line_id = line.id
        WHERE line.proposal_id = $1
        ORDER BY line.id`,
      [proposalId]
    );
    assert.deepEqual(quantitiesAfterDraft.rows, quantitiesBeforeDraft.rows,
      "Saving a Blanket vendor draft must not mutate proposal or allocation quantities.");
    await query("UPDATE inventory_items SET to_plt = 20 WHERE item_id = $1", [itemId]);
    await assert.rejects(
      () => saveSmartScmBlanketVendorReplyDraft(proposalId, {
        lines: [
          { proposalLineId: firstLineId, destinationLocationId: 1, decision: "hold", decisionPallets: 2 },
          { proposalLineId: secondLineId, destinationLocationId: 15, decision: "confirm", decisionPallets: 2 }
        ]
      }, actor),
      (error) => error?.code === "SCM_BLANKET_DESTINATION_CONVERSION_CHANGED",
      "A destination change must not alter the sales quantity already reserved from the source Blanket PO."
    );
    await query("UPDATE inventory_items SET to_plt = 10 WHERE item_id = $1", [itemId]);
    const afterConversionRejection = await query(
      "SELECT destination_location_id, reserved_sales_qty FROM scm_smart_blanket_allocations WHERE proposal_id = $1 AND proposal_line_id = $2",
      [proposalId, firstLineId]
    );
    assert.equal(Number(afterConversionRejection.rows[0].destination_location_id), 28);
    assert.equal(Number(afterConversionRejection.rows[0].reserved_sales_qty), 20,
      "A rejected Blanket destination must roll back without touching its reservation.");
    await saveSmartScmBlanketVendorReplyDraft(proposalId, {
      readyDate: "2026-08-15",
      vendorReference: `DRAFT-${seed}`,
      remarks: "Harness vendor draft",
      lines: [
        { proposalLineId: firstLineId, destinationLocationId: 1, decision: "hold", decisionPallets: 2 },
        { proposalLineId: secondLineId, destinationLocationId: 15, decision: "confirm", decisionPallets: 2 }
      ]
    }, actor);
    const restoredReservation = await query(
      "SELECT destination_location_id, reserved_pallets, reserved_sales_qty FROM scm_smart_blanket_allocations WHERE proposal_id = $1 AND proposal_line_id = $2",
      [proposalId, firstLineId]
    );
    assert.deepEqual({
      destinationLocationId: Number(restoredReservation.rows[0].destination_location_id),
      reservedPallets: Number(restoredReservation.rows[0].reserved_pallets),
      reservedSalesQty: Number(restoredReservation.rows[0].reserved_sales_qty)
    }, { destinationLocationId: 1, reservedPallets: 2, reservedSalesQty: 20 });
    const destinationEvents = await query(
      "SELECT COUNT(*)::int AS count FROM scm_smart_blanket_release_events WHERE release_id = $1 AND event_type = 'vendor_destination_updated'",
      [releaseId]
    );
    assert.equal(destinationEvents.rows[0].count, 2,
      "Every committed Blanket destination change must leave a durable release event.");
    await assert.rejects(
      saveSmartScmBlanketVendorReplyDraft(proposalId, {
        lines: [{ proposalLineId: firstLineId, decision: "confirm", decisionPallets: 3 }]
      }, actor),
      /cannot exceed its reserved line quantity/i
    );

    await assert.rejects(
      () => setPurchaseOrderBlanketFlag(sourcePoRef, { isBlanket: false, updatedBy: actor }),
      (error) => error?.code === "SCM_BLANKET_UNFLAG_UNSAFE",
      "A source with a pending reservation must not be unflagged."
    );

    const finalizePayload = {
      splitPoRef,
      readyDate: "2026-08-15",
      vendorReference: splitPoRef,
      lines: [
        { proposalLineId: firstLineId, confirmedPallets: 1, heldPallets: 1, cancelledPallets: 0, unitPrice: 7.25 },
        { proposalLineId: secondLineId, confirmedPallets: 1, heldPallets: 1, cancelledPallets: 0, unitPrice: 8.5 }
      ]
    };
    await assert.rejects(
      () => finalizeSmartScmBlanketVendorWorkflow(proposalId, {
        ...finalizePayload,
        splitPoRef: sourcePoRef,
        vendorReference: sourcePoRef
      }, actor),
      /must be different from the blanket PO/i,
      "Vendor confirmation must create a new local PO reference, never reuse the source Blanket PO reference."
    );
    const rejectedSplitCount = await query(
      "SELECT COUNT(*)::int AS count FROM dispatch_scm_po_splits WHERE source_po_id = $1",
      [sourcePoId]
    );
    assert.equal(rejectedSplitCount.rows[0].count, 0,
      "A rejected same-reference split must roll back without creating a partial local PO.");
    const rejectedPrices = await query(
      "SELECT last_purchase_price FROM scm_smart_proposal_lines WHERE proposal_id = $1 ORDER BY id",
      [proposalId]
    );
    assert(rejectedPrices.rows.every((line) => line.last_purchase_price === null),
      "A failed Blanket split must roll back unit-price edits with the split transaction.");
    const finalized = await finalizeSmartScmBlanketVendorWorkflow(proposalId, finalizePayload, actor);
    assert.equal(finalized.release.status, "partially_released");
    assert.equal(finalized.release.splitPoRef, splitPoRef);
    const finalizedMaterialLines = finalized.split.lines.filter((line) => String(line.itemName).toUpperCase() !== "PALLET");
    const finalizedPalletLines = finalized.split.lines.filter((line) => String(line.itemName).toUpperCase() === "PALLET");
    assert.equal(finalizedMaterialLines.length, 2, "One local split must support multiple destination yards.");
    assert.deepEqual(finalizedMaterialLines.map((line) => line.destinationLocationId).sort((a, b) => a - b), [1, 15]);
    assert.deepEqual(
      finalizedPalletLines
        .map((line) => [line.destinationLocationId, line.quantity])
        .sort((left, right) => left[0] - right[0]),
      [[1, 1], [15, 1]],
      "Every confirmed Blanket destination must receive its derived official PALLET line."
    );
    assert(finalizedPalletLines.every((line) => line.sourceLineId === sourcePalletLineId),
      "PALLET lineage must use the nearest following PALLET row from the selected material line batch.");
    assert(finalized.conservation.every((entry) => entry.conserved));
    assert(finalized.proposal.lines.every((line) => line.reason?.vendorReplyDraft?.decision === "hold"));
    assert(finalized.proposal.lines.every((line) => Number(line.reason?.vendorReplyDraft?.decisionPallets) === 1),
      "Partial finalization must replace stale drafts with the exact held balance.");
    assert.deepEqual(finalized.proposal.lines.map((line) => line.lastPurchasePrice), [7.25, 8.5],
      "Creating a Blanket split directly must persist the currently edited line prices.");

    const localSplitIdentity = await query(
      `SELECT source_po_id, source_po_ref, split_po_id, split_po_ref
         FROM dispatch_scm_po_splits
        WHERE source_po_id = $1 AND split_po_ref = $2`,
      [sourcePoId, splitPoRef]
    );
    assert.equal(localSplitIdentity.rowCount, 1);
    assert.equal(Number(localSplitIdentity.rows[0].source_po_id), sourcePoId);
    assert.equal(localSplitIdentity.rows[0].source_po_ref, sourcePoRef);
    assert.equal(localSplitIdentity.rows[0].split_po_ref, splitPoRef);
    assert.notEqual(localSplitIdentity.rows[0].split_po_ref, localSplitIdentity.rows[0].source_po_ref,
      "The released load must retain source lineage while receiving its own distinct PO reference.");
    const netSuiteHistoryCount = await query(
      `SELECT COUNT(*)::int AS count
         FROM scm_netsuite_po_history
        WHERE proposal_id = $1 OR netsuite_purchase_order_id = $2`,
      [proposalId, Number(localSplitIdentity.rows[0].split_po_id)]
    );
    assert.equal(netSuiteHistoryCount.rows[0].count, 0,
      "A local Blanket split must not be registered as an application-created NetSuite PO.");

    const ledgerAfterFinalize = await query(
      `SELECT SUM(released_pallets)::numeric AS released,
              SUM(held_pallets)::numeric AS held,
              SUM(cancelled_pallets)::numeric AS cancelled
         FROM scm_smart_blanket_allocations
        WHERE release_id = $1`,
      [releaseId]
    );
    assert.deepEqual({
      released: Number(ledgerAfterFinalize.rows[0].released),
      held: Number(ledgerAfterFinalize.rows[0].held),
      cancelled: Number(ledgerAfterFinalize.rows[0].cancelled)
    }, { released: 2, held: 2, cancelled: 0 });

    const retry = await finalizeSmartScmBlanketVendorWorkflow(proposalId, finalizePayload, actor);
    assert.equal(retry.idempotent, true, "An exact vendor-finalization retry must return the stored outcome.");
    const splitCount = await query(
      "SELECT COUNT(*)::int AS count FROM dispatch_scm_po_splits WHERE source_po_id = $1 AND split_po_ref = $2",
      [sourcePoId, splitPoRef]
    );
    const finalizeEvents = await query(
      "SELECT COUNT(*)::int AS count FROM scm_smart_blanket_release_events WHERE release_id = $1 AND event_type = 'vendor_finalized'",
      [releaseId]
    );
    assert.equal(splitCount.rows[0].count, 1);
    assert.equal(finalizeEvents.rows[0].count, 1);

    const heldResolutionPayload = {
      splitPoRef,
      readyDate: "2026-08-16",
      vendorReference: splitPoRef,
      lines: [
        { proposalLineId: firstLineId, confirmedPallets: 1, heldPallets: 0, cancelledPallets: 0 },
        { proposalLineId: secondLineId, confirmedPallets: 0, heldPallets: 0, cancelledPallets: 1 }
      ]
    };
    const splitIdentity = await query(
      "SELECT split_po_id FROM dispatch_scm_po_splits WHERE source_po_id = $1 AND split_po_ref = $2",
      [sourcePoId, splitPoRef]
    );
    await query(
      "UPDATE purchase_order_lines SET netsuite_received_qty = 1 WHERE purchase_order_id = $1",
      [splitIdentity.rows[0].split_po_id]
    );
    await assert.rejects(
      () => finalizeSmartScmBlanketVendorWorkflow(proposalId, heldResolutionPayload, actor),
      (error) => error?.code === "SCM_BLANKET_SPLIT_OPERATIONAL",
      "Held quantities must not extend a split after receiving or dispatch activity begins."
    );
    await query(
      "UPDATE purchase_order_lines SET netsuite_received_qty = 0 WHERE purchase_order_id = $1",
      [splitIdentity.rows[0].split_po_id]
    );
    const heldResolution = await finalizeSmartScmBlanketVendorWorkflow(proposalId, heldResolutionPayload, actor);
    assert.equal(heldResolution.release.status, "released",
      "A later vendor reply must resolve held quantity without creating a second split PO.");
    assert.equal(heldResolution.release.splitPoRef, splitPoRef);
    assert.equal(heldResolution.split.split.id, finalized.split.split.id);
    assert(heldResolution.proposal.lines.every((line) => line.reason?.vendorReplyDraft === undefined),
      "Terminal lines must clear stale vendor reply drafts.");
    const finalLedger = await query(
      `SELECT SUM(released_pallets)::numeric AS released,
              SUM(held_pallets)::numeric AS held,
              SUM(cancelled_pallets)::numeric AS cancelled
         FROM scm_smart_blanket_allocations
        WHERE release_id = $1`,
      [releaseId]
    );
    assert.deepEqual({
      released: Number(finalLedger.rows[0].released),
      held: Number(finalLedger.rows[0].held),
      cancelled: Number(finalLedger.rows[0].cancelled)
    }, { released: 3, held: 0, cancelled: 1 }, "Released, held, and cancelled quantities must be conserved cumulatively.");
    const heldResolutionRetry = await finalizeSmartScmBlanketVendorWorkflow(proposalId, heldResolutionPayload, actor);
    assert.equal(heldResolutionRetry.idempotent, true);
    const oneExtendedSplit = await query(
      `SELECT split.id, COUNT(line.id)::int AS line_count, SUM(line.pallet_qty)::numeric AS pallets
         FROM dispatch_scm_po_splits split
         JOIN dispatch_scm_po_split_lines line ON line.split_id = split.id
        WHERE split.source_po_id = $1 AND split.split_po_ref = $2
        GROUP BY split.id`,
      [sourcePoId, splitPoRef]
    );
    assert.equal(oneExtendedSplit.rowCount, 1);
    assert.equal(oneExtendedSplit.rows[0].line_count, 4);
    assert.equal(Number(oneExtendedSplit.rows[0].pallets), 3,
      "Later confirmed held quantity must extend the same local multi-yard split.");
    const extendedPalletLines = await query(
      `SELECT child.location_id, child.quantity
         FROM dispatch_scm_po_splits split
         JOIN purchase_order_lines child ON child.purchase_order_id = split.split_po_id
        WHERE split.source_po_id = $1
          AND split.split_po_ref = $2
          AND UPPER(BTRIM(COALESCE(NULLIF(child.sku, ''), child.item_name, ''))) = 'PALLET'
        ORDER BY child.location_id`,
      [sourcePoId, splitPoRef]
    );
    assert.deepEqual(
      extendedPalletLines.rows.map((line) => [Number(line.location_id), Number(line.quantity)]),
      [[1, 2], [15, 1]],
      "A later Blanket confirmation must extend the matching PALLET destination line without duplicating it."
    );

    const releasedWorkspace = await listSmartScmBlanketWorkspace({ limit: 20 });
    const releasedSource = releasedWorkspace.blanketOrders.find((order) => order.orderRef === sourcePoRef);
    assert.equal(releasedSource.remainingPallets, 7,
      "Created split quantity stays consumed while cancelled held quantity returns to the pool.");
    const splitChildWorkspace = await listSmartScmBlanketWorkspace({ search: splitPoRef, limit: 20 });
    assert.equal(splitChildWorkspace.candidates.length, 0, "Local split children must never appear as flaggable source POs.");

    await assert.rejects(
      () => setPurchaseOrderBlanketFlag(sourcePoRef, { isBlanket: false, updatedBy: actor }),
      (error) => error?.code === "SCM_BLANKET_UNFLAG_UNSAFE",
      "A source with an active split must not be unflagged."
    );

    return { proposalId, releaseId };
  }, { rollback: true });

  const sourceAfterRollback = await query(
    "SELECT COUNT(*)::int AS count FROM purchase_orders WHERE netsuite_id = $1",
    [sourcePoId]
  );
  assert.equal(sourceAfterRollback.rows[0].count, 0, "The Blanket workflow harness must roll back every fixture and split.");

  console.log(JSON.stringify({
    ok: true,
    proposalId: rolledBack.proposalId,
    releaseId: rolledBack.releaseId,
    exactReservation: true,
    idempotentFinalization: true,
    multiYardSingleSplit: true,
    quantityConserved: true,
    operationalExtensionBlocked: true,
    unsafeUnflagBlocked: true,
    rolledBack: true
  }));
} finally {
  await closeDb();
}
