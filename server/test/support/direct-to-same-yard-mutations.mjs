export const mutants = {
  omitBrowserTo: { file: "public/dispatch.js", from: "return [...sourceItems, ...directItems].filter(isOperationalDispatchItem)", to: "return [...sourceItems].filter(isOperationalDispatchItem)" },
  duplicateBrowserTo: { file: "public/dispatch.js", from: "return [...sourceItems, ...directItems].filter(isOperationalDispatchItem)", to: "return [...sourceItems, ...directItems, ...directItems].filter(isOperationalDispatchItem)" },
  omitServerTo: { file: "src/dispatch-load-assignment.js", from: "return [...sourceItems, ...directItems].filter(dispatchOperationalPickupItem)", to: "return [...sourceItems].filter(dispatchOperationalPickupItem)" },
  omitToDetails: { file: "public/dispatch.js", from: "const directRows = directEntries.map((entry)", to: "const directRows = [].map((entry)" },
  duplicateToDetailRows: { file: "public/dispatch.js", from: "(order.items || []).filter(isOperationalDispatchItem)\n      .map((item) => itemForPickupLocation(item, pickupLocation, order)).filter(itemHasQuantity)", to: "tooltipItemsForOrder(order, { pickupLocation, stop })" },
  wrongPickupYard: { file: "public/dispatch.js", from: "(order.directPickupManifest || []).filter((entry) => normalizedPickupLocation(entry.location) === location)", to: "(order.directPickupManifest || []).filter(() => Boolean(location))" },
  loseDrop: { file: "public/dispatch.js", from: 'if (stop?.type === "drop") return dropItemsForStop(order, stop)', to: 'if (stop?.type === "drop") return []' },
  mixRemoteResidual: { file: "public/dispatch.js", from: "if (directItems.length && !sameDispatchLocation(order.sourceYard || order.outboundLocation, pickupLocation))", to: "if (false)" }
};

export function mutate(source, name) {
  const mutant = mutants[name];
  if (source.split(mutant.from).length !== 2) {throw new Error(`Invalid mutation anchor: ${name}`);}
  return source.replace(mutant.from, mutant.to);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const name = process.env.DIRECT_TO_MUTANT;
  const mutant = mutants[name];
  if (!mutant || !mutant.file.startsWith("src/") || !url.endsWith(`/${mutant.file}`)) {return result;}
  return { ...result, source: mutate(String(result.source), name) };
}
