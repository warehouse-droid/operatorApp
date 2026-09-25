// Mutate only disposable Node processes; never edit the shared worktree.
import { readFile } from "node:fs/promises";

export const mutants = {
  packedStatus: ["dispatch-plan-repository.js", 'operatorStatus === "preparing"', '["preparing", "packed"].includes(operatorStatus)'],
  packedProgress: ["dispatch-plan-repository.js", '(operatorStatus !== "packed" && row.has_unsubmitted_line_progress === true)', 'row.has_unsubmitted_line_progress === true'],
  preparation: ["dispatch-plan-repository.js", 'operatorStatus === "preparing"', 'operatorStatus === "disabled_preparing"'],
  lock: ["dispatch-plan-repository.js", 'row.preparing_operator_id != null', 'false'],
  openProgress: ["dispatch-plan-repository.js", '(operatorStatus !== "packed" && row.has_unsubmitted_line_progress === true)', 'false'],
  actualReview: ["dispatch-plan-repository.js", '["review", "missing", "error"].includes(\n      calculationReconciliationStatus\n    )', 'false'],
  writeProtection: ["sales-order-reconciliation-repository.js", 'blocked: true,\n    orderId: Number(row.netsuite_id)', 'blocked: false,\n    orderId: Number(row.netsuite_id)'],
  completed: ["sales-order-reconciliation.js", 'return { status: "Completed", reconciliationStatus: "ok" };', 'return { status: "Queued", reconciliationStatus: "ok" };'],
  cacheReview: ["refresh-dispatch-packed-group-reviews.mjs", 'if (!fresh || fresh.reconciliationBlocked || !["ok", "current"].includes(fresh.reconciliationStatus))', 'if (!fresh)'],
  cacheQuantities: ["refresh-dispatch-packed-group-reviews.mjs", 'return result;\n}\n\nasync function currentGroup', 'result.pallets = 0;\n  return result;\n}\n\nasync function currentGroup'],
  cacheWrite: ["refresh-dispatch-packed-group-reviews.mjs", 'WHERE group_ref=$1`, [row.group_ref', 'WHERE group_ref=$1 AND false`, [row.group_ref']
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (process.env.PACKED_GROUP_BASELINE === "1" && url.endsWith("/src/dispatch-plan-repository.js")) {
    return { ...result, source: await readFile("test-artifacts/packed-group-review/baseline/dispatch-plan-repository.js", "utf8") };
  }
  const mutation = mutants[process.env.PACKED_GROUP_MUTANT];
  if (!mutation || !url.endsWith(`/${mutation[0]}`)) {
    return result;
  }
  const source = String(result.source);
  if (source.split(mutation[1]).length !== 2) {
    throw new Error(`Mutation anchor must occur exactly once: ${process.env.PACKED_GROUP_MUTANT}`);
  }
  return { ...result, source: source.replace(mutation[1], mutation[2]) };
}
