export const mutants = {
  includeVirtualGroup: { file: "src/co-source-packing-handoff.js",
    from: "(order?.is_dispatch_group ? order.child_orders || [] : [order])", to: "[order, ...(order?.child_orders || [])]" },
  skipGroupedGuard: { file: "src/co-source-packing-handoff.js",
    from: "order.child_orders || []", to: "[]" },
  checkOnlyFirstChild: { file: "src/co-source-packing-handoff.js",
    from: "order.child_orders || []", to: "(order.child_orders || []).slice(0, 1)" },
  putVirtualLineInBigint: { file: "src/delivery-repository.js",
    from: 'action: "delivery.group.line.unpack",', to: 'action: "delivery.group.line.unpack", lineId,' },
  loseGroupLineAuditIdentity: { file: "src/delivery-repository.js",
    from: "groupId: orderId, groupLineId: lineId, childOrders:", to: "groupId: orderId, childOrders:" }
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const name = process.env.GROUP_LOAD_IDENTITY_MUTANT;
  const mutant = mutants[name];
  if (!mutant || !url.endsWith(`/${mutant.file}`)) {return result;}
  const source = String(result.source);
  if (source.split(mutant.from).length !== 2) {throw new Error(`Invalid mutation anchor: ${name}`);}
  return { ...result, source: source.replace(mutant.from, mutant.to) };
}
