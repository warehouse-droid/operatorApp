import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  mergeSmartScmBlanketProposals
} from "../../../src/smart-scm-blanket-repository.js";

after(closeDb);

const seed = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const baseId = 9_300_000_000_000 + Number(seed.slice(-8)) * 1000;
const actor = `blanket-merge-${seed}`;
const sourceName = `Blanket Merge Yard ${seed}`;
const vendorName = `Blanket Merge Vendor ${seed}`;
const itemIds = Object.freeze({ first: baseId + 1, second: baseId + 2, pallet: baseId + 3 });
let sourceSequence = 0;
let proposalSequence = 0;

async function createRun(capacity = 6000) {
  const result = await query(
    `INSERT INTO scm_smart_planning_runs (
       status, trigger_source, revision, settings_snapshot, totals,
       created_by, completed_at, plan_kind
     ) VALUES ('ready','blanket_manual',1,$1::jsonb,'{}'::jsonb,$2,now(),'blanket')
     RETURNING id`,
    [JSON.stringify({ truck_capacity_lbs: capacity }), actor]
  );
  return Number(result.rows[0].id);
}

async function createSource() {
  sourceSequence += 1;
  const sourcePoId = baseId + 1000 + (sourceSequence * 100);
  const sourcePoRef = `BLANKET-MERGE-SOURCE-${seed}-${sourceSequence}`;
  const firstLineId = sourcePoId + 1;
  const secondLineId = sourcePoId + 2;
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
       destination_location_id, destination_location, source_location,
       dispatch_vendor_yard, receipt_status, initial_scm_status,
       is_blanket_po, netsuite_active, synced_at
     ) VALUES (
       $1,$2,current_date - 30,$3,$4,'pendingReceipt','Purchase Order : Pending Receipt',
       1,'3445',$5,$5,'not_received','Queued',true,true,now()
     )`,
    [sourcePoId, sourcePoRef, baseId + 50, vendorName, sourceName]
  );
  await query(
    `INSERT INTO purchase_order_lines (
       id, purchase_order_id, line_id, item_id, item_name, sku, item_description,
       quantity, unit, location_id, location, pallet_qty, to_plt,
       netsuite_received_qty, netsuite_received_baseline_qty,
       netsuite_active, synced_at, item_weight, raw
     ) VALUES
       ($1,$2,10,$3,$4,$4,'Blanket merge first item',1000,'EA',1,'3445',100,10,0,0,true,now(),100,'{}'::jsonb),
       ($5,$2,20,$6,$7,$7,'Blanket merge second item',1000,'EA',1,'3445',100,10,0,0,true,now(),100,'{}'::jsonb)`,
    [firstLineId, sourcePoId, itemIds.first, `BLANKET-MERGE-FIRST-${seed}`,
      secondLineId, itemIds.second, `BLANKET-MERGE-SECOND-${seed}`]
  );
  return {
    sourcePoId,
    sourcePoRef,
    lineIds: new Map([[itemIds.first, firstLineId], [itemIds.second, secondLineId]])
  };
}

async function createProposal({
  runId,
  source,
  lines,
  status = "held",
  palletQuantityOverrides = {}
}) {
  proposalSequence += 1;
  const routeStops = [...new Map(lines.map((line) => [line.destinationLocationId, {
    locationId: line.destinationLocationId,
    name: line.destinationName,
    sequence: 0
  }])).values()].map((stop, index) => ({ ...stop, sequence: index + 1 }));
  const totalPallets = lines.reduce((sum, line) => sum + line.pallets, 0);
  const inserted = await query(
    `INSERT INTO scm_smart_proposals (
       run_id, proposal_key, proposal_type, phase, source_kind, source_name,
       destination_location_id, destination_name, vendor, plant, status,
       urgent, urgency_level, urgency_score, provisional, total_pallets,
       total_weight_lbs, utilization, memo, route_stops,
       pallet_quantity_overrides, proposal_origin,
       blanket_source_po_id, blanket_source_po_ref
     ) VALUES (
       $1,$2,'PO','direct_vendor','vendor',$3,$4,$5,$6,$3,$7,
       false,'normal',0,false,$8,$9,$10,$11,$12::jsonb,$13::jsonb,
       'blanket',$14,$15
     ) RETURNING id`,
    [runId, `blanket-merge-fixture:${seed}:${proposalSequence}`, sourceName,
      routeStops[0].locationId, routeStops[0].name, vendorName, status,
      totalPallets, totalPallets * 1000, totalPallets / 6,
      `Blanket merge fixture ${proposalSequence}`, JSON.stringify(routeStops),
      JSON.stringify(palletQuantityOverrides), source.sourcePoId, source.sourcePoRef]
  );
  const proposalId = Number(inserted.rows[0].id);
  for (const line of lines) {
    const proposalLine = await query(
      `INSERT INTO scm_smart_proposal_lines (
         proposal_id, item_id, item_name, item_description, unit,
         required_pallets, proposed_pallets, confirmed_pallets, residual_pallets,
         sales_quantity, pallet_weight_lbs, line_weight_lbs,
         to_plt, to_lyr, to_sec, to_pcs, manual_planning_required, reason,
         destination_location_id, destination_name, urgent, urgency_level,
         urgency_score, provisional
       ) VALUES (
         $1,$2,$3,$4,'EA',$5,$5,0,$5,$6,1000,$7,10,0,0,0,false,$8::jsonb,
         $9,$10,false,'normal',0,false
       ) RETURNING id`,
      [proposalId, line.itemId, line.itemName, `${line.itemName} merge fixture`, line.pallets,
        line.pallets * 10, line.pallets * 1000,
        JSON.stringify({ mergeFixture: true }), line.destinationLocationId, line.destinationName]
    );
    await query(
      `INSERT INTO scm_smart_blanket_allocations (
         proposal_id, proposal_line_id, source_po_id, source_po_ref,
         source_line_id, item_id, destination_location_id, destination_name,
         planned_pallets, planned_sales_qty
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [proposalId, proposalLine.rows[0].id, source.sourcePoId, source.sourcePoRef,
        source.lineIds.get(line.itemId), line.itemId, line.destinationLocationId,
        line.destinationName, line.pallets, line.pallets * 10]
    );
  }
  return proposalId;
}

function firstLine(pallets, destinationLocationId = 1, destinationName = "3445") {
  return {
    itemId: itemIds.first,
    itemName: `BLANKET-MERGE-FIRST-${seed}`,
    pallets,
    destinationLocationId,
    destinationName
  };
}

function secondLine(pallets, destinationLocationId = 15, destinationName = "12441") {
  return {
    itemId: itemIds.second,
    itemName: `BLANKET-MERGE-SECOND-${seed}`,
    pallets,
    destinationLocationId,
    destinationName
  };
}

async function proposalStates(proposalIds) {
  const result = await query(
    `SELECT id, status, merged_into_proposal_id
       FROM scm_smart_proposals
      WHERE id = ANY($1::bigint[])
      ORDER BY id`,
    [proposalIds]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    status: row.status,
    mergedIntoProposalId: row.merged_into_proposal_id === null ? null : Number(row.merged_into_proposal_id)
  }));
}

before(async () => {
  await query(
    `INSERT INTO operators (
       id, username, display_name, password_hash, password_salt, role, roles, active
     ) VALUES ($1,$1,$1,'harness','harness','admin',ARRAY['admin']::text[],true)`,
    [actor]
  );
  await query(
    `INSERT INTO inventory_items (
       item_id, item_name, display_name, item_description, stock_unit,
       to_plt, item_weight, vendor_id, vendor
     ) VALUES
       ($1,$2,$2,'Blanket merge first item','EA',10,100,$4,$5),
       ($3,'PALLET','PALLET','Official pallet','EA',1,0,NULL,NULL)`,
    [itemIds.first, `BLANKET-MERGE-FIRST-${seed}`, itemIds.pallet, baseId + 50, vendorName]
  );
  await query(
    `INSERT INTO inventory_items (
       item_id, item_name, display_name, item_description, stock_unit,
       to_plt, item_weight, vendor_id, vendor
     ) VALUES ($1,$2,$2,'Blanket merge second item','EA',10,100,$3,$4)`,
    [itemIds.second, `BLANKET-MERGE-SECOND-${seed}`, baseId + 50, vendorName]
  );
  await query("UPDATE scm_smart_settings SET truck_capacity_lbs = 6000 WHERE id = 1");
});

test("compatible Blanket loads merge atomically with whole-pallet capacity and exact source lineage", async () => {
  const runId = await createRun();
  const source = await createSource();
  const firstProposalId = await createProposal({
    runId,
    source,
    lines: [firstLine(3), secondLine(2)],
    palletQuantityOverrides: { 1: 4 }
  });
  const secondProposalId = await createProposal({
    runId,
    source,
    lines: [firstLine(2), secondLine(2)],
    palletQuantityOverrides: { 15: 5 }
  });

  const merged = await mergeSmartScmBlanketProposals(
    [secondProposalId, firstProposalId, secondProposalId],
    actor
  );
  assert.equal(merged.reused, false);
  assert.deepEqual(merged.sourceProposalIds, [firstProposalId, secondProposalId].sort((left, right) => left - right));
  assert.equal(merged.deferredPallets, 3);

  const replacement = await query(
    `SELECT * FROM scm_smart_proposals WHERE id = $1`,
    [merged.mergedProposalId]
  );
  assert.equal(replacement.rowCount, 1);
  assert.equal(replacement.rows[0].status, "held");
  assert.equal(replacement.rows[0].proposal_origin, "blanket");
  assert.equal(Number(replacement.rows[0].blanket_source_po_id), source.sourcePoId);
  assert.equal(replacement.rows[0].manually_grouped, true);
  assert.equal(Number(replacement.rows[0].total_pallets), 6);
  assert(Number(replacement.rows[0].total_weight_lbs) <= 6000);
  assert.match(replacement.rows[0].memo, /3 PLT deferred/i);
  assert.deepEqual(new Set(Object.keys(replacement.rows[0].pallet_quantity_overrides)), new Set(["1", "15"]),
    "Destination PALLET overrides must be scaled into the replacement rather than silently discarded.");

  const lines = await query(
    `SELECT line.id, line.item_id, line.destination_location_id,
            line.proposed_pallets, line.sales_quantity,
            COALESCE(SUM(allocation.planned_pallets), 0) AS allocated_pallets,
            COALESCE(SUM(allocation.planned_sales_qty), 0) AS allocated_sales_qty,
            COUNT(allocation.id)::int AS allocation_count
       FROM scm_smart_proposal_lines line
       LEFT JOIN scm_smart_blanket_allocations allocation
         ON allocation.proposal_line_id = line.id
        AND allocation.proposal_id = line.proposal_id
      WHERE line.proposal_id = $1
      GROUP BY line.id
      ORDER BY line.item_id, line.destination_location_id`,
    [merged.mergedProposalId]
  );
  assert.equal(lines.rowCount, 2, "Duplicate item/destination lines must combine into one replacement line.");
  assert.equal(lines.rows.reduce((sum, row) => sum + Number(row.proposed_pallets), 0), 6);
  for (const line of lines.rows) {
    assert(Number.isInteger(Number(line.proposed_pallets)) && Number(line.proposed_pallets) > 0);
    assert.equal(Number(line.allocated_pallets), Number(line.proposed_pallets));
    assert.equal(Number(line.allocated_sales_qty), Number(line.sales_quantity));
    assert.equal(line.allocation_count, 1, "Same-source allocation fragments must consolidate without duplicate ledger keys.");
  }
  const oldAllocations = await query(
    "SELECT COUNT(*)::int AS count FROM scm_smart_blanket_allocations WHERE proposal_id = ANY($1::bigint[])",
    [[firstProposalId, secondProposalId]]
  );
  assert.equal(oldAllocations.rows[0].count, 0, "Superseded loads must not retain planned allocations that double-count the pool.");
  assert.deepEqual(await proposalStates([firstProposalId, secondProposalId]), [
    { id: firstProposalId, status: "superseded", mergedIntoProposalId: merged.mergedProposalId },
    { id: secondProposalId, status: "superseded", mergedIntoProposalId: merged.mergedProposalId }
  ]);
  assert.deepEqual(merged.workspace.proposals.map((proposal) => proposal.id), [merged.mergedProposalId],
    "Superseded lineage must stay out of the active Blanket load list.");

  const replay = await mergeSmartScmBlanketProposals([firstProposalId, secondProposalId], actor);
  assert.equal(replay.reused, true);
  assert.equal(replay.mergedProposalId, merged.mergedProposalId);
  const replacementCount = await query(
    `SELECT COUNT(*)::int AS count
       FROM scm_smart_proposals
      WHERE run_id = $1 AND proposal_key LIKE 'blanket-merge:%'`,
    [runId]
  );
  assert.equal(replacementCount.rows[0].count, 1, "A retry must recover, not duplicate, the merged load.");
  const audit = await query(
    `SELECT COUNT(*)::int AS count FROM delivery_audit_log
      WHERE action = 'smart_scm.blanket.proposals_merged'
        AND details @> $1::jsonb`,
    [JSON.stringify({ replacementProposalId: merged.mergedProposalId })]
  );
  assert.equal(audit.rows[0].count, 1, "An idempotent retry must not duplicate the merge audit event.");
});

test("mixed source POs, excessive drops, and reserved loads fail without partial mutation", async (t) => {
  await t.test("different planning runs", async () => {
    const firstRunId = await createRun();
    const secondRunId = await createRun();
    const source = await createSource();
    const proposalIds = [
      await createProposal({ runId: firstRunId, source, lines: [firstLine(1)] }),
      await createProposal({ runId: secondRunId, source, lines: [secondLine(1)] })
    ];
    await assert.rejects(
      () => mergeSmartScmBlanketProposals(proposalIds, actor),
      (error) => error?.status === 409 && /same current ready planning run/i.test(error.message)
    );
    assert((await proposalStates(proposalIds)).every((proposal) => proposal.status === "held"));
  });

  await t.test("different source Blanket POs", async () => {
    const runId = await createRun();
    const firstSource = await createSource();
    const secondSource = await createSource();
    const proposalIds = [
      await createProposal({ runId, source: firstSource, lines: [firstLine(1)] }),
      await createProposal({ runId, source: secondSource, lines: [firstLine(1)] })
    ];
    await assert.rejects(
      () => mergeSmartScmBlanketProposals(proposalIds, actor),
      (error) => error?.status === 409 && /same source Blanket PO/i.test(error.message)
    );
    assert((await proposalStates(proposalIds)).every((proposal) => proposal.status === "held" && proposal.mergedIntoProposalId === null));
  });

  await t.test("more destinations than the source route allows", async () => {
    const runId = await createRun();
    const source = await createSource();
    const proposalIds = [
      await createProposal({ runId, source, lines: [firstLine(1, 1, "3445")] }),
      await createProposal({ runId, source, lines: [firstLine(1, 15, "12441")] }),
      await createProposal({ runId, source, lines: [firstLine(1, 28, "2967")] })
    ];
    await assert.rejects(
      () => mergeSmartScmBlanketProposals(proposalIds, actor),
      (error) => error?.status === 409 && /at most 2 destinations/i.test(error.message)
    );
    assert((await proposalStates(proposalIds)).every((proposal) => proposal.status === "held"));
  });

  await t.test("a load with an existing reservation", async () => {
    const runId = await createRun();
    const source = await createSource();
    const firstProposalId = await createProposal({ runId, source, lines: [firstLine(1)] });
    const secondProposalId = await createProposal({ runId, source, lines: [secondLine(1)] });
    const release = await query(
      `INSERT INTO scm_smart_blanket_releases (
         proposal_id, run_id, source_po_id, source_po_ref,
         idempotency_key, status, reserved_by
       ) VALUES ($1,$2,$3,$4,$5,'reserved',$6)
       RETURNING id`,
      [firstProposalId, runId, source.sourcePoId, source.sourcePoRef,
        `${actor}:reserved:${firstProposalId}`, actor]
    );
    await query(
      `UPDATE scm_smart_blanket_allocations
          SET release_id = $2, status = 'reserved',
              reserved_pallets = planned_pallets,
              reserved_sales_qty = planned_sales_qty,
              updated_at = now()
        WHERE proposal_id = $1`,
      [firstProposalId, release.rows[0].id]
    );
    await assert.rejects(
      () => mergeSmartScmBlanketProposals([firstProposalId, secondProposalId], actor),
      (error) => error?.status === 409 && /reserved/i.test(error.message)
    );
    assert((await proposalStates([firstProposalId, secondProposalId])).every((proposal) => proposal.status === "held"));
    const reservation = await query(
      "SELECT status, reserved_pallets FROM scm_smart_blanket_allocations WHERE proposal_id = $1",
      [firstProposalId]
    );
    assert.equal(reservation.rows[0].status, "reserved");
    assert.equal(Number(reservation.rows[0].reserved_pallets), 1);
  });
});

test("concurrent identical merge requests converge on one replacement", async () => {
  const runId = await createRun(20_000);
  const source = await createSource();
  const proposalIds = [
    await createProposal({ runId, source, lines: [firstLine(2)] }),
    await createProposal({ runId, source, lines: [secondLine(2)] })
  ];
  const outcomes = await Promise.all([
    mergeSmartScmBlanketProposals(proposalIds, actor),
    mergeSmartScmBlanketProposals([...proposalIds].reverse(), actor)
  ]);
  assert.equal(outcomes[0].mergedProposalId, outcomes[1].mergedProposalId);
  assert.deepEqual(outcomes.map((outcome) => outcome.reused).sort(), [false, true]);
  const replacements = await query(
    `SELECT COUNT(*)::int AS count
       FROM scm_smart_proposals
      WHERE run_id = $1 AND proposal_key LIKE 'blanket-merge:%'`,
    [runId]
  );
  assert.equal(replacements.rows[0].count, 1);
});

test("merge selection is bounded and duplicate ids do not satisfy the minimum", async () => {
  await assert.rejects(
    () => mergeSmartScmBlanketProposals([1, 1], actor),
    (error) => error?.status === 400 && /at least two/i.test(error.message)
  );
  await assert.rejects(
    () => mergeSmartScmBlanketProposals(Array.from({ length: 21 }, (_, index) => index + 1), actor),
    (error) => error?.status === 400 && /no more than 20/i.test(error.message)
  );
});
