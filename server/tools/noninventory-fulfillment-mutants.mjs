const mutants = {
  selection: ['delivery-repository.js', 'const items = lines.filter((/** @type {Record<string, any>} */ line) => line.item_type === "InvtPart").map', 'const items = lines.map'],
  deselection: ['delivery-repository.js', 'if (!line.netsuite_active || line.item_type !== "InvtPart") continue;', 'if (!line.netsuite_active) continue;'],
  outstanding: ['delivery-repository.js', 'if (!line.netsuite_active || line.item_type !== "InvtPart") return false;', 'if (!line.netsuite_active) return false;'],
  stored: ['operator-netsuite-posting-targets.js', '.filter((/** @type {Record<string, any>} */ row) => row.item_type === "NonInvtPart")', '.filter(() => false)'],
  automatic: ['sales-order-auto-fulfillment-repository.js', 'const lines = allLines.filter(line => line.item_type !== "NonInvtPart");', 'const lines = allLines;'],
  receiving: ['operator-netsuite-posting-targets.js', 'new Set(functionKey === "receiving" ? [] : (rows.rows || [])', 'new Set((rows.rows || [])'],
  visibility: ['operator-netsuite-posting-targets.js', 'function hasIgnoredPackedFulfillment(order, functionKey) {', 'function hasIgnoredPackedFulfillment(order, functionKey) { return false;'],
};
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const mutant = mutants[process.env.NONINVENTORY_MUTANT];
  if (!mutant || !url.endsWith('/src/'+mutant[0])) { return result; }
  const source = String(result.source);
  if (source.split(mutant[1]).length !== 2) { throw new Error('Mutation anchor must be unique: '+process.env.NONINVENTORY_MUTANT); }
  return { ...result, source: source.replace(mutant[1], mutant[2]) };
}
