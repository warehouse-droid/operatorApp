import assert from "node:assert/strict";
import { closeDb, query, withTransaction } from "./db.js";
import {
  listSmartScmVendorReplyLoads,
  stageSmartScmVendorReplyLoad
} from "./smart-scm-vendor-repository.js";

const token = `vendor-hold-split-${Date.now()}`;
const itemIds = {
  confirm: -Number(`${Date.now()}1`),
  partialHold: -Number(`${Date.now()}2`),
  fullHold: -Number(`${Date.now()}3`),
  cancel: -Number(`${Date.now()}4`)
};
const requestedByItem = new Map([
  [itemIds.confirm, 5],
  [itemIds.partialHold, 4],
  [itemIds.fullHold, 3],
  [itemIds.cancel, 1]
]);

async function insertLine(proposalId, itemId, itemName, pallets) {
  const result = await query(
    `INSERT INTO scm_smart_proposal_lines (
       proposal_id, item_id, item_name, item_description, unit,
       required_pallets, proposed_pallets, confirmed_pallets, residual_pallets,
       sales_quantity, pallet_weight_lbs, line_weight_lbs,
       to_plt, to_lyr, to_sec, to_pcs, manual_planning_required, reason,
       destination_location_id, destination_name, urgent, provisional
     ) VALUES (
       $1, $2, $3, $4, 'EA',
       $5::numeric, $5::numeric, 0, $5::numeric,
       $5::numeric * 10, 100, $5::numeric * 100,
       10, 0, 0, 0, false, $6::jsonb,
       987654, $7, false, false
     ) RETURNING id`,
    [proposalId, itemId, itemName, `${token} integration line`, pallets, JSON.stringify({ harness: token }), `${token} yard`]
  );
  return Number(result.rows[0].id);
}

try {
  const rolledBack = await withTransaction(async () => {
    const runResult = await query(
      `INSERT INTO scm_smart_planning_runs
         (status, trigger_source, revision, settings_snapshot, totals, created_by, completed_at)
       VALUES ('completed', 'manual', 1, '{}'::jsonb, '{}'::jsonb, $1, now())
       RETURNING id`,
      [token]
    );
    const runId = Number(runResult.rows[0].id);
    const proposalKey = `${token}:source`;
    const sourceResult = await query(
      `INSERT INTO scm_smart_proposals (
         run_id, proposal_key, proposal_type, phase, source_kind, source_name,
         destination_location_id, destination_name, vendor, status,
         total_pallets, total_weight_lbs, utilization, vendor_reply_due_at,
         memo, order_requested_at, order_requested_by, vendor_response_status
       ) VALUES (
         $1, $2, 'PO', 'direct_vendor', 'vendor', $3,
         987654, $4, $5, 'order_requested',
         13, 1300, 0.1, now() + interval '1 day',
         $6, now(), $7, 'awaiting'
       ) RETURNING id`,
      [runId, proposalKey, `${token} source`, `${token} yard`, `${token} vendor`, `${token} source load`, token]
    );
    const sourceProposalId = Number(sourceResult.rows[0].id);
    const lineIds = {
      confirm: await insertLine(sourceProposalId, itemIds.confirm, `${token} confirm`, 5),
      partialHold: await insertLine(sourceProposalId, itemIds.partialHold, `${token} partial hold`, 4),
      fullHold: await insertLine(sourceProposalId, itemIds.fullHold, `${token} full hold`, 3),
      cancel: await insertLine(sourceProposalId, itemIds.cancel, `${token} cancel`, 1)
    };

    const staged = await stageSmartScmVendorReplyLoad(sourceProposalId, {
      responseSource: "hold_split_harness",
      remarks: token,
      palletQuantityOverrides: { 987654: 2.75 },
      lines: [
        { proposalLineId: lineIds.confirm, decision: "confirm", decisionPallets: 5 },
        { proposalLineId: lineIds.partialHold, decision: "hold", decisionPallets: 2 },
        { proposalLineId: lineIds.fullHold, decision: "hold", decisionPallets: 3 },
        { proposalLineId: lineIds.cancel, decision: "cancel", decisionPallets: 0 }
      ]
    }, null);

    assert.ok(staged.reviewProposalId, "Confirmed lines must create a NetSuite PO review load.");
    assert.ok(staged.cancelledProposalId, "Cancel and unused Hold quantities must create cancellation history.");
    assert.equal(staged.heldProposalIds.length, 2, "Each held line must create its own child load.");
    assert.equal(new Set(staged.heldProposalIds).size, 2);
    assert.equal(staged.heldLoads.length, 2);
    assert(staged.heldLoads.every((load) => load.status === "vendor_replied"));
    assert(staged.heldLoads.every((load) => load.lines.length === 1));
    assert.deepEqual(staged.heldLoads.map((load) => load.totalPallets).sort((a, b) => a - b), [2, 3]);
    assert.equal(staged.source.status, "superseded");
    assert.equal(staged.source.lines.length, 0, "The staged source load must not retain hidden held lines.");
    assert.equal(staged.review.lines.length, 1);
    assert.equal(staged.review.lines[0].confirmedPallets, 5);
    assert.equal(staged.review.palletQuantityOverrides["987654"], 2.75);
    assert.equal(staged.review.palletLines.length, 1);
    assert.equal(staged.review.palletLines[0].automaticQuantity, 5);
    assert.equal(staged.review.palletLines[0].overrideQuantity, 2.75);
    assert.equal(staged.review.palletLines[0].confirmedPallets, 2.75);
    assert.equal(staged.review.palletLines[0].overridden, true);
    assert(staged.heldLoads.every((load) => Object.keys(load.palletQuantityOverrides || {}).length === 0));
    assert.equal(Object.keys(staged.cancelled.palletQuantityOverrides || {}).length, 0);

    const partialHeld = staged.heldLoads.flatMap((load) => load.lines)
      .find((line) => line.itemId === itemIds.partialHold);
    assert.ok(partialHeld);
    assert.equal(partialHeld.proposedPallets, 2);
    assert.equal(partialHeld.confirmedPallets, 0);
    assert.equal(partialHeld.residualPallets, 2);
    assert.equal(partialHeld.reason.vendorReplyDraft.decisionPallets, 2);
    assert.equal(partialHeld.reason.vendorHoldSplit.originalPallets, 4);
    assert.equal(partialHeld.reason.vendorHoldSplit.cancelledRemainderPallets, 2);

    const cancelledLines = staged.cancelled.lines;
    assert.equal(cancelledLines.length, 2, "Cancellation history must contain explicit Cancel and the partial Hold remainder.");
    assert(cancelledLines.every((line) => line.confirmedPallets === 0));
    assert(cancelledLines.every((line) => line.salesQuantity === 0));
    const heldRemainder = cancelledLines.find((line) => line.itemId === itemIds.partialHold);
    assert.ok(heldRemainder);
    assert.equal(heldRemainder.proposedPallets, 2);
    assert.equal(heldRemainder.reason.vendorHoldRemainder.heldPallets, 2);
    assert.equal(heldRemainder.reason.vendorHoldRemainder.cancelledPallets, 2);

    const queue = await listSmartScmVendorReplyLoads({ search: token, limit: 20 });
    assert.deepEqual(
      queue.map((load) => load.id).sort((a, b) => a - b),
      [...staged.heldProposalIds].sort((a, b) => a - b),
      "Only the separate held child loads should remain visible in Vendor Replies."
    );

    const children = await query(
      `SELECT id, parent_proposal_id, vendor_resolution_kind, status
         FROM scm_smart_proposals
        WHERE parent_proposal_id = $1
        ORDER BY id`,
      [sourceProposalId]
    );
    assert.equal(children.rowCount, 4);
    const heldChildren = children.rows.filter((row) => row.vendor_resolution_kind === null && row.status === "vendor_replied");
    assert.equal(heldChildren.length, 2);

    const conserved = await query(
      `SELECT line.item_id, SUM(line.proposed_pallets)::numeric AS accounted_pallets
         FROM scm_smart_proposals proposal
         JOIN scm_smart_proposal_lines line ON line.proposal_id = proposal.id
        WHERE proposal.parent_proposal_id = $1
        GROUP BY line.item_id`,
      [sourceProposalId]
    );
    assert.equal(conserved.rowCount, 4);
    for (const row of conserved.rows) {
      assert.equal(Number(row.accounted_pallets), requestedByItem.get(Number(row.item_id)), `Item ${row.item_id} must conserve requested pallets.`);
    }
    assert(staged.conservation.every((entry) => entry.conserved));
    assert.deepEqual(staged.heldSplits.map((split) => split.cancelledRemainderPallets).sort((a, b) => a - b), [0, 2]);

    const revision = await query(
      `SELECT diff
         FROM scm_smart_plan_revisions
        WHERE run_id = $1 AND reason = 'vendor_reply_staged'
        ORDER BY revision DESC
        LIMIT 1`,
      [runId]
    );
    assert.equal(revision.rowCount, 1);
    assert.equal(revision.rows[0].diff.heldProposalIds.length, 2);
    assert(revision.rows[0].diff.conservation.every((entry) => entry.conserved));

    return { proposalKey, sourceProposalId, heldProposalIds: staged.heldProposalIds };
  }, { rollback: true });

  const afterRollback = await query(
    "SELECT COUNT(*)::int AS count FROM scm_smart_proposals WHERE proposal_key = $1",
    [rolledBack.proposalKey]
  );
  assert.equal(afterRollback.rows[0].count, 0, "The integration harness must roll back its source and all child loads.");

  console.log(JSON.stringify({
    ok: true,
    heldChildLoads: rolledBack.heldProposalIds.length,
    partialHoldRemainderAudited: true,
    palletOverrideCopiedOnlyToReview: true,
    palletsConserved: true,
    rolledBack: true
  }));
} finally {
  await closeDb();
}
