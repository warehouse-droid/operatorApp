import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, test } from "node:test";

import { closeDb, query, withTransaction } from "../../../src/db.js";
import { updateSmartScmBlanketProposalLine } from "../../../src/smart-scm-blanket-repository.js";

after(async () => closeDb());

test("a manual Blanket edit takes priority and rebalances only competing planned loads in the same run", async () => {
  await withTransaction(async () => {
    const seed = Number.parseInt(crypto.randomUUID().replaceAll("-", "").slice(0, 10), 16);
    const baseId = 8_100_000_000_000 + (seed * 20);
    const sourcePoId = baseId + 1;
    const sourceLineId = baseId + 2;
    const itemId = baseId + 3;
    const vendorId = baseId + 4;
    const sourcePoRef = `BLANKET-REALLOC-${seed}`;
    const actor = `blanket-realloc-${crypto.randomUUID()}`;

    await query(
      `INSERT INTO operators (
         id, username, display_name, password_hash, password_salt, role, roles, active
       ) VALUES ($1,$1,$1,'harness','harness','admin',ARRAY['admin']::text[],true)`,
      [actor]
    );
    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
         destination_location_id, destination_location, source_location,
         dispatch_vendor_yard, receipt_status, initial_scm_status,
         is_blanket_po, netsuite_active, synced_at
       ) VALUES (
         $1,$2,current_date - 7,$3,$4,'pendingReceipt','Purchase Order : Pending Receipt',
         1,'3445',$5,$5,'not_received','Queued',true,true,now()
       )`,
      [sourcePoId, sourcePoRef, vendorId, `Blanket Reallocation Vendor ${seed}`, `Blanket Source ${seed}`]
    );
    await query(
      `INSERT INTO purchase_order_lines (
         id, purchase_order_id, line_id, item_id, item_name, sku, item_description,
         quantity, unit, location_id, location, pallet_qty, layer_qty, section_qty,
         piece_qty, to_plt, to_lyr, to_sec, to_pcs, netsuite_received_qty,
         netsuite_received_baseline_qty, netsuite_active, synced_at, item_weight, raw
       ) VALUES (
         $1,$2,10,$3,$4,$4,'Manual reallocation fixture',450,'EA',1,'3445',
         45,0,0,0,10,0,0,0,0,0,true,now(),100,'{}'::jsonb
       )`,
      [sourceLineId, sourcePoId, itemId, `BLANKET-REALLOC-ITEM-${seed}`]
    );
    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, display_name, item_description, stock_unit,
         to_plt, to_lyr, to_sec, to_pcs, item_weight, vendor_id, vendor
       ) VALUES ($1,$2,$2,'Manual reallocation fixture','EA',10,0,0,0,100,$3,$4)`,
      [itemId, `BLANKET-REALLOC-ITEM-${seed}`, vendorId, `Blanket Reallocation Vendor ${seed}`]
    );
    await query(
      `INSERT INTO scm_smart_item_policies (
         item_id, item_name, item_description, vendor, vendor_code, stock_unit,
         to_plt, to_lyr, to_sec, to_pcs, lead_time_days, pallet_weight_lbs,
         inactive, discontinued, planning_enabled, updated_by
       ) VALUES ($1,$2,'Manual reallocation fixture',$3,$4,'EA',10,0,0,0,7,1000,
                 false,false,true,$5)`,
      [itemId, `BLANKET-REALLOC-ITEM-${seed}`, `Blanket Reallocation Vendor ${seed}`, String(vendorId), actor]
    );
    await query(
      `INSERT INTO scm_smart_item_yard_policies (
         item_id, location_id, yard_code, eligible, capacity_pallets,
         service_quantile, minimum_safety_pallets, updated_by
       ) VALUES
         ($1,1,'3445',true,80,0.90,1,$2),
         ($1,15,'12441',true,80,0.90,1,$2),
         ($1,28,'2967',true,80,0.90,1,$2)`,
      [itemId, actor]
    );
    await query(
      `INSERT INTO inventory_balances (
         item_id, location_id, location, quantity_on_hand, quantity_available
       ) VALUES
         ($1,1,'3445',0,0),
         ($1,15,'12441',0,0),
         ($1,28,'2967',0,0)`,
      [itemId]
    );

    const createRun = async (key) => {
      const result = await query(
        `INSERT INTO scm_smart_planning_runs (
           status, trigger_source, revision, settings_snapshot, totals,
           created_by, completed_at, plan_kind
         ) VALUES ('ready','blanket_manual',1,'{"truck_capacity_lbs":78000}'::jsonb,
           '{}'::jsonb,$1,now(),'blanket')
         RETURNING id`,
        [`${actor}:${key}`]
      );
      return Number(result.rows[0].id);
    };
    const activeRunId = await createRun("active");
    const otherRunId = await createRun("other");

    const createProposal = async ({ runId, key, pallets, destinationLocationId, destinationName }) => {
      const proposalResult = await query(
        `INSERT INTO scm_smart_proposals (
           run_id, proposal_key, proposal_type, phase, source_kind, source_name,
           destination_location_id, destination_name, vendor, status, urgent,
           urgency_level, urgency_score, total_pallets, total_weight_lbs,
           utilization, memo, route_stops, proposal_origin,
           blanket_source_po_id, blanket_source_po_ref
         ) VALUES (
           $1,$2,'PO','direct_vendor','vendor',$3,$4,$5,$6,'held',false,
           'normal',0,$7,$8,0,$2,$9::jsonb,'blanket',$10,$11
         ) RETURNING id`,
        [runId, key, `Blanket Source ${seed}`, destinationLocationId, destinationName,
          `Blanket Reallocation Vendor ${seed}`, pallets, pallets * 1000,
          JSON.stringify([{ locationId: destinationLocationId, name: destinationName, sequence: 1 }]),
          sourcePoId, sourcePoRef]
      );
      const proposalId = Number(proposalResult.rows[0].id);
      const lineResult = await query(
        `INSERT INTO scm_smart_proposal_lines (
           proposal_id, item_id, item_name, item_description, unit,
           required_pallets, proposed_pallets, confirmed_pallets, residual_pallets,
           sales_quantity, pallet_weight_lbs, line_weight_lbs,
           to_plt, to_lyr, to_sec, to_pcs, manual_planning_required, reason,
           destination_location_id, destination_name, urgent, urgency_level,
           urgency_score, provisional
         ) VALUES (
           $1,$2,$3,'Manual reallocation fixture','EA',$4,$4,0,$4,$5,1000,$6,
           10,0,0,0,false,'{}'::jsonb,$7,$8,false,'normal',0,false
         ) RETURNING id`,
        [proposalId, itemId, `BLANKET-REALLOC-ITEM-${seed}`, pallets, pallets * 10,
          pallets * 1000, destinationLocationId, destinationName]
      );
      const lineId = Number(lineResult.rows[0].id);
      await query(
        `INSERT INTO scm_smart_blanket_allocations (
           proposal_id, proposal_line_id, source_po_id, source_po_ref,
           source_line_id, item_id, destination_location_id, destination_name,
           planned_pallets, planned_sales_qty
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [proposalId, lineId, sourcePoId, sourcePoRef, sourceLineId, itemId,
          destinationLocationId, destinationName, pallets, pallets * 10]
      );
      return { proposalId, lineId };
    };

    const donor = await createProposal({
      runId: activeRunId,
      key: `blanket:${sourcePoId}:donor`,
      pallets: 35,
      destinationLocationId: 1,
      destinationName: "3445"
    });
    const target = await createProposal({
      runId: activeRunId,
      key: `blanket:${sourcePoId}:target`,
      pallets: 3,
      destinationLocationId: 15,
      destinationName: "12441"
    });
    const reserved = await createProposal({
      runId: activeRunId,
      key: `blanket:${sourcePoId}:reserved`,
      pallets: 5,
      destinationLocationId: 28,
      destinationName: "2967"
    });
    const reservedRelease = await query(
      `INSERT INTO scm_smart_blanket_releases (
         proposal_id, run_id, source_po_id, source_po_ref, idempotency_key,
         status, reserved_by
       ) VALUES ($1,$2,$3,$4,$5,'reserved',$6)
       RETURNING id`,
      [reserved.proposalId, activeRunId, sourcePoId, sourcePoRef, `${actor}:reserved`, actor]
    );
    await query(
      `UPDATE scm_smart_blanket_allocations
          SET release_id = $2,
              status = 'reserved',
              reserved_pallets = planned_pallets,
              reserved_sales_qty = planned_sales_qty,
              updated_at = now()
        WHERE proposal_line_id = $1`,
      [reserved.lineId, Number(reservedRelease.rows[0].id)]
    );
    const otherRun = await createProposal({
      runId: otherRunId,
      key: `blanket:${sourcePoId}:other-run`,
      pallets: 7,
      destinationLocationId: 28,
      destinationName: "2967"
    });

    await updateSmartScmBlanketProposalLine(target.proposalId, target.lineId, {
      proposedPallets: 20,
      destinationLocationId: 15
    }, actor);

    const activeRows = await query(
      `SELECT proposal.id AS proposal_id, line.id AS line_id,
              line.proposed_pallets, proposal.total_pallets,
              SUM(allocation.planned_pallets)::numeric AS allocated_pallets
         FROM scm_smart_proposals proposal
         JOIN scm_smart_proposal_lines line ON line.proposal_id = proposal.id
         JOIN scm_smart_blanket_allocations allocation ON allocation.proposal_line_id = line.id
        WHERE proposal.id = ANY($1::bigint[])
        GROUP BY proposal.id, line.id
        ORDER BY proposal.id`,
      [[donor.proposalId, target.proposalId]]
    );
    assert.deepEqual(activeRows.rows.map((row) => ({
      proposalId: Number(row.proposal_id),
      proposedPallets: Number(row.proposed_pallets),
      totalPallets: Number(row.total_pallets),
      allocatedPallets: Number(row.allocated_pallets)
    })), [
      { proposalId: donor.proposalId, proposedPallets: 20, totalPallets: 20, allocatedPallets: 20 },
      { proposalId: target.proposalId, proposedPallets: 20, totalPallets: 20, allocatedPallets: 20 }
    ], "The edited 3-PLT load must own 20 PLT and reduce the competing 35-PLT load to the 20-PLT balance.");

    const otherRunRow = await query(
      `SELECT line.proposed_pallets, allocation.planned_pallets
         FROM scm_smart_proposal_lines line
         JOIN scm_smart_blanket_allocations allocation ON allocation.proposal_line_id = line.id
        WHERE line.id = $1`,
      [otherRun.lineId]
    );
    assert.equal(Number(otherRunRow.rows[0].proposed_pallets), 7);
    assert.equal(Number(otherRunRow.rows[0].planned_pallets), 7,
      "A manual edit must not rewrite a proposal from another planning run.");
    const reservedRow = await query(
      `SELECT line.proposed_pallets, allocation.planned_pallets,
              allocation.reserved_pallets, allocation.status
         FROM scm_smart_proposal_lines line
         JOIN scm_smart_blanket_allocations allocation ON allocation.proposal_line_id = line.id
        WHERE line.id = $1`,
      [reserved.lineId]
    );
    assert.equal(Number(reservedRow.rows[0].proposed_pallets), 5);
    assert.equal(Number(reservedRow.rows[0].planned_pallets), 5);
    assert.equal(Number(reservedRow.rows[0].reserved_pallets), 5);
    assert.equal(reservedRow.rows[0].status, "reserved",
      "A manual edit must never take quantity back from a confirmed Blanket reservation.");

    await updateSmartScmBlanketProposalLine(target.proposalId, target.lineId, {
      proposedPallets: 40,
      destinationLocationId: 15
    }, actor);
    const donorAfterFullPriority = await query(
      "SELECT id FROM scm_smart_proposals WHERE id = $1",
      [donor.proposalId]
    );
    assert.equal(donorAfterFullPriority.rowCount, 0,
      "A donor load reduced to zero must be removed instead of leaving a zero-quantity proposal behind.");
    const finalAllocation = await query(
      `SELECT line.proposed_pallets, proposal.total_pallets,
              SUM(allocation.planned_pallets)::numeric AS allocated_pallets
         FROM scm_smart_proposals proposal
         JOIN scm_smart_proposal_lines line ON line.proposal_id = proposal.id
         JOIN scm_smart_blanket_allocations allocation ON allocation.proposal_line_id = line.id
        WHERE proposal.id = $1
        GROUP BY proposal.id, line.id`,
      [target.proposalId]
    );
    assert.equal(Number(finalAllocation.rows[0].proposed_pallets), 40);
    assert.equal(Number(finalAllocation.rows[0].total_pallets), 40);
    assert.equal(Number(finalAllocation.rows[0].allocated_pallets), 40);
  }, { rollback: true });
});
