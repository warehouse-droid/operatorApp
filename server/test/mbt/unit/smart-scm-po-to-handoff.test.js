import assert from "node:assert/strict";
import test from "node:test";
import { smartScmRequestedPoHandoff } from "../../../src/smart-scm-po-handoff.js";

const state = (overrides = {}) => ({ key: "1189:26", requiredPallets: 8, residualRequiredPallets: 8,
  availablePallets: 0.45, positionPallets: 0.45, rop: 5, safety: 2.35985, ...overrides });
const line = (overrides = {}) => ({ proposal_id: 10, line_id: 20, proposal_type: "PO",
  proposal_origin: "inventory", status: "order_requested", order_requested_at: "2026-10-22T17:00:00Z",
  netsuite_purchase_order_id: null, netsuite_purchase_order_ref: null, vendor_resolution_kind: null,
  vendor_decision: null, item_id: 1189, destination_location_id: 26, proposed_pallets: 3,
  confirmed_pallets: 0, ...overrides });

test("partial requests leave the exact unmet quantity and do not rewrite physical inventory", () => {
  const original = state();
  const result = smartScmRequestedPoHandoff([original], [line()]);
  assert.equal(result.states[0].requiredPallets, 5);
  assert.equal(result.states[0].residualRequiredPallets, 5);
  assert.equal(result.states[0].requestedPoCoveragePallets, 3);
  assert.equal(result.states[0].requiredBeforeRequestedPoPallets, 8);
  assert.equal(result.states[0].availablePallets, 0.45);
  assert.equal(result.states[0].positionPallets, 0.45);
  assert.equal(result.states[0].rop, 5);
  assert.equal(result.states[0].safety, 2.35985);
  assert.equal(original.requiredPallets, 8);
  assert.notEqual(result.states[0], original);
  assert.deepEqual(result.requestedPoLines, [{ proposalId: 10, lineId: 20, itemId: 1189,
    locationId: 26, requestedPallets: 3, orderRequestedAt: "2026-10-22T17:00:00Z" }]);
});

test("unrequested, terminal, actual PO, and Blanket representations cover zero", () => {
  const patches = [
    { order_requested_at: null }, { order_requested_at: "" }, { status: "held", order_requested_at: null },
    ...["cancelled", "superseded", "failed", "completed"].map((status) => ({ status })),
    { netsuite_purchase_order_id: 123 }, { netsuite_purchase_order_ref: "PO-REAL" },
    { proposal_type: "TO" }, { proposal_origin: "blanket" }, { vendor_decision: "cancel" },
    { proposed_pallets: 0 }, { proposed_pallets: -1 }, { proposed_pallets: Number.NaN },
    { proposed_pallets: Number.POSITIVE_INFINITY }, { item_id: null }, { destination_location_id: 0 },
    { line_id: null }, { proposal_id: null }
  ];
  for (const patch of patches) {
    const result = smartScmRequestedPoHandoff([state()], [line(patch)]);
    assert.equal(result.states[0].residualRequiredPallets, 8, JSON.stringify(patch));
    assert.deepEqual(result.requestedPoLines, []);
  }
});

test("requests remain separate by SKU and receiving yard", () => {
  const result = smartScmRequestedPoHandoff([state(), state({ key: "1189:1" })], [
    line(), line({ line_id: 21, item_id: 1190 }), line({ line_id: 22, destination_location_id: 1, proposed_pallets: 2 })
  ]);
  assert.deepEqual(result.states.map((row) => row.requiredPallets), [5, 6]);
});

test("duplicate evidence rows and split parents do not cover the same request twice", () => {
  const result = smartScmRequestedPoHandoff([state()], [line(), line(),
    line({ line_id: 19, status: "superseded", proposed_pallets: 8 }),
    line({ proposal_id: 11, line_id: 21, proposed_pallets: 2 })]);
  assert.equal(result.states[0].requiredPallets, 3);
  assert.equal(result.requestedPoLines.length, 2);
});

test("vendor review covers confirmed pallets including a zero confirmation", () => {
  const result = smartScmRequestedPoHandoff([state()], [line({ status: "confirmed",
    vendor_resolution_kind: "netsuite_po_review", proposed_pallets: 8, confirmed_pallets: 2.5 })]);
  assert.equal(result.states[0].requiredPallets, 5.5);
  assert.equal(smartScmRequestedPoHandoff([state()], [line({ status: "confirmed",
    vendor_resolution_kind: "netsuite_po_review", confirmed_pallets: 0 })]).states[0].requiredPallets, 8);
});

test("coverage applies after Blanket coverage and clamps both needs to zero", () => {
  const partial = smartScmRequestedPoHandoff([state({ residualRequiredPallets: 6 })], [line()]);
  assert.equal(partial.states[0].requiredPallets, 5);
  assert.equal(partial.states[0].residualRequiredPallets, 3);
  const full = smartScmRequestedPoHandoff([state({ residualRequiredPallets: 6 })], [line({ proposed_pallets: 20 })]);
  assert.equal(full.states[0].requiredPallets, 0);
  assert.equal(full.states[0].residualRequiredPallets, 0);
});

test("missing residual uses full need and numeric database strings are accepted", () => {
  const result = smartScmRequestedPoHandoff([state({ residualRequiredPallets: undefined })],
    [line({ item_id: "1189", destination_location_id: "26", proposed_pallets: "3" })]);
  assert.equal(result.states[0].residualRequiredPallets, 5);
  assert.deepEqual(smartScmRequestedPoHandoff([], []), { states: [], requestedPoLines: [] });
});
