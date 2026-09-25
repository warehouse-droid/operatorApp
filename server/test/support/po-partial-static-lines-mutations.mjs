import assert from "node:assert/strict";

export const mutants = {
  "ignore-completion": ["completedQuantity = counter(row.quantityReceived)", "completedQuantity = 0"],
  "ignore-closed": ["row.isClosed === true ? 0", "false ? 0"],
  "drop-open-deselections": ["Number(Math.max(orderedQuantity - completedQuantity, 0).toFixed(6))", "0"],
  "shift-line-identity": ["current.get(Number(line.orderLine))", "current.get(Number(line.orderLine) + 1)"],
  "keep-stale-counters": ["return [{ ...line, ...live }];", "return [{ ...live, ...line }];"]
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const name = process.env.PO_PARTIAL_MUTATION;
  if (name && url.endsWith("/src/operator-po-receipt-availability.js")) {
    let source = String(result.source);
    const [before, after] = mutants[name];
    assert.equal(source.split(before).length, 2, "Invalid mutation anchor");
    source = source.replace(before, after);
    console.error(`PO_PARTIAL_MUTATION_APPLIED:${name}`);
    return { ...result, source };
  }
  return result;
}
