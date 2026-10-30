import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { smartScmRequestedPoHandoff } from "../../../src/smart-scm-po-handoff.js";

test("property: unrequested quantities cover zero and requested plus remaining conserves shortage", () => {
  fc.assert(fc.property(fc.record({ need: fc.integer({ min: 0, max: 1_000_000 }),
    blanket: fc.integer({ min: 0, max: 1_000_000 }), quantities: fc.array(fc.record({
      quantity: fc.integer({ min: 1, max: 10000 }), requested: fc.boolean()
    }), { maxLength: 30 }) }), ({ need, blanket, quantities }) => {
    const states = [{ key: "1189:26", requiredPallets: need,
      residualRequiredPallets: Math.max(0, need - blanket), availablePallets: 24, rop: 35 }];
    const lines = quantities.map((row, index) => ({ proposal_id: index + 1, line_id: index + 1,
      proposal_type: "PO", proposal_origin: "inventory", status: row.requested ? "order_requested" : "held",
      order_requested_at: row.requested ? "2026-10-22T17:00:00Z" : null, item_id: 1189,
      destination_location_id: 26, proposed_pallets: row.quantity }));
    const requested = quantities.filter((row) => row.requested).reduce((sum, row) => sum + row.quantity, 0);
    const result = smartScmRequestedPoHandoff(states, lines).states[0];
    assert.equal(result.requiredPallets, Math.max(0, need - requested));
    assert.equal(result.residualRequiredPallets, Math.max(0, need - blanket - requested));
    assert.equal(result.residualRequiredPallets + Math.min(requested, states[0].residualRequiredPallets),
      states[0].residualRequiredPallets);
    assert.equal(result.availablePallets, 24);
    assert.equal(result.rop, 35);
    assert.deepEqual(smartScmRequestedPoHandoff(states, [...lines].reverse()).states, [result]);
    assert.equal(states[0].requiredPallets, need);
  }), { seed: 39131, numRuns: 300 });
});

test("property: mixed request evidence cannot turn drafts, real POs or other yards into coverage", () => {
  const kinds = ["unrequested", "pending", "real", "cancelled", "review", "another_yard", "blanket"];
  fc.assert(fc.property(fc.integer({ min: 0, max: 100 }), fc.array(fc.record({
    kind: fc.constantFrom(...kinds), quantity: fc.integer({ min: 1, max: 100 }),
    confirmed: fc.integer({ min: 0, max: 100 })
  }), { maxLength: 20 }), (need, cases) => {
    const lines = cases.map((entry, index) => ({ proposal_id: index + 1, line_id: index + 1,
      proposal_type: "PO", proposal_origin: entry.kind === "blanket" ? "blanket" : "inventory",
      status: entry.kind === "cancelled" ? "cancelled" : "order_requested",
      order_requested_at: entry.kind === "unrequested" ? null : "2026-10-22T17:00:00Z",
      netsuite_purchase_order_id: entry.kind === "real" ? 123 : null, item_id: 1189,
      destination_location_id: entry.kind === "another_yard" ? 1 : 26,
      vendor_resolution_kind: entry.kind === "review" ? "netsuite_po_review" : null,
      proposed_pallets: entry.quantity, confirmed_pallets: entry.confirmed }));
    const covered = cases.reduce((sum, entry) => {
      if (entry.kind === "pending") {
        return sum + entry.quantity;
      }
      return entry.kind === "review" ? sum + entry.confirmed : sum;
    }, 0);
    const result = smartScmRequestedPoHandoff([{ key: "1189:26", requiredPallets: need }],
      lines.flatMap((entry) => [entry, entry]));
    assert.equal(result.states[0].requiredPallets, Math.max(0, need - covered));
  }), { seed: 39132, numRuns: 300 });
});
