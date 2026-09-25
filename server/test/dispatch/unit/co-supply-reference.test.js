import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { projectCoOperatorLinkedSupply } from "../../../src/co-operator-linked-supply.js";

const fields = ["quantity", "pallet_qty", "layer_qty", "section_qty", "piece_qty"];
const units = ["sales", "pallets", "layers", "sections", "pieces"];
const line = (original, residual) => ({ ...residual, item_id: 1356, packed_piece_qty: 2,
  raw: { coDirectToRequirement: original } });

test("fully supplied reference retains original dimensions with zero yard work", () => {
  const result = projectCoOperatorLinkedSupply(line({ quantity: 52.25, layer_qty: 5 }, { quantity: 0, layer_qty: 0 }));
  assert.equal(result.original_quantity, 52.25);
  assert.equal(result.original_layer_qty, 5);
  assert.equal(result.linked_direct_to_sales_qty, 52.25);
  assert.equal(result.linked_direct_to_layer_qty, 5);
  assert.equal(result.quantity, 0);
  assert.equal(result.layer_qty, 0);
  assert.equal(result.no_yard_load_required, true);
  assert.equal(result.linked_supply_label, "No yard load required—direct supply");
});

test("partial pallet allocation remains six packable pallets", () => {
  const result = projectCoOperatorLinkedSupply(line({ quantity: 7 }, { quantity: 6 }));
  assert.equal(result.original_quantity, 7);
  assert.equal(result.linked_direct_to_sales_qty, 1);
  assert.equal(result.operator_required_sales_qty, 6);
  assert.equal(result.quantity, 6);
  assert.equal(result.no_yard_load_required, false);
});

test("ordinary lines and loaded cargo retain their existing representation", () => {
  const ordinary = { quantity: 3, packed_sales_qty: 3 };
  assert.deepEqual(projectCoOperatorLinkedSupply(ordinary), ordinary);
  const loaded = line({ quantity: 7 }, { quantity: 4, packed_sales_qty: 4 });
  assert.deepEqual(projectCoOperatorLinkedSupply(loaded, { loaded: true }), loaded);
});

test("stale smaller originals cannot reduce actual cargo or hide invalid quantities", () => {
  const result = projectCoOperatorLinkedSupply(line({ quantity: 3 }, { quantity: 7 }));
  assert.equal(result.quantity, 7);
  assert.equal(result.original_quantity, 7);
  assert.equal(result.linked_direct_to_sales_qty, 0);
  assert.equal(result.no_yard_load_required, false);
  for (const bad of [-1, Infinity, "NaN"]) {
    assert.throws(() => projectCoOperatorLinkedSupply(line({ quantity: bad }, { quantity: 2 })),
      error => error.code === "LINKED_QUANTITY_INVALID");
    assert.throws(() => projectCoOperatorLinkedSupply(line({ quantity: 7 }, { quantity: bad })),
      error => error.code === "LINKED_QUANTITY_INVALID");
  }
});

test("generated reference projection conserves each unit and is immutable and idempotent", () => {
  const quantities = fc.array(fc.tuple(fc.integer({ min: 1, max: 10000 }), fc.nat(10000)), { minLength: 5, maxLength: 5 });
  fc.assert(fc.property(quantities, pairs => {
    const original = Object.fromEntries(fields.map((field, i) => [field, pairs[i][0] / 4]));
    const residual = Object.fromEntries(fields.map((field, i) => [field, Math.min(...pairs[i]) / 4]));
    const input = line(original, residual);
    const before = structuredClone(input);
    const result = projectCoOperatorLinkedSupply(input);
    for (const [i, field] of fields.entries()) {
      const breakdown = result.quantity_breakdown[units[i]];
      assert.equal(result[field], residual[field]);
      assert.equal(breakdown.original, original[field]);
      assert.equal(breakdown.linkedDirectTo, original[field] - residual[field]);
      assert.equal(breakdown.linkedDirectTo + breakdown.operatorRequired, breakdown.original);
    }
    assert.equal(result.no_yard_load_required, fields.every(field => residual[field] === 0));
    assert.equal(result.packed_piece_qty, 2);
    assert.deepEqual(input, before);
    assert.deepEqual(projectCoOperatorLinkedSupply(result), result);
  }), { numRuns: 200, seed: 88381102 });
});
