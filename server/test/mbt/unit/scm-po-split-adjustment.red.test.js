import assert from "node:assert/strict";
import test from "node:test";

import {
  adjustBlanketSplitAllocation,
  assertSplitQuantityAvailable,
  splitQuantityDelta
} from "../../../src/scm-po-split-adjustment.js";

test("split quantity validation includes the child's current allocation", () => {
  assert.deepEqual(splitQuantityDelta({ current: 5, desired: 8 }), { current: 5, desired: 8, delta: 3 });
  assert.doesNotThrow(() => assertSplitQuantityAvailable({ current: 5, desired: 8, sourceAvailable: 3 }));
  assert.throws(
    () => assertSplitQuantityAvailable({ current: 5, desired: 9, sourceAvailable: 3 }),
    (error) => error.code === "SCM_PO_SPLIT_QUANTITY_EXCEEDS_SOURCE"
  );
});

test("Blanket reduction moves released quantity to cancelled and never touches held", () => {
  assert.deepEqual(
    adjustBlanketSplitAllocation({ planned: 10, released: 8, held: 2, cancelled: 0 }, -3),
    { planned: 10, released: 5, held: 2, cancelled: 3 }
  );
  assert.throws(
    () => adjustBlanketSplitAllocation({ planned: 10, released: 1, held: 9, cancelled: 0 }, -2),
    (error) => error.code === "SCM_PO_SPLIT_BLANKET_RELEASE_EXCEEDED"
  );
});

test("Blanket increase restores cancelled first, then expands planned and released", () => {
  assert.deepEqual(
    adjustBlanketSplitAllocation({ planned: 10, released: 5, held: 2, cancelled: 3 }, 5),
    { planned: 12, released: 10, held: 2, cancelled: 0 }
  );
});

test("split quantity inputs reject invalid numbers and preserve exact no-op allocations", () => {
  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => splitQuantityDelta({ current: invalid, desired: 1 }),
      (error) => error.code === "SCM_PO_SPLIT_QUANTITY_INVALID"
    );
  }
  assert.throws(
    () => assertSplitQuantityAvailable({ current: 1, desired: 2, sourceAvailable: -1 }),
    (error) => error.code === "SCM_PO_SPLIT_QUANTITY_INVALID"
  );
  assert.throws(
    () => adjustBlanketSplitAllocation({}, "not-a-number"),
    (error) => error.code === "SCM_PO_SPLIT_QUANTITY_INVALID"
  );
  assert.deepEqual(
    adjustBlanketSplitAllocation({ planned: 3, released: 2, held: 1, cancelled: 0 }, 0),
    { planned: 3, released: 2, held: 1, cancelled: 0 }
  );
});
