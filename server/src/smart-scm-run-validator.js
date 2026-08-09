import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, query } from "./db.js";
import { calculateSmartScmOrderRequirement } from "./smart-scm-policy-calculation.js";
import {
  listSmartScmProposals,
  loadSmartScmPlanningDemandStates
} from "./smart-scm-planning-repository.js";

const EPSILON = 0.000001;
const INACTIVE_PROPOSAL_STATUSES = new Set(["cancelled", "superseded"]);

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, places = 6) {
  const factor = 10 ** places;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
}

function stateIdentity(state) {
  return {
    key: `${Number(state.policy?.item_id)}:${String(state.policy?.yard_code || "")}`,
    itemId: Number(state.policy?.item_id),
    itemName: state.policy?.item_name || "",
    yard: String(state.policy?.yard_code || ""),
    locationId: Number(state.policy?.location_id)
  };
}

function lineActualYard(line) {
  return String(line?.reason?.actualDestinationYard || line?.destinationName || "").trim();
}

function lineCoverageAllocations(line = {}) {
  const saved = Array.isArray(line.reason?.destinationAllocations)
    ? line.reason.destinationAllocations
    : [];
  if (!saved.length) {
    return [{
      yard: lineActualYard(line),
      proposedPallets: number(line.proposedPallets),
      explicit: false
    }];
  }
  return saved.map((allocation) => ({
    yard: String(allocation?.yard || "").trim(),
    proposedPallets: number(allocation?.proposedPallets),
    explicit: true
  }));
}

export function validateSmartScmPlanningRunSnapshot({ states = [], proposals = [] } = {}) {
  const failures = [];
  const warnings = [];
  const addFailure = (code, details) => failures.push({ code, ...details });
  const addWarning = (code, details) => warnings.push({ code, ...details });
  const stateByItemYard = new Map();
  const coverageByItemYard = new Map();
  const skuTotals = new Map();
  let proposalLineCount = 0;

  for (const state of states) {
    const identity = stateIdentity(state);
    stateByItemYard.set(identity.key, state);
    const sku = skuTotals.get(identity.itemId) || {
      itemId: identity.itemId,
      itemName: identity.itemName,
      requiredPallets: 0,
      proposedPallets: 0
    };
    sku.requiredPallets += number(state.requiredPallets);
    skuTotals.set(identity.itemId, sku);
  }

  const activeProposals = proposals.filter((proposal) => !INACTIVE_PROPOSAL_STATUSES.has(String(proposal.status)));
  for (const proposal of activeProposals) {
    for (const line of proposal.lines || []) {
      proposalLineCount += 1;
      const itemId = Number(line.itemId);
      const lineProposedPallets = number(line.proposedPallets);
      const allocations = lineCoverageAllocations(line);
      if (allocations.some((allocation) => allocation.explicit)) {
        const allocationTotal = allocations.reduce((sum, allocation) => sum + allocation.proposedPallets, 0);
        if (Math.abs(allocationTotal - lineProposedPallets) > EPSILON) {
          addFailure("destination_allocation_total_mismatch", {
            proposalId: Number(proposal.id),
            lineId: line.id,
            itemId,
            itemName: line.itemName || "",
            lineProposedPallets,
            allocationTotal: round(allocationTotal)
          });
        }
      }
      for (const allocation of allocations) {
        const yard = allocation.yard;
        const proposedPallets = allocation.proposedPallets;
        if (!yard || proposedPallets <= EPSILON) {
          addFailure("invalid_destination_allocation", {
            proposalId: Number(proposal.id),
            lineId: line.id,
            itemId,
            itemName: line.itemName || "",
            yard,
            proposedPallets
          });
          continue;
        }
        const key = `${itemId}:${yard}`;
        const state = stateByItemYard.get(key);
        if (!state) {
          addFailure("proposal_line_missing_policy_state", {
            proposalId: Number(proposal.id),
            lineId: line.id,
            itemId,
            itemName: line.itemName || "",
            yard,
            proposedPallets
          });
          continue;
        }
        if (proposal.phase === "vendor_hub" && yard === "12441") {
          addFailure("self_hub_vendor_po", {
            proposalId: Number(proposal.id),
            lineId: line.id,
            itemId,
            itemName: line.itemName || "",
            yard,
            proposedPallets
          });
        }
        if (number(state.availablePallets) <= EPSILON
          && number(state.requiredPallets) > EPSILON
          && !line.urgent) {
          addFailure("zero_available_line_not_urgent", {
            proposalId: Number(proposal.id),
            lineId: line.id,
            itemId,
            itemName: line.itemName || "",
            yard,
            proposedPallets
          });
        }
        const coverage = coverageByItemYard.get(key) || {
          itemId,
          itemName: line.itemName || state.policy?.item_name || "",
          yard,
          proposedPallets: 0,
          phases: {}
        };
        coverage.proposedPallets += proposedPallets;
        coverage.phases[proposal.phase] = number(coverage.phases[proposal.phase]) + proposedPallets;
        coverageByItemYard.set(key, coverage);
        const sku = skuTotals.get(itemId);
        if (sku) sku.proposedPallets += proposedPallets;
      }
    }
  }

  const coverageRows = [];
  let shortageStateCount = 0;
  let underRopCount = 0;
  let zeroAvailableShortageCount = 0;
  let zeroAvailableNotUrgentCount = 0;
  let coverageAboveRequiredCount = 0;
  let coverageBelowRequiredCount = 0;
  let finalPositionFarAbovePslCount = 0;
  let ropAbovePslCount = 0;
  let maximumFinalAbovePslPallets = 0;

  for (const state of states) {
    const identity = stateIdentity(state);
    const positionPallets = number(state.positionPallets);
    const rop = number(state.rop);
    const preferred = number(state.preferred);
    const capacity = number(state.capacity);
    const minimumOrder = number(state.minimumOrder, 1);
    const requiredPallets = number(state.requiredPallets);
    const availablePallets = number(state.availablePallets);
    const expected = calculateSmartScmOrderRequirement({
      positionPallets,
      reorderPointPallets: rop,
      preferredPallets: preferred,
      capacityPallets: capacity,
      minimumOrderPallets: minimumOrder
    });
    const coverage = coverageByItemYard.get(identity.key) || {
      proposedPallets: 0,
      phases: {}
    };
    const proposedPallets = number(coverage.proposedPallets);
    const policyFinalPosition = positionPallets + requiredPallets;
    const proposalFinalPosition = positionPallets + proposedPallets;
    const finalAbovePsl = Math.max(0, proposalFinalPosition - preferred);
    if (proposedPallets > EPSILON) {
      maximumFinalAbovePslPallets = Math.max(maximumFinalAbovePslPallets, finalAbovePsl);
    }
    if (positionPallets < rop - EPSILON) underRopCount += 1;
    if (requiredPallets > EPSILON) shortageStateCount += 1;
    if (rop > preferred + EPSILON) ropAbovePslCount += 1;
    if (Math.abs(requiredPallets - expected.requiredPallets) > EPSILON) {
      addFailure("required_quantity_mismatch", {
        ...identity,
        positionPallets,
        rop,
        preferred,
        capacity,
        minimumOrder,
        requiredPallets,
        expectedRequiredPallets: expected.requiredPallets
      });
    }
    if (positionPallets < rop - EPSILON
      && !expected.capacityBelowMinimum
      && expected.requiredPallets <= EPSILON) {
      addFailure("under_rop_without_required_quantity", {
        ...identity,
        positionPallets,
        rop,
        preferred,
        capacity,
        minimumOrder
      });
    }
    if (availablePallets <= EPSILON && requiredPallets > EPSILON) {
      zeroAvailableShortageCount += 1;
      if (!state.urgent) {
        zeroAvailableNotUrgentCount += 1;
        addFailure("zero_available_not_urgent", {
          ...identity,
          availablePallets,
          positionPallets,
          rop,
          preferred,
          requiredPallets
        });
      }
    }
    if (proposedPallets > requiredPallets + EPSILON) {
      coverageAboveRequiredCount += 1;
      addFailure("coverage_exceeds_required", {
        ...identity,
        requiredPallets,
        proposedPallets: round(proposedPallets),
        excessPallets: round(proposedPallets - requiredPallets),
        phases: coverage.phases
      });
    } else if (requiredPallets > proposedPallets + EPSILON) {
      coverageBelowRequiredCount += 1;
      addWarning("coverage_below_required", {
        ...identity,
        requiredPallets,
        proposedPallets: round(proposedPallets),
        uncoveredPallets: round(requiredPallets - proposedPallets),
        temporarilyExcluded: state.policy?.temporarily_excluded === true,
        blanketPlanningExcluded: state.policy?.blanket_po_planning_excluded === true,
        phases: coverage.phases
      });
    }
    const allowedPslOvershoot = Math.max(1, minimumOrder);
    if (proposedPallets > EPSILON
      && proposalFinalPosition > preferred + allowedPslOvershoot + EPSILON) {
      finalPositionFarAbovePslCount += 1;
      addFailure("final_position_far_above_psl", {
        ...identity,
        positionPallets,
        preferred,
        requiredPallets,
        proposedPallets: round(proposedPallets),
        proposalFinalPosition: round(proposalFinalPosition),
        abovePslPallets: round(proposalFinalPosition - preferred),
        allowedPslOvershoot
      });
    }
    if (requiredPallets > EPSILON
      && policyFinalPosition < preferred - 1 - EPSILON
      && !expected.capacityBelowMinimum) {
      addFailure("required_quantity_finishes_below_psl", {
        ...identity,
        positionPallets,
        preferred,
        requiredPallets,
        policyFinalPosition: round(policyFinalPosition)
      });
    }
    coverageRows.push({
      ...identity,
      availablePallets: round(availablePallets),
      positionPallets: round(positionPallets),
      rop: round(rop),
      preferred: round(preferred),
      capacity: round(capacity),
      minimumOrder: round(minimumOrder),
      requiredPallets: round(requiredPallets),
      proposedPallets: round(proposedPallets),
      policyFinalPosition: round(policyFinalPosition),
      proposalFinalPosition: round(proposalFinalPosition),
      urgent: Boolean(state.urgent),
      phases: coverage.phases
    });
  }

  let skuCoverageAboveRequiredCount = 0;
  for (const sku of skuTotals.values()) {
    if (sku.proposedPallets > sku.requiredPallets + EPSILON) {
      skuCoverageAboveRequiredCount += 1;
      addFailure("sku_coverage_exceeds_required", {
        itemId: sku.itemId,
        itemName: sku.itemName,
        requiredPallets: round(sku.requiredPallets),
        proposedPallets: round(sku.proposedPallets),
        excessPallets: round(sku.proposedPallets - sku.requiredPallets)
      });
    }
  }

  const summary = {
    stateCount: states.length,
    skuCount: new Set(states.map((state) => Number(state.policy?.item_id))).size,
    yardCount: new Set(states.map((state) => String(state.policy?.yard_code || ""))).size,
    underRopCount,
    shortageStateCount,
    proposalCount: activeProposals.length,
    proposalLineCount,
    totalRequiredPallets: round(states.reduce((sum, state) => sum + number(state.requiredPallets), 0)),
    totalProposedPallets: round([...coverageByItemYard.values()].reduce((sum, row) => sum + number(row.proposedPallets), 0)),
    zeroAvailableShortageCount,
    zeroAvailableNotUrgentCount,
    coverageAboveRequiredCount,
    coverageBelowRequiredCount,
    skuCoverageAboveRequiredCount,
    finalPositionFarAbovePslCount,
    maximumFinalAbovePslPallets: round(maximumFinalAbovePslPallets),
    ropAbovePslCount,
    failureCount: failures.length,
    warningCount: warnings.length
  };
  return {
    passed: failures.length === 0,
    summary,
    failures,
    warnings,
    coverageRows
  };
}

export async function validateSmartScmPlanningRun(runId) {
  const id = Number(runId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Provide a valid Smart SCM planning run ID.");
  const runResult = await query(
    `SELECT id, status, forecast_run_id, plan_kind, started_at, completed_at
       FROM scm_smart_planning_runs WHERE id = $1`,
    [id]
  );
  if (!runResult.rowCount) throw new Error(`Smart SCM planning run ${id} was not found.`);
  const run = runResult.rows[0];
  if (run.plan_kind !== "inventory") throw new Error(`Planning run ${id} is not an inventory plan.`);
  const [planning, proposals] = await Promise.all([
    loadSmartScmPlanningDemandStates({
      forecastRunId: Number(run.forecast_run_id),
      includeTemporarilyExcluded: true
    }),
    listSmartScmProposals({ runId: id, limit: 2000 })
  ]);
  const validation = validateSmartScmPlanningRunSnapshot({ states: planning.states, proposals });
  return {
    run: {
      id,
      status: run.status,
      forecastRunId: Number(run.forecast_run_id),
      startedAt: run.started_at,
      completedAt: run.completed_at
    },
    ...validation
  };
}

function cliRunId(argv) {
  const explicit = argv.find((argument) => argument.startsWith("--run-id="));
  return Number(explicit ? explicit.slice("--run-id=".length) : argv.find((argument) => /^\d+$/.test(argument)));
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  try {
    const validation = await validateSmartScmPlanningRun(cliRunId(process.argv.slice(2)));
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(validation, null, 2));
    } else {
      console.log(JSON.stringify({
        run: validation.run,
        passed: validation.passed,
        summary: validation.summary,
        failures: validation.failures.slice(0, 100),
        warnings: validation.warnings.slice(0, 100)
      }, null, 2));
    }
    if (!validation.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
