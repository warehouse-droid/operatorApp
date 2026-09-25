export const mutants = {
  expandSourceSos: ['src/driver-repository.js', 'children.length && (!isCo || coChildren)', 'children.length'],
  keepCoWrapper: ['src/driver-repository.js', 'children.length && (!isCo || coChildren)', 'children.length && !isCo'],
  staleOperationalEffects: ['src/server.js', 'visitJob.orderRefs = record.order_refs;', 'void record.order_refs;'],
  rawSalesCompletion: ['src/dispatch-fulfilled-so-repository.js', 'dispatch_effective_order_completion_events completion', 'dispatch_order_completion_events completion'],
  rawShortageCompletion: ['src/order-dependency-repository.js', 'dispatch_effective_order_completion_events completion', 'dispatch_order_completion_events completion'],
  claimVoidedFulfillment: ['src/sales-order-auto-fulfillment-repository.js',
    'AND EXISTS (SELECT 1 FROM dispatch_effective_order_completion_events completion\n                       WHERE completion.id = candidate.completion_event_id)', 'AND true']
};
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const mutant = mutants[process.env.CO_COMPLETION_MUTANT];
  if (!mutant || !url.endsWith('/' + mutant[0])) { return result; }
  const source = String(result.source);
  if (source.split(mutant[1]).length !== 2) { throw new Error('Mutation target changed: ' + mutant[0]); }
  return { ...result, source: source.replace(mutant[1], mutant[2]) };
}
