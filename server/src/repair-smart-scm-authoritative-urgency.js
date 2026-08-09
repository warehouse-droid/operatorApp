import assert from "node:assert/strict";
import { closeDb, query } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import { loadSmartScmPlanningDemandStates } from "./smart-scm-planning-repository.js";
import { reevaluateSmartScmProposalUrgency } from "./smart-scm-proposal-editor.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const runArgument = args.find((argument) => argument.startsWith("--run="));
const requestedRunId = runArgument ? Number(runArgument.slice("--run=".length)) : null;

async function selectedRunId() {
  if (Number.isSafeInteger(requestedRunId) && requestedRunId > 0) return requestedRunId;
  const result = await query(
    `SELECT id FROM scm_smart_planning_runs
      WHERE status = 'ready'
      ORDER BY id DESC LIMIT 1`
  );
  const id = Number(result.rows[0]?.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("No ready Smart SCM planning run was found.");
  return id;
}

async function proposalSnapshots(runId) {
  const result = await query(
    `SELECT proposal.id,
            proposal.status,
            proposal.urgent,
            proposal.urgency_level,
            proposal.urgency_score,
            proposal.netsuite_transfer_order_id,
            proposal.netsuite_transfer_order_ref,
            proposal.netsuite_purchase_order_id,
            proposal.netsuite_purchase_order_ref,
            proposal.total_pallets,
            proposal.total_weight_lbs,
            COALESCE(jsonb_agg(jsonb_build_object(
              'id', line.id,
              'itemId', line.item_id,
              'itemName', line.item_name,
              'destinationLocationId', line.destination_location_id,
              'proposedPallets', line.proposed_pallets,
              'confirmedPallets', line.confirmed_pallets,
              'residualPallets', line.residual_pallets,
              'salesQuantity', line.sales_quantity,
              'lineWeightLbs', line.line_weight_lbs,
              'urgent', line.urgent,
              'urgencyLevel', line.urgency_level,
              'urgencyScore', line.urgency_score
            ) ORDER BY line.id) FILTER (WHERE line.id IS NOT NULL), '[]'::jsonb) AS lines
       FROM scm_smart_proposals proposal
       LEFT JOIN scm_smart_proposal_lines line ON line.proposal_id = proposal.id
      WHERE proposal.run_id = $1
        AND COALESCE(proposal.proposal_origin, 'inventory') <> 'blanket'
        AND proposal.status NOT IN ('cancelled', 'superseded')
      GROUP BY proposal.id
      ORDER BY proposal.id`,
    [runId]
  );
  return result.rows;
}

function immutableSnapshot(row) {
  return {
    id: Number(row.id),
    status: row.status,
    netsuiteTransferOrderId: row.netsuite_transfer_order_id,
    netsuiteTransferOrderRef: row.netsuite_transfer_order_ref,
    netsuitePurchaseOrderId: row.netsuite_purchase_order_id,
    netsuitePurchaseOrderRef: row.netsuite_purchase_order_ref,
    totalPallets: row.total_pallets,
    totalWeightLbs: row.total_weight_lbs,
    lines: (row.lines || []).map((line) => ({
      id: line.id,
      proposedPallets: line.proposedPallets,
      confirmedPallets: line.confirmedPallets,
      residualPallets: line.residualPallets,
      salesQuantity: line.salesQuantity,
      lineWeightLbs: line.lineWeightLbs
    }))
  };
}

function urgencySnapshot(row) {
  return {
    urgent: row.urgent,
    urgencyLevel: row.urgency_level,
    urgencyScore: row.urgency_score,
    lines: (row.lines || []).map((line) => ({
      id: line.id,
      urgent: line.urgent,
      urgencyLevel: line.urgencyLevel,
      urgencyScore: line.urgencyScore
    }))
  };
}

async function proposalPolicyPreflight(proposals = []) {
  const planning = await loadSmartScmPlanningDemandStates({ includeTemporarilyExcluded: true });
  const stateKeys = new Set(planning.states.map((state) => state.key));
  const eligible = [];
  const skipped = [];
  for (const proposal of proposals) {
    const missingLines = (proposal.lines || []).filter((line) =>
      !stateKeys.has(`${Number(line.itemId)}:${Number(line.destinationLocationId)}`));
    if (!missingLines.length) {
      eligible.push(proposal);
      continue;
    }
    skipped.push({
      proposalId: Number(proposal.id),
      status: proposal.status,
      reason: "current_policy_state_missing",
      lines: missingLines.map((line) => ({
        lineId: Number(line.id),
        itemId: Number(line.itemId),
        itemName: line.itemName,
        destinationLocationId: Number(line.destinationLocationId)
      }))
    });
  }
  return { eligible, skipped };
}

try {
  const runId = await selectedRunId();
  const before = await proposalSnapshots(runId);
  if (!before.length) throw new Error(`Smart SCM run ${runId} has no inventory proposals to re-evaluate.`);
  const preflight = await proposalPolicyPreflight(before);
  if (!apply) {
    console.log(JSON.stringify({
      applied: false,
      runId,
      proposals: before.length,
      lines: before.reduce((sum, proposal) => sum + proposal.lines.length, 0),
      eligibleProposals: preflight.eligible.length,
      skippedProposals: preflight.skipped,
      statuses: Object.fromEntries([...new Set(before.map((proposal) => proposal.status))]
        .sort()
        .map((status) => [status, before.filter((proposal) => proposal.status === status).length])),
      linkedTransferOrders: before
        .filter((proposal) => proposal.netsuite_transfer_order_id)
        .map((proposal) => ({
          proposalId: Number(proposal.id),
          transferOrderId: Number(proposal.netsuite_transfer_order_id),
          transferOrderRef: proposal.netsuite_transfer_order_ref
        }))
    }, null, 2));
  } else {
    for (const proposal of preflight.eligible) {
      await reevaluateSmartScmProposalUrgency(Number(proposal.id), null);
    }
    const after = await proposalSnapshots(runId);
    assert.equal(after.length, before.length, "Urgency repair changed the proposal count.");
    const beforeById = new Map(before.map((proposal) => [Number(proposal.id), proposal]));
    let changedProposals = 0;
    let changedLines = 0;
    for (const proposal of after) {
      const previous = beforeById.get(Number(proposal.id));
      assert(previous, `Proposal ${proposal.id} disappeared during urgency repair.`);
      assert.deepEqual(
        immutableSnapshot(proposal),
        immutableSnapshot(previous),
        `Urgency repair changed operational fields on proposal ${proposal.id}.`
      );
      const beforeUrgency = urgencySnapshot(previous);
      const afterUrgency = urgencySnapshot(proposal);
      if (JSON.stringify(beforeUrgency) !== JSON.stringify(afterUrgency)) changedProposals += 1;
      const priorLines = new Map(beforeUrgency.lines.map((line) => [Number(line.id), line]));
      changedLines += afterUrgency.lines.filter((line) =>
        JSON.stringify(line) !== JSON.stringify(priorLines.get(Number(line.id)))).length;
    }
    const result = {
      applied: true,
      runId,
      proposalsEvaluated: preflight.eligible.length,
      linesEvaluated: preflight.eligible.reduce((sum, proposal) => sum + proposal.lines.length, 0),
      skippedProposals: preflight.skipped,
      changedProposals,
      changedLines,
      operationalFieldsPreserved: true,
      linkedTransferOrdersPreserved: after
        .filter((proposal) => proposal.netsuite_transfer_order_id)
        .map((proposal) => ({
          proposalId: Number(proposal.id),
          transferOrderId: Number(proposal.netsuite_transfer_order_id),
          transferOrderRef: proposal.netsuite_transfer_order_ref
        }))
    };
    await writeAudit({
      actorType: "system",
      source: "repair",
      action: "smart_scm.authoritative_urgency.batch_repaired",
      details: result
    });
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
} finally {
  await closeDb();
}
