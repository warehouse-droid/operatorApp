import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, test } from "node:test";

import { closeDb, query, withTransaction } from "../../../src/db.js";
import {
  addSmartScmBlanketProposalSourceLine,
  searchSmartScmBlanketProposalSourceItems
} from "../../../src/smart-scm-blanket-repository.js";

after(async () => closeDb());

test("a held Blanket load can add only available items from its exact source PO", async () => {
  await withTransaction(async () => {
    const seed = Number.parseInt(crypto.randomUUID().replaceAll("-", "").slice(0, 8), 16);
    const baseId = 8_300_000_000_000 + (seed * 100);
    const sourcePoId = baseId + 1;
    const foreignPoId = baseId + 2;
    const existingSourceLineId = baseId + 3;
    const candidateSourceLineId = baseId + 4;
    const foreignSourceLineId = baseId + 5;
    const existingItemId = baseId + 6;
    const candidateItemId = baseId + 7;
    const vendorId = baseId + 8;
    const sourcePoRef = `BLANKET-ADD-${seed}`;
    const actor = `blanket-add-${crypto.randomUUID()}`;

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
       ) VALUES
         ($1,$2,current_date - 7,$4,$5,'pendingReceipt','Purchase Order : Pending Receipt',
          1,'3445',$6,$6,'not_received','Queued',true,true,now()),
         ($3,$7,current_date - 6,$4,$5,'pendingReceipt','Purchase Order : Pending Receipt',
          1,'3445',$6,$6,'not_received','Queued',true,true,now())`,
      [sourcePoId, sourcePoRef, foreignPoId, vendorId, `Blanket Add Vendor ${seed}`,
        `Blanket Add Source ${seed}`, `FOREIGN-BLANKET-${seed}`]
    );
    await query(
      `INSERT INTO purchase_order_lines (
         id, purchase_order_id, line_id, item_id, item_name, sku, item_description,
         quantity, unit, location_id, location, pallet_qty, layer_qty, section_qty,
         piece_qty, to_plt, to_lyr, to_sec, to_pcs, netsuite_received_qty,
         netsuite_received_baseline_qty, netsuite_active, synced_at, item_weight, raw
       ) VALUES
         ($1,$4,10,$6,$8,$8,'Existing Blanket fixture',20,'EA',1,'3445',2,0,0,0,10,0,0,0,0,0,true,now(),100,'{}'::jsonb),
         ($2,$4,20,$7,$9,$9,'Candidate Blanket fixture',100,'EA',1,'3445',10,0,0,0,10,0,0,0,0,0,true,now(),100,'{}'::jsonb),
         ($3,$5,20,$7,$9,$9,'Foreign Blanket fixture',100,'EA',1,'3445',10,0,0,0,10,0,0,0,0,0,true,now(),100,'{}'::jsonb)`,
      [existingSourceLineId, candidateSourceLineId, foreignSourceLineId, sourcePoId, foreignPoId,
        existingItemId, candidateItemId, `BLANKET-EXISTING-${seed}`, `BLANKET-CANDIDATE-${seed}`]
    );
    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, display_name, item_description, stock_unit,
         to_plt, to_lyr, to_sec, to_pcs, item_weight, vendor_id, vendor
       ) VALUES
         ($1,$3,$3,'Existing Blanket fixture','EA',10,0,0,0,100,$5,$6),
         ($2,$4,$4,'Candidate Blanket fixture','EA',10,0,0,0,100,$5,$6)`,
      [existingItemId, candidateItemId, `BLANKET-EXISTING-${seed}`, `BLANKET-CANDIDATE-${seed}`,
        vendorId, `Blanket Add Vendor ${seed}`]
    );
    await query(
      `INSERT INTO scm_smart_item_policies (
         item_id, item_name, item_description, vendor, vendor_code, stock_unit,
         to_plt, to_lyr, to_sec, to_pcs, lead_time_days, pallet_weight_lbs,
         inactive, discontinued, planning_enabled, updated_by
       ) VALUES
         ($1,$3,'Existing Blanket fixture',$5,$6,'EA',10,0,0,0,7,1000,false,false,true,$7),
         ($2,$4,'Candidate Blanket fixture',$5,$6,'EA',10,0,0,0,7,1000,false,false,true,$7)`,
      [existingItemId, candidateItemId, `BLANKET-EXISTING-${seed}`, `BLANKET-CANDIDATE-${seed}`,
        `Blanket Add Vendor ${seed}`, String(vendorId), actor]
    );
    await query(
      `INSERT INTO scm_smart_item_yard_policies (
         item_id, location_id, yard_code, eligible, capacity_pallets,
         service_quantile, minimum_safety_pallets, updated_by
       ) VALUES
         ($1,1,'3445',true,80,0.90,1,$3),
         ($2,1,'3445',true,80,0.90,1,$3)`,
      [existingItemId, candidateItemId, actor]
    );
    await query(
      `INSERT INTO inventory_balances (
         item_id, location_id, location, quantity_on_hand, quantity_available
       ) VALUES ($1,1,'3445',0,0), ($2,1,'3445',0,0)`,
      [existingItemId, candidateItemId]
    );

    const runResult = await query(
      `INSERT INTO scm_smart_planning_runs (
         status, trigger_source, revision, settings_snapshot, totals,
         created_by, completed_at, plan_kind
       ) VALUES ('ready','blanket_manual',1,'{"truck_capacity_lbs":78000}'::jsonb,
         '{}'::jsonb,$1,now(),'blanket') RETURNING id`,
      [actor]
    );
    const runId = Number(runResult.rows[0].id);
    const createProposal = async ({ key, itemId, itemName, sourceLineId, pallets }) => {
      const proposalResult = await query(
        `INSERT INTO scm_smart_proposals (
           run_id, proposal_key, proposal_type, phase, source_kind, source_name,
           destination_location_id, destination_name, vendor, status, urgent,
           urgency_level, urgency_score, total_pallets, total_weight_lbs,
           utilization, memo, route_stops, proposal_origin,
           blanket_source_po_id, blanket_source_po_ref
         ) VALUES (
           $1,$2,'PO','direct_vendor','vendor',$3,1,'3445',$4,'held',false,
           'normal',0,$5,$6,0,$2,'[{"locationId":1,"name":"3445","sequence":1}]'::jsonb,
           'blanket',$7,$8
         ) RETURNING id`,
        [runId, key, `Blanket Add Source ${seed}`, `Blanket Add Vendor ${seed}`,
          pallets, pallets * 1000, sourcePoId, sourcePoRef]
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
           $1,$2,$3,'Blanket source-item fixture','EA',$4,$4,0,$4,$5,1000,$6,
           10,0,0,0,false,'{}'::jsonb,1,'3445',false,'normal',0,false
         ) RETURNING id`,
        [proposalId, itemId, itemName, pallets, pallets * 10, pallets * 1000]
      );
      const lineId = Number(lineResult.rows[0].id);
      await query(
        `INSERT INTO scm_smart_blanket_allocations (
           proposal_id, proposal_line_id, source_po_id, source_po_ref,
           source_line_id, item_id, destination_location_id, destination_name,
           planned_pallets, planned_sales_qty
         ) VALUES ($1,$2,$3,$4,$5,$6,1,'3445',$7,$8)`,
        [proposalId, lineId, sourcePoId, sourcePoRef, sourceLineId, itemId, pallets, pallets * 10]
      );
      return { proposalId, lineId };
    };

    const target = await createProposal({
      key: `blanket-add-target:${seed}`,
      itemId: existingItemId,
      itemName: `BLANKET-EXISTING-${seed}`,
      sourceLineId: existingSourceLineId,
      pallets: 2
    });
    await createProposal({
      key: `blanket-add-competing:${seed}`,
      itemId: candidateItemId,
      itemName: `BLANKET-CANDIDATE-${seed}`,
      sourceLineId: candidateSourceLineId,
      pallets: 4
    });

    const candidates = await searchSmartScmBlanketProposalSourceItems(target.proposalId, {
      search: `BLANKET-CANDIDATE-${seed}`,
      destinationLocationId: 1,
      limit: 20
    });
    assert.equal(candidates.length, 1, "The held load must find an unused item on its source PO.");
    assert.equal(candidates[0].sourcePoId, sourcePoId);
    assert.equal(candidates[0].sourceLineId, candidateSourceLineId);
    assert.equal(candidates[0].availableForPlanningPallets, 6,
      "The addable balance must subtract sibling planned allocations from the physical 10-PLT source balance.");

    await assert.rejects(
      addSmartScmBlanketProposalSourceLine(target.proposalId, {
        sourceLineId: foreignSourceLineId,
        itemId: candidateItemId,
        proposedPallets: 1,
        destinationLocationId: 1
      }, actor),
      /same source Blanket PO/i
    );
    await assert.rejects(
      addSmartScmBlanketProposalSourceLine(target.proposalId, {
        sourceLineId: candidateSourceLineId,
        itemId: candidateItemId,
        proposedPallets: 7,
        destinationLocationId: 1
      }, actor),
      /Only 6 whole PLT remain available/i
    );
    const afterRejected = await query(
      "SELECT COUNT(*)::int AS count FROM scm_smart_proposal_lines WHERE proposal_id = $1 AND item_id = $2",
      [target.proposalId, candidateItemId]
    );
    assert.equal(afterRejected.rows[0].count, 0, "Rejected additions must not leave a partial proposal line.");

    const updated = await addSmartScmBlanketProposalSourceLine(target.proposalId, {
      sourceLineId: candidateSourceLineId,
      itemId: candidateItemId,
      proposedPallets: 6,
      destinationLocationId: 1
    }, actor);
    const addedLine = updated.lines.find((line) => Number(line.itemId) === candidateItemId);
    assert(addedLine, "The selected source-PO item must appear in the held Blanket load.");
    assert.equal(addedLine.proposedPallets, 6);
    assert.equal(addedLine.reason?.blanketManuallyAdded, true);

    const ledger = await query(
      `SELECT allocation.source_po_id, allocation.source_line_id,
              SUM(allocation.planned_pallets)::numeric AS planned_pallets,
              SUM(allocation.planned_sales_qty)::numeric AS planned_sales_qty
         FROM scm_smart_blanket_allocations allocation
         JOIN scm_smart_proposals proposal ON proposal.id = allocation.proposal_id
        WHERE proposal.run_id = $1
          AND allocation.source_line_id = $2
          AND allocation.status = 'planned'
        GROUP BY allocation.source_po_id, allocation.source_line_id`,
      [runId, candidateSourceLineId]
    );
    assert.deepEqual({
      sourcePoId: Number(ledger.rows[0].source_po_id),
      sourceLineId: Number(ledger.rows[0].source_line_id),
      plannedPallets: Number(ledger.rows[0].planned_pallets),
      plannedSalesQty: Number(ledger.rows[0].planned_sales_qty)
    }, {
      sourcePoId,
      sourceLineId: candidateSourceLineId,
      plannedPallets: 10,
      plannedSalesQty: 100
    }, "All same-run plans together may reach, but never exceed, the exact source-line balance.");
  });
});
