export const mutants = {
  lowercaseSearch: ['public/dispatch.js', 'String(transferOrderRef ?? draft.ref).trim().toUpperCase()', 'String(transferOrderRef ?? draft.ref).trim()'],
  loseRemotePickup: ['src/sales-order-reconciliation.js', '...(order.directPickupManifest || []).map((entry) => entry.location),', ''],
  keepNormalTarget: ['src/order-dependency-repository.js', '["yard_replenishment", "direct_to_customer"].includes(dependency.mode)', 'dependency.mode === "yard_replenishment"'],
  allowStartedGrouping: ['src/yard-dependency-structure.js', '&& dependency.has_execution_progress === false', ''],
  loseMemberManifests: ['public/dispatch.js', 'new Map([...groupMembers.childOrderDetails, order]', 'new Map([order]'],
  stalePickupMembers: ['public/dispatch.js', 'planning.refs.has(String(ref)) ? grouped.id : ref', 'ref'],
  ignorePoolStructure: ['src/server.js', 'if (membership !== "normal" && !before.membership.has(key)) refs.add(key);', 'if (false) refs.add(key);']
};

export function mutateSource(file, source) {
  const mutation = mutants[process.env.LINK_TO_GROUP_MUTANT];
  if (!mutation || mutation[0] !== file) {return source;}
  if (source.split(mutation[1]).length !== 2) {throw new Error(`Mutation target changed: ${file}`);}
  return source.replace(mutation[1], mutation[2]);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const mutation = mutants[process.env.LINK_TO_GROUP_MUTANT];
  if (!mutation || !url.endsWith(`/${mutation[0]}`)) {return result;}
  return { ...result, source: mutateSource(mutation[0], String(result.source)) };
}
