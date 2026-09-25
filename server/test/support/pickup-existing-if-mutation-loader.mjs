import { pickupMutants } from './pickup-existing-if-mutants.mjs';

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith('/src/operator-pickup-existing-if-domain.js')) { return result; }
  const name = process.env.PICKUP_IF_MUTANT;
  if (!name) { return result; }
  const [before, after] = pickupMutants[name];
  const source = String(result.source);
  if (source.split(before).length !== 2) { throw new Error(`Mutation anchor must be unique: ${name}`); }
  console.error(`PICKUP_MUTATION_APPLIED:${name}`);
  return { ...result, source: source.replace(before, after) };
}
