export const mutants = {
  hideReference: { file: "src/delivery-repository.js",
    from: "projectCoOperatorLinkedSupply(mapLocalCoLineForDelivery(line), { loaded })", to: "mapLocalCoLineForDelivery(line)" },
  ignoreAllocation: { file: "src/co-operator-linked-supply.js",
    from: "Number((required[field] - residual[field]).toFixed(6))", to: "0" },
  doubleSubtract: { file: "src/co-operator-linked-supply.js",
    from: "Math.max(original[field], residual[field])", to: "Math.max(original[field] - residual[field], 0)" },
  allowPacking: { file: "src/delivery-repository.js",
    from: 'if (!line) throw new Error("Local CO line not found.");\n  assertOperatorLinkedLineLoadable(line);',
    to: 'if (!line) throw new Error("Local CO line not found.");' },
  reinterpretLoaded: { file: "src/co-operator-linked-supply.js",
    from: "options.loaded || !saved", to: "!saved" }
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const name = process.env.CO_SUPPLY_REFERENCE_MUTANT;
  const mutant = mutants[name];
  if (!mutant || !url.endsWith(`/${mutant.file}`)) {return result;}
  const source = String(result.source);
  if (source.split(mutant.from).length !== 2) {throw new Error(`Invalid mutation anchor: ${name}`);}
  return { ...result, source: source.replace(mutant.from, mutant.to) };
}
