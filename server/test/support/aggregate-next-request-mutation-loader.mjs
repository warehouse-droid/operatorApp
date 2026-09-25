import { readFile } from 'node:fs/promises';

export const mutants = [
  ['completed-in-workspace', 'repository', "AND r.status IN ('submitted','confirmed')\n    AND ($2::bigint", "AND r.status IN ('submitted','confirmed','reported','rejected')\n    AND ($2::bigint"],
  ['confirmed-hidden', 'repository', "AND r.status IN ('submitted','confirmed')\n    AND ($2::bigint", "AND r.status IN ('submitted')\n    AND ($2::bigint"],
  ['wrong-blocking-request', 'repository', 'requestId: Number(existing.rows[0].id)', 'requestId: Number(existing.rows[0].id) + 1'],
  ['memo-role-bypass', 'domain', 'function memo(row, input, actor) {\n  requireManager(actor);', 'function memo(row, input, actor) {'],
  ['memo-wrong-material', 'domain', 'scmMemo: memos[line.materialCode]', 'scmMemo: memos.gravel'],
  ['memo-overwrites-loads', 'domain', '...line, scmMemo: memos[line.materialCode]', '...line, requestedLoads: 0, scmMemo: memos[line.materialCode]']
];
export async function load(url, context, nextLoad) {
  const mutant = mutants.find(([name]) => name === process.env.AGGREGATE_CYCLE_MUTATION);
  if (!mutant || !url.endsWith(`/src/aggregate-request-${mutant[1]}.js`)) { return nextLoad(url, context); }
  const source = await readFile(new URL(url), 'utf8');
  if (source.split(mutant[2]).length !== 2) { throw new Error(`Mutation anchor must occur exactly once: ${mutant[0]}`); }
  process.stderr.write(`AGGREGATE_CYCLE_MUTATION_APPLIED:${mutant[0]}\n`);
  return { format: 'module', shortCircuit: true, source: source.replace(mutant[2], mutant[3]) };
}
