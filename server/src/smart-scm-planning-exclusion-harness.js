import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { closeDb, query, withTransaction } from "./db.js";
import {
  addSmartScmPlanningExclusion,
  deactivateSmartScmPlanningExclusion,
  listSmartScmActivePlanningExclusionItemIds,
  listSmartScmPlanningExclusions,
  normalizeSmartScmPlanningExclusionExpiry
} from "./smart-scm-planning-exclusion-repository.js";
import {
  loadSmartScmPlanningPolicies,
  smartScmBuildPlanningDrafts
} from "./smart-scm-planning-repository.js";
import {
  addSmartScmProposalLine,
  createSmartScmManualLoad,
  searchSmartScmManualLoadItems,
  searchSmartScmProposalItems
} from "./smart-scm-proposal-editor.js";

const migrationSource = await fs.readFile(
  new URL("../migrations/096_smart_scm_planning_exclusions.sql", import.meta.url),
  "utf8"
);
const blanketWorkflowMigrationSource = await fs.readFile(
  new URL("../migrations/097_smart_scm_blanket_orders.sql", import.meta.url),
  "utf8"
);

assert.match(migrationSource, /REFERENCES\s+inventory_items\s*\(item_id\)/i);
assert.match(migrationSource, /WHERE\s+deactivated_at\s+IS\s+NULL/i);
assert.equal(
  normalizeSmartScmPlanningExclusionExpiry("2030-07-01"),
  "2030-07-02T04:00:00.000Z",
  "A date-only expiry must remain active through the selected Toronto business date."
);
assert.equal(
  normalizeSmartScmPlanningExclusionExpiry("2030-12-01"),
  "2030-12-02T05:00:00.000Z",
  "Date-only expiry must account for Toronto daylight-saving offsets."
);

try {
  await withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext('smart-scm-planning-exclusion-harness'))");
    await query(migrationSource);
    await query(blanketWorkflowMigrationSource);

    const idResult = await query(
      "SELECT GREATEST(COALESCE(MAX(item_id), 0), 9600000) + 1 AS item_id FROM inventory_items"
    );
    const itemId = Number(idResult.rows[0].item_id);
    const itemName = `HARNESS TEMP EXCLUSION ${itemId}`;
    const baselineActiveIds = await listSmartScmActivePlanningExclusionItemIds();
    await query(
      `INSERT INTO inventory_items (
         item_id, item_name, display_name, item_description, stock_unit,
         to_plt, to_lyr, to_sec, to_pcs, item_weight, vendor_id, vendor
       ) VALUES ($1, $2, $2, 'Temporary planning exclusion fixture', 'EA', 100, 10, 5, 1, 5, $3, 'Harness Vendor')`,
      [itemId, itemName, itemId + 100000]
    );
    await query(
      `INSERT INTO scm_smart_item_policies (
         item_id, item_name, item_description, vendor, vendor_code, stock_unit,
         to_plt, to_lyr, to_sec, to_pcs, lead_time_days, pallet_weight_lbs,
         inactive, discontinued, planning_enabled, updated_by
       ) VALUES ($1, $2, 'Temporary planning exclusion fixture', 'Harness Vendor', $3,
                 'EA', 100, 10, 5, 1, 14, 500, false, false, true, 'harness:fixture')`,
      [itemId, itemName, String(itemId + 100000)]
    );
    await query(
      `INSERT INTO scm_smart_item_yard_policies (
         item_id, location_id, yard_code, eligible, capacity_pallets,
         service_quantile, minimum_safety_pallets, updated_by
       ) VALUES
         ($1, 1, '3445', true, 25, 0.90, 1, 'harness:fixture'),
         ($1, 28, '2967', true, 25, 0.90, 1, 'harness:fixture')`,
      [itemId]
    );
    const runResult = await query(
      `INSERT INTO scm_smart_planning_runs (status, trigger_source, settings_snapshot, totals, completed_at)
       VALUES ('ready', 'manual', '{}'::jsonb, '{}'::jsonb, now()) RETURNING id`
    );
    const runId = Number(runResult.rows[0].id);
    const proposalResult = await query(
      `INSERT INTO scm_smart_proposals (
         run_id, proposal_key, proposal_type, phase, source_kind, source_location_id,
         source_name, destination_location_id, destination_name, status
       ) VALUES ($1, $2, 'TO', 'internal_transfer', 'yard', 28, '2967', 1, '3445', 'draft')
       RETURNING id`,
      [runId, `harness-temp-exclusion:${itemId}`]
    );
    const proposalId = Number(proposalResult.rows[0].id);
    const poProposalResult = await query(
      `INSERT INTO scm_smart_proposals (
         run_id, proposal_key, proposal_type, phase, source_kind,
         source_name, destination_location_id, destination_name, vendor, status
       ) VALUES ($1, $2, 'PO', 'direct_vendor', 'vendor',
                 'Harness Vendor', 1, '3445', 'Harness Vendor', 'draft')
       RETURNING id`,
      [runId, `harness-temp-exclusion-po:${itemId}`]
    );
    const poProposalId = Number(poProposalResult.rows[0].id);
    await query(
      `INSERT INTO scm_smart_proposal_lines (
         proposal_id, item_id, item_name, item_description, unit,
         required_pallets, proposed_pallets, confirmed_pallets, residual_pallets,
         sales_quantity, pallet_weight_lbs, line_weight_lbs,
         to_plt, to_lyr, to_sec, to_pcs, manual_planning_required, reason,
         destination_location_id, destination_name
       ) VALUES ($1, $2, $3, 'Temporary planning exclusion fixture', 'EA',
                 1, 1, 0, 1, 100, 500, 500,
                 100, 10, 5, 1, false, '{"harness":true}'::jsonb,
                 1, '3445')`,
      [poProposalId, itemId, itemName]
    );

    assert.ok(
      (await loadSmartScmPlanningPolicies()).some((policy) => Number(policy.item_id) === itemId),
      "A permanently enabled fixture must initially be eligible for generated PO/TO plans."
    );
    assert.ok(
      (await searchSmartScmManualLoadItems({
        proposalType: "TO", sourceLocationId: 28, destinationLocationId: 1, search: itemName
      })).some((item) => item.itemId === itemId),
      "A permanently enabled fixture must initially appear in manual-load search."
    );
    assert.ok(
      (await searchSmartScmManualLoadItems({
        proposalType: "PO", destinationLocationId: 1, search: itemName
      })).some((item) => item.itemId === itemId),
      "The fixture must initially appear in PO manual-load search so a later pause assertion is meaningful."
    );
    assert.ok(
      (await searchSmartScmProposalItems(poProposalId, { search: itemName }))
        .some((item) => item.itemId === itemId),
      "The fixture must initially appear in a compatible PO add-line search."
    );

    await assert.rejects(
      addSmartScmPlanningExclusion({ itemId, reason: "" }),
      (error) => error.status === 400 && /Reason is required/.test(error.message)
    );
    await assert.rejects(
      addSmartScmPlanningExclusion({ itemId, reason: "Vendor out of stock", expiresAt: "2020-01-01T00:00:00Z" }),
      (error) => error.status === 400 && /future/.test(error.message)
    );

    const first = await addSmartScmPlanningExclusion({
      itemId,
      reason: "Vendor confirms temporary stockout",
      expiresAt: new Date(Date.now() + 86400000).toISOString()
    });
    assert.equal(first.itemId, itemId);
    assert.equal(first.active, true);
    assert.match(first.expiresOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal((await listSmartScmPlanningExclusions({ search: itemName })).activeCount, 1);
    assert.deepEqual(
      await listSmartScmActivePlanningExclusionItemIds(),
      [...baselineActiveIds, itemId].sort((left, right) => left - right)
    );
    assert.ok(
      !(await loadSmartScmPlanningPolicies()).some((policy) => Number(policy.item_id) === itemId),
      "The default purchase-planning policy query must omit an active temporary PO pause."
    );
    const pausedPolicies = (await loadSmartScmPlanningPolicies({ includeTemporarilyExcluded: true }))
      .filter((policy) => Number(policy.item_id) === itemId);
    assert.ok(
      pausedPolicies.length > 0 && pausedPolicies.every((policy) => policy.temporarily_excluded === true),
      "A saved-run execution check must retain the policy snapshot path for an item paused after planning."
    );
    const automaticStateBase = {
      requiredPallets: 0,
      toPlt: 100,
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
        item_name: itemName,
        item_description: "Temporary planning exclusion fixture",
        stock_unit: "EA",
        to_plt: 100,
        to_lyr: 10,
        to_sec: 5,
        to_pcs: 1,
        pallet_weight_lbs: 500,
        physical_pallet_weight_lbs: 0,
        vendor: "Harness Vendor",
        plant: "Harness Vendor"
      }
    };
    const automaticDrafts = smartScmBuildPlanningDrafts({
      states: [
        {
          ...automaticStateBase,
          key: `${itemId}:1`,
          requiredPallets: 2,
          policy: {
            ...automaticStateBase.policy,
            location_id: 1,
            yard_code: "3445",
            temporarily_excluded: true
          }
        },
        {
          ...automaticStateBase,
          key: `${itemId}:28`,
          availablePallets: 6,
          policy: { ...automaticStateBase.policy, location_id: 28, yard_code: "2967" }
        }
      ],
      supplyMap: new Map(),
      settings: { truck_capacity_lbs: 78000, hold_load_ratio: 0.5, vendor_response_sla_hours: 24 }
    });
    assert.equal(
      automaticDrafts.drafts.some((draft) => draft.proposalType === "PO"),
      false,
      "A temporary pause must suppress automatic vendor PO drafts for the item."
    );
    assert.ok(
      automaticDrafts.drafts.some((draft) => draft.proposalType === "TO"
        && draft.lines.some((line) => line.itemId === itemId)),
      "A temporary PO pause must still allow a safe automatic internal TO for the item."
    );
    assert.equal(
      (await searchSmartScmManualLoadItems({
        proposalType: "TO", sourceLocationId: 28, destinationLocationId: 1, search: itemName
      })).some((item) => item.itemId === itemId),
      true,
      "A PO-paused item must remain available in manual TO load search."
    );
    assert.equal(
      (await searchSmartScmProposalItems(proposalId, { search: itemName })).some((item) => item.itemId === itemId),
      true,
      "A PO-paused item must remain available in existing TO add-line search."
    );
    assert.equal(
      (await searchSmartScmManualLoadItems({
        proposalType: "PO", destinationLocationId: 1, search: itemName
      })).some((item) => item.itemId === itemId),
      false,
      "A paused item must remain hidden from manual PO load search."
    );
    assert.equal(
      (await searchSmartScmProposalItems(poProposalId, { search: itemName }))
        .some((item) => item.itemId === itemId),
      false,
      "A paused item must remain hidden from existing PO add-line search."
    );
    const manualToRun = await createSmartScmManualLoad(runId, {
      proposalType: "TO", itemId, proposedPallets: 1, sourceLocationId: 28, destinationLocationId: 1
    });
    assert.ok(
      manualToRun.proposals.some((proposal) => proposal.proposalType === "TO"
        && proposal.lines.some((line) => line.itemId === itemId
          && line.reason?.manualLoad === true
          && line.reason?.manualSourceFloorOverride === true)),
      "A paused item must be accepted in a newly created manual TO load."
    );
    const updatedToProposal = await addSmartScmProposalLine(proposalId, { itemId, proposedPallets: 1 });
    assert.ok(
      updatedToProposal.lines.some((line) => line.itemId === itemId && line.reason?.manuallyAdded === true),
      "A paused item must be accepted when manually added to an existing TO load."
    );
    await assert.rejects(
      createSmartScmManualLoad(runId, {
        proposalType: "PO", itemId, proposedPallets: 1, destinationLocationId: 1
      }),
      (error) => error.status === 409 && /not enabled for planning/.test(error.message),
      "A stale PO manual-load result must not bypass an active PO pause."
    );
    await assert.rejects(
      addSmartScmProposalLine(poProposalId, { itemId, proposedPallets: 1 }),
      (error) => error.status === 409 && /not enabled for planning/.test(error.message),
      "A stale PO add-line request must not bypass an active PO pause."
    );

    await query(
      "UPDATE scm_smart_planning_exclusions SET expires_at = now() - interval '1 second' WHERE id = $1",
      [first.id]
    );
    assert.equal((await listSmartScmPlanningExclusions({ search: itemName })).activeCount, 0);
    assert.deepEqual(await listSmartScmActivePlanningExclusionItemIds(), baselineActiveIds);
    assert.ok(
      (await loadSmartScmPlanningPolicies()).some((policy) => Number(policy.item_id) === itemId),
      "An expired exclusion must automatically restore eligibility for future generated plans."
    );
    assert.ok(
      (await searchSmartScmManualLoadItems({
        proposalType: "PO", destinationLocationId: 1, search: itemName
      })).some((item) => item.itemId === itemId),
      "An expired exclusion must restore manual PO-load search eligibility."
    );
    const expiredHistory = await listSmartScmPlanningExclusions({ includeInactive: true, search: itemName });
    assert.equal(expiredHistory.total, 1);
    assert.equal(expiredHistory.items[0].active, false);

    const replacement = await addSmartScmPlanningExclusion({ itemId, reason: "Vendor extended stockout" });
    const replacementHistory = await listSmartScmPlanningExclusions({ includeInactive: true, search: itemName });
    assert.equal(replacementHistory.total, 2, "Replacing an exclusion must preserve its prior history.");
    assert.equal(replacementHistory.activeCount, 1);
    const removed = await deactivateSmartScmPlanningExclusion(replacement.id, { note: "Vendor stock restored" });
    assert.equal(removed.active, false);
    assert.equal(removed.deactivationNote, "Vendor stock restored");
    assert.equal((await listSmartScmPlanningExclusions({ search: itemName })).activeCount, 0);

    const policyState = await query(
      "SELECT planning_enabled FROM scm_smart_item_policies WHERE item_id = $1",
      [itemId]
    );
    assert.equal(policyState.rows[0].planning_enabled, true, "Temporary exclusions must never change planning_enabled.");
  }, { rollback: true });

  console.log("Smart SCM planning exclusion harness passed.");
} finally {
  await closeDb();
}
