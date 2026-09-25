import { readFile } from 'node:fs/promises';

export const mutants = [
  ['fractions', 'domain', '!Number.isInteger(amount)', '!Number.isFinite(amount)'],
  ['report-date', 'domain', "requireStatus(row, ['confirmed']);\n  actuals(row, input);", "requireStatus(row, ['confirmed']);\n  if (aggregateDates(now).today < row.reportDueDate) { throw aggregateError('Reporting is not due.', 409); }\n  actuals(row, input);"],
  ['owner', 'domain', 'row.requestedBy !== actor.id', 'false'],
  ['variance', 'domain', 'row.lines.some(line => line.actualLoads !== line.confirmedLoads)', 'row.lines.every(line => line.actualLoads !== line.confirmedLoads)'],
  ['revision', 'domain', 'next.revision += 1', 'next.revision += 0'],
  ['report-gate', 'repository', 'if (blockers.length)', 'if (false && blockers.length)'],
  ['retry-conflict', 'repository', 'result.rows[0].payload_hash !== op.hash', 'false']
];

export async function load(url, context, nextLoad) {
  const mutant = mutants.find(([name]) => name === process.env.AGGREGATE_MUTATION);
  if (!mutant || !url.endsWith(`/src/aggregate-request-${mutant[1]}.js`)) { return nextLoad(url, context); }
  const source = await readFile(new URL(url), 'utf8');
  if (source.split(mutant[2]).length !== 2) { throw new Error(`Mutation anchor must occur exactly once: ${mutant[0]}`); }
  process.stderr.write(`AGGREGATE_MUTATION_APPLIED:${mutant[0]}\n`);
  return { format: 'module', shortCircuit: true, source: source.replace(mutant[2], mutant[3]) };
}
