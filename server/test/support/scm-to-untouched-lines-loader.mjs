// Mutations are confined to disposable Node processes, never the shared source.
export const mutants = {
  wholeOrder: ["($2::bigint[] IS NULL OR line.id = ANY($2::bigint[]))", "true"],
  ignoreSelected: ["($2::bigint[] IS NULL OR line.id = ANY($2::bigint[]))", "($2::bigint[] IS NULL)"],
  aggregatePacked: ['&& !(salesLineIds && ["confirmed", "packed"].includes(text(value).toLowerCase()))', "&& true"],
  ignorePreparing: ["text(row.preparing_operator_id)\n      || row.preparing_started_at\n      || salesStatusBlocks", "false\n      || row.preparing_started_at\n      || salesStatusBlocks"],
  ignoreOtherLoaded: ["|| row.order_loaded === true", "|| false"],
  allowPo: ['action !== "link_to" || !Array.isArray(allocations)', "false || !Array.isArray(allocations)"],
  keyIdentity: ["byKey.get(text(allocation?.targetLineKey))", "undefined"],
  missingSelection: ["return [...new Set(selected.map((line) => line.salesLineId))];", "return [];"],
  noLocks: ["if (lock && salesLineIds) {await lockDependencyOperatorOrders(memberRefs, guardedTransferRefs);}", "if (false) {await lockDependencyOperatorOrders(memberRefs, guardedTransferRefs);}"],
  noHeaderRowLock: ["ORDER BY netsuite_id FOR UPDATE", "ORDER BY netsuite_id"],
  noLineRowLock: ["ORDER BY line.id FOR UPDATE OF line", "ORDER BY line.id"]
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const mutant = mutants[process.env.SCM_TO_MUTANT];
  if (!mutant || !url.endsWith("/src/scm-dependency-preview-service.js")) {return result;}
  const source = String(result.source);
  if (source.split(mutant[0]).length !== 2) {throw new Error(`Invalid mutation anchor: ${process.env.SCM_TO_MUTANT}`);}
  return { ...result, source: source.replace(mutant[0], mutant[1]) };
}
