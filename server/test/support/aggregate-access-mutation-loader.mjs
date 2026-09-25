import { readFile } from 'node:fs/promises';
export const mutants = [
  ['inherited-grants', 'domain', 'unit', 'new Set(actor.aggregateRequestYardLocationIds || [])', 'new Set([...(actor.aggregateRequestYardLocationIds || []), ...(actor.operatorYardLocationIds || [])])'],
  ['inverted-grants', 'domain', 'unit', 'filter(id => yards.has(id))', 'filter(id => !yards.has(id))'],
  ['former-submitter', 'access-repository', 'integration', 'row.operator_id !== actor.id', 'false'],
  ['unlocked-grant', 'access-repository', 'integration', 'FOR SHARE OF a,o', ''],
  ['lost-admin-edit', 'access-repository', 'integration', 'revisions[row.yard_location_id] !== row.revision', 'false'],
  ['unaudited-grant', 'access-repository', 'integration', 'if (changes.length)', 'if (false && changes.length)']
];
export async function load(url, context, nextLoad) {
  const mutant = mutants.find(([name]) => name === process.env.AGGREGATE_ACCESS_MUTATION);
  if (!mutant || !url.endsWith(`/src/aggregate-request-${mutant[1]}.js`)) { return nextLoad(url, context); }
  const source = await readFile(new URL(url), 'utf8');
  if (source.split(mutant[3]).length !== 2) { throw new Error(`Mutation anchor must occur once: ${mutant[0]}`); }
  process.stderr.write(`AGGREGATE_ACCESS_MUTATION_APPLIED:${mutant[0]}\n`);
  return { format: 'module', shortCircuit: true, source: source.replace(mutant[3], mutant[4]) };
}
