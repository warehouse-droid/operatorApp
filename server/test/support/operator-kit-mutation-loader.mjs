import assert from 'node:assert/strict';
export const mutants = {
  child_line: ['src/operator-netsuite-posting-kits.js', 'return { orderLine: group.parent.orderLine, sourceLineKey:', 'return { orderLine: group.members[0].orderLine, sourceLineKey:'],
  double_count: ['src/operator-netsuite-posting-kits.js', 'quantity: count,', 'quantity: count * group.members.length,'],
  incomplete: ['src/operator-netsuite-posting-kits.js', 'counts.some(value => Math.abs(value - count) > EPSILON)', 'false'],
  stale_remaining: ['src/operator-netsuite-posting-kits.js', 'Math.max(0, orderedQuantity - completedQuantity)', 'orderedQuantity'],
  duplicate_post: ['src/operator-netsuite-posting-service.js', ' && !operatorStepHasKits(step)', '']
};
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const mutation = mutants[process.env.OPERATOR_KIT_MUTANT];
  if (!mutation || !url.endsWith(`/${mutation[0]}`)) { return result; }
  const source = String(result.source);
  assert.equal(source.split(mutation[1]).length, 2, 'Mutant must match exactly once');
  return { ...result, source: source.replace(mutation[1], mutation[2]) };
}
