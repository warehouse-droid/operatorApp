import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { mapNetSuiteTransferSourceLines } from "../../../src/netsuite.js";
import { mapNetSuiteSalesOrderLine } from "../../../src/sales-order-reconciliation.js";

function rows() {
  return [1, 2, 3, 4, 5, 6].map(n => ({ line_id: 8000 + n, order_line_number: n,
    line_sequence_number: n, do_not_print_line: [1, 4].includes(n) ? "F" : "T",
    quantity: n % 3 === 0 ? 5 : -5, item_id: 77, unit: "EA", location_id: n % 3 === 0 ? 28 : 1 }));
}

test("regular TO sync maps all physical aliases to source REST lines without an offset", () => {
  const source = rows();
  const original = structuredClone(source);
  const mapped = mapNetSuiteTransferSourceLines(source);
  assert.deepEqual(mapped.map(l => l.netsuite_order_line), [1, 1, 1, 4, 4, 4]);
  assert.deepEqual(source, original);
  assert.deepEqual(mapNetSuiteTransferSourceLines([source[2]]).map(l => l.netsuite_order_line), [null]);
});

test("Sales Order reconciliation retains explicit orderLine separately from unique key", () => {
  const mapped = mapNetSuiteSalesOrderLine({ sourceLineKey: "8001", orderLine: 17, identityStatus: "exact", quantity: 5 });
  assert.equal(mapped.line_id, "8001");
  assert.equal(mapped.netsuite_order_line, 17);
  assert.equal(mapNetSuiteSalesOrderLine({ sourceLineKey: "8001", quantity: 5 }).netsuite_order_line, null);
});

test("property: transfer physical-row order and repeated SKUs do not change REST mapping", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 10000 }),
    fc.shuffledSubarray([0, 1, 2, 3, 4, 5], { minLength: 6, maxLength: 6 }), (shift, indices) => {
      const fixture = rows().map(row => ({ ...row, line_id: row.line_id + shift * 10,
        order_line_number: row.order_line_number + shift }));
      const shuffled = indices.map(index => fixture[index]);
      const mapped = mapNetSuiteTransferSourceLines(shuffled);
      for (let i = 0; i < indices.length; i += 1) {
        assert.equal(mapped[i].netsuite_order_line, (indices[i] < 3 ? 1 : 4) + shift);
      }
    }), { numRuns: 150, seed: 993842 });
});
