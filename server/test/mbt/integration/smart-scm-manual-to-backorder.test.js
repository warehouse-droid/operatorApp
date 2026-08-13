import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, test } from "node:test";

import { closeDb, query, withTransaction } from "../../../src/db.js";
import { prepareSmartScmTransferExecution } from "../../../src/smart-scm-planning-repository.js";

after(async () => closeDb());

test("manual TO confirmation creates a backorder while the same automatic quantity remains blocked", async () => {
  await withTransaction(async () => {
    const seed = Number.parseInt(crypto.randomUUID().replaceAll("-", "").slice(0, 10), 16);
    const baseId = 8_300_000_000_000 + (seed * 20);
    const itemId = baseId + 1;
    const palletItemId = baseId + 2;
    const itemName = `MANUAL-BACKORDER-${seed}`;

    const pallet = await query(
      `SELECT item_id FROM inventory_items
        WHERE UPPER(BTRIM(COALESCE(item_name, ''))) = 'PALLET'
        ORDER BY item_id LIMIT 1`
    );
    if (pallet.rowCount) {
      await query("UPDATE inventory_items SET item_weight = 40 WHERE item_id = $1", [pallet.rows[0].item_id]);
    } else {
      await query(
        `INSERT INTO inventory_items (
           item_id, item_name, display_name, item_description, stock_unit,
           to_plt, to_lyr, to_sec, to_pcs, item_weight
         ) VALUES ($1,'PALLET','PALLET','Official pallet','EA',1,0,0,0,40)`,
        [palletItemId]
      );
    }
    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, display_name, item_description, stock_unit,
         to_plt, to_lyr, to_sec, to_pcs, item_weight
       ) VALUES ($1,$2,$2,'Manual TO backorder fixture','EA',10,0,0,0,100)`,
      [itemId, itemName]
    );
    await query(
      `INSERT INTO scm_smart_item_policies (
         item_id, item_name, item_description, vendor, vendor_code, stock_unit,
         to_plt, to_lyr, to_sec, to_pcs, lead_time_days, pallet_weight_lbs,
         inactive, discontinued, planning_enabled
       ) VALUES ($1,$2,'Manual TO backorder fixture','Harness','HARNESS','EA',
                 10,0,0,0,7,1000,false,false,true)`,
      [itemId, itemName]
    );
    await query(
      `INSERT INTO scm_smart_item_yard_policies (
         item_id, location_id, yard_code, eligible, capacity_pallets,
         service_quantile, minimum_safety_pallets
       ) VALUES
         ($1,1,'3445',true,80,0.90,1),
         ($1,15,'12441',true,80,0.90,1)`,
      [itemId]
    );
    await query(
      `INSERT INTO inventory_balances (
         item_id, location_id, location, quantity_on_hand, quantity_available
       ) VALUES
         ($1,1,'3445',32,32),
         ($1,15,'12441',0,0)`,
      [itemId]
    );
    const run = await query(
      `INSERT INTO scm_smart_planning_runs (
         status, trigger_source, revision, settings_snapshot, totals,
         completed_at, plan_kind
       ) VALUES ('ready','manual_backorder_test',1,'{"truck_capacity_lbs":78000}'::jsonb,
                 '{}'::jsonb,now(),'inventory')
       RETURNING id`
    );
    const runId = Number(run.rows[0].id);

    const createProposal = async ({ key, manual }) => {
      const proposal = await query(
        `INSERT INTO scm_smart_proposals (
           run_id, proposal_key, proposal_type, phase, source_kind,
           source_location_id, source_name, destination_location_id, destination_name,
           status, urgent, urgency_level, urgency_score, total_pallets,
           total_weight_lbs, utilization, memo, route_stops, proposal_origin
         ) VALUES (
           $1,$2,'TO','internal_transfer','yard',1,'3445',15,'12441',
           'reviewed',false,'normal',0,8,8000,0.103,$2,
           '[{"locationId":15,"name":"12441","sequence":1}]'::jsonb,'inventory'
         ) RETURNING id`,
        [runId, key]
      );
      const proposalId = Number(proposal.rows[0].id);
      const line = await query(
        `INSERT INTO scm_smart_proposal_lines (
           proposal_id, item_id, item_name, item_description, unit,
           required_pallets, proposed_pallets, confirmed_pallets, residual_pallets,
           sales_quantity, pallet_weight_lbs, line_weight_lbs,
           to_plt, to_lyr, to_sec, to_pcs, manual_planning_required, reason,
           destination_location_id, destination_name, urgent, urgency_level,
           urgency_score, provisional
         ) VALUES (
           $1,$2,$3,'Manual TO backorder fixture','EA',8,8,0,8,80,1000,8000,
           10,0,0,0,false,$4::jsonb,15,'12441',false,'normal',0,false
         ) RETURNING id`,
        [proposalId, itemId, itemName, JSON.stringify(manual
          ? { manuallyAdjusted: true, manualSourceFloorOverride: true }
          : {})]
      );
      return { proposalId, lineId: Number(line.rows[0].id) };
    };

    const automatic = await createProposal({ key: `automatic:${seed}`, manual: false });
    await assert.rejects(
      () => prepareSmartScmTransferExecution(automatic.proposalId, null),
      (error) => error?.status === 409 && /can transfer at most/i.test(error.message),
      "Automatic confirmation must still enforce actual stock and its protected floor."
    );

    const manual = await createProposal({ key: `manual-load:${seed}`, manual: true });
    const prepared = await prepareSmartScmTransferExecution(manual.proposalId, null);
    assert.equal(prepared.lines[0].palletQty, 8);
    assert.equal(prepared.lines[0].sourceBackorderPallets, 4.8);
    const saved = await query(
      `SELECT proposal.status, reservation.reserved_pallets, reservation.reserved_sales_quantity
         FROM scm_smart_proposals proposal
         JOIN scm_smart_inventory_reservations reservation ON reservation.proposal_line_id = $2
        WHERE proposal.id = $1`,
      [manual.proposalId, manual.lineId]
    );
    assert.equal(saved.rows[0].status, "executing");
    assert.equal(Number(saved.rows[0].reserved_pallets), 8);
    assert.equal(Number(saved.rows[0].reserved_sales_quantity), 80);
    const automaticState = await query("SELECT status FROM scm_smart_proposals WHERE id = $1", [automatic.proposalId]);
    assert.equal(automaticState.rows[0].status, "reviewed",
      "A rejected automatic proposal must not enter execution.");
  }, { rollback: true });
});
