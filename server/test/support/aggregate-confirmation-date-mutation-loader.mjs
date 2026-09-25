import { readFile } from 'node:fs/promises';

export const mutants = [
  ['ignore-selected-date', 'domain', 'if (input.serviceDate !== undefined) {', 'if (false) {'],
  ['due-two-days-late', 'domain', 'date.setUTCDate(date.getUTCDate() + 1);', 'date.setUTCDate(date.getUTCDate() + 2);'],
  ['accept-rolled-over-date', 'domain', ' || date.toISOString().slice(0, 10) !== serviceDate', ''],
  ['break-legacy-confirmation', 'domain', 'if (input.serviceDate !== undefined) {', 'if (true) {'],
  ['omit-saved-dates', 'repository', 'updated_at=$13,service_date=$14,report_due_date=$15 WHERE id=$1',
    'updated_at=$13 WHERE id=$1 AND $14::date IS NOT NULL AND $15::date IS NOT NULL']
];
export async function load(url, context, nextLoad) {
  const mutant = mutants.find(([name]) => name === process.env.AGGREGATE_DATE_MUTATION);
  if (!mutant || !url.endsWith(`/src/aggregate-request-${mutant[1]}.js`)) { return nextLoad(url, context); }
  const source = await readFile(new URL(url), 'utf8');
  if (source.split(mutant[2]).length !== 2) { throw new Error(`Mutation anchor must occur exactly once: ${mutant[0]}`); }
  process.stderr.write(`AGGREGATE_DATE_MUTATION_APPLIED:${mutant[0]}\n`);
  return { format: 'module', shortCircuit: true, source: source.replace(mutant[2], mutant[3]) };
}
