export const mutants = {
  skipArrivalProof: ['src/co-source-packing-handoff.js', "AND NOT ($3::boolean AND co.status='completed' AND ${completedCoArrivalSql()} IS NOT NULL)", "AND NOT ($3::boolean AND co.status='completed')"],
  allowGroupSplitCommand: ['src/dispatch-planner-performance.js', 'if (source.childOrders?.length)', 'if (false)'],
  allowGroupSplitSave: ['src/dispatch-delivery-group-repository.js', 'await assertNoGroupedSplitParents(plan);', 'void plan;'],
  ignoreGlobalGroup: ['src/dispatch-order-target-repository.js', 'const globalOrder = await globalSalesTarget(ref);', 'const globalOrder = null;'],
  reviveRetiredGroup: ['src/dispatch-order-target-repository.js', 'if (result.rows.some(row => !row.active))', 'if (false)'],
  useRawPickupRefs: ['src/driver-co-pickup-evidence.js', 'return corrected && sameRefs(legacy, original) ? expected : original;', 'return original;'],
  ignoreExtraPickupCargo: ['src/driver-co-pickup-evidence.js', 'corrected && sameRefs(legacy, original)', 'corrected'],
  inheritDraftPlan: ['src/operator-linked-transfer-plan.js', "AND plan.status='confirmed'", ''],
  inheritCancelledLink: ['src/operator-linked-transfer-plan.js', "AND dependency.status NOT IN ('cancelled','attention')", ''],
  leaveUnplannedMetadata: ['src/order-dependency-repository.js', 'dateText(dependency.plannedDate) === dateText(plan.planDate)', 'String(dependency.plannedDate).slice(0, 10) === String(plan.planDate).slice(0, 10)'],
  updateOnlyFirstChild: ['src/dispatch-group-action-repository.js', 'for (const ref of refs) { await updateChild(ref, state.type); }', 'for (const ref of refs.slice(0, 1)) { await updateChild(ref, state.type); }'],
  skipGroupAddressRequest: ['public/dispatch.js', '&& !persistentSalesSplit && !persistentGroup', '&& !persistentSalesSplit']
};
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const mutant = mutants[process.env.LINK_TO_MUTANT];
  if (!mutant || !url.endsWith('/' + mutant[0])) { return result; }
  const source = String(result.source);
  if (source.split(mutant[1]).length !== 2) { throw new Error('Mutation target changed: ' + mutant[0]); }
  return { ...result, source: source.replace(mutant[1], mutant[2]) };
}
