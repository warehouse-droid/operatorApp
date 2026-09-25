export const mutants = {
  noSubtract: { file: "src/co-direct-to-cargo.js", from: "base.quantity - allocated", to: "base.quantity" },
  doubleSubtract: { file: "src/co-direct-to-cargo.js", from: "(line.raw?.coDirectToRequirement || line)[field]", to: "line[field]" },
  wrongPhysical: { file: "src/co-direct-to-cargo.js", from: "base[field] * ratio", to: "base[field]" },
  ignorePacking: { file: "src/co-direct-to-cargo.js", from: '|| line.confirmed_at || PACKED.some(field => quantity(line[field]) > 0)', to: '|| false' },
  ignoreMutex: { file: "src/co-direct-to-cargo.js", from: "await lockConsolidatedLoadOrders([...candidates.map(co => co.delivery_order_id || -Number(co.id)), ...sales.map(row => row.netsuite_id)]);", to: "await Promise.resolve();" },
  hidePacked: { file: "src/delivery-repository.js", from: 'const releasedPacking = co.status === "pending_load"', to: 'const releasedPacking = false && co.status === "pending_load"' },
  exposeDraft: { file: "src/delivery-repository.js", from: 'co.status === "pending_load" && !co.preparing_operator_id && !co.preparing_started_at', to: '["pending_load", "preparing"].includes(co.status)' },
  omitRemainder: { file: "src/delivery-repository.js", from: 'row.operator_status !== "packed" || row.underpack_count > 0', to: 'row.operator_status !== "packed"' },
  keepDirectCargo: { file: "src/dispatch-local-co-cargo.js", from: '.some(value => Number(value || 0) > 0)', to: '.some(() => true)' }
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const name = process.env.CO_DIRECT_TO_MUTANT;
  const mutant = mutants[name];
  if (!mutant || !url.endsWith(`/${mutant.file}`)) {return result;}
  const source = String(result.source);
  if (source.split(mutant.from).length !== 2) {throw new Error(`Invalid mutation anchor: ${name}`);}
  return { ...result, source: source.replace(mutant.from, mutant.to) };
}
