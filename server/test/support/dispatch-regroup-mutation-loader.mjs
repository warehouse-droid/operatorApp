const mutations = {
  baseline: ["&& !reactivating) return [];", ") return [];"],
  active_owner_overwrite: ["existingSource?.active === false", "Boolean(existingSource)"],
  stale_assigned_restore: [
    ".filter((row) => row.active !== true && !allowedReactivations.has(text(row.order_ref).toLowerCase()))",
    ".filter(() => false)"
  ]
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith("/src/dispatch-delivery-group-repository.js")) { return result; }
  const mutation = mutations[process.env.MBBS_REGROUP_MUTATION];
  if (!mutation) { throw new Error("Unknown regroup mutation"); }
  const source = result.source.toString();
  if (source.split(mutation[0]).length !== 2) { throw new Error("Regroup mutation marker must be unique"); }
  return { ...result, source: source.replace(mutation[0], mutation[1]) };
}
