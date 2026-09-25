export const mutants = [
  { name: "replay-load-twice", from: "return existing.result;", to: "return run(photos.map(photo => `operator-photo://${photo.id}`));" },
  { name: "wrong-photo-owner", from: "if (photo.operator_id !== actor.id)", to: "if (false)" },
  { name: "stale-worker-completion", from: "AND lease_token=$2 AND lease_expires_at>now()", to: "AND $2::uuid IS NOT NULL" },
  { name: "unbounded-total-bytes", from: "if (total > 16 * 1024 * 1024)", to: "if (false)" }
];
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url.endsWith("/src/operator-background-photos.js") && process.env.BACKGROUND_PHOTO_MUTANT) {
    const mutant = mutants.find(value => value.name === process.env.BACKGROUND_PHOTO_MUTANT);
    const source = String(result.source);
    if (!mutant || source.split(mutant.from).length !== 2) throw new Error("Mutation anchor is missing or ambiguous.");
    return { ...result, source: source.replace(mutant.from, mutant.to) };
  }
  return result;
}
