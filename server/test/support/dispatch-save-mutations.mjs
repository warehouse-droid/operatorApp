export const mutants = {
  skip_revision: ['if (baseRevision !== null &&', 'if (false && baseRevision !== null &&'],
  skip_digest: ['if (text(baseDigest) && text(baseDigest) !== currentDigest)', 'if (false && text(baseDigest) && text(baseDigest) !== currentDigest)'],
  skip_required: ['if (required && (baseRevision', 'if (false && required && (baseRevision'],
  compare_enriched: ['assertDispatchPlanFence(persistedPlan, { ...command,', 'assertDispatchPlanFence(plan, { ...command,'],
  reused_identity: ['if (stored.bodyDigest !== bodyDigest)', 'if (false && stored.bodyDigest !== bodyDigest)'],
  alias_identity: ['const enrichedByRef = new Map(enrichedOrders.map((order) => [text(order.id).toLowerCase(), order]));', 'const enrichedByRef = orderIndex(enrichedOrders);']
};
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const mutation = process.env.DISPATCH_SAVE_MUTANT;
  const target = mutation === 'alias_identity' ? '/src/scm-dependency-plan-reconciler.js' : '/src/dispatch-planner-performance.js';
  if (!mutation || !url.endsWith(target)) return result;
  const [before, after] = mutants[mutation] || [];
  const source = String(result.source);
  if (!before || source.split(before).length !== 2) throw new Error(`Invalid mutation anchor: ${mutation}`);
  return { ...result, source: source.replace(before, after) };
}
