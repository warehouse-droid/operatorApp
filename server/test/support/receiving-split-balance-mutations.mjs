import assert from "node:assert/strict";

export const mutants = {
  "ignore-reservations": ["const reserved = reservations.get(String(line.id)) || 0;", "const reserved = 0;"],
  "cancelled-still-reserved": ["AND split.status = 'active'", "AND split.status IN ('active','cancelled')"],
  "double-subtract-receipts": ["Math.max(positive(line.receiving_completed_qty),", "(positive(line.receiving_completed_qty) +"],
  "drop-baseline": ["positive(line.netsuite_received_baseline_qty) + positive(line.local_received_qty) + reserved", "positive(line.local_received_qty) + reserved"],
  "block-all": ["receiving_unavailable_qty: Math.max(", "receiving_unavailable_qty: positive(line.quantity) + Math.max("]
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const name = process.env.RECEIVING_SPLIT_MUTATION;
  if (name && url.endsWith("/src/receiving-po-split-progress.js")) {
    let source = String(result.source);
    const [before, after] = mutants[name];
    assert.equal(source.split(before).length, 2, "Invalid mutation anchor");
    source = source.replace(before, after);
    console.error(`RECEIVING_SPLIT_MUTATION_APPLIED:${name}`);
    return { ...result, source };
  }
  return result;
}
