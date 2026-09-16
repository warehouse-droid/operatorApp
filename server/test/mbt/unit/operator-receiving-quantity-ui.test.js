import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import test from "node:test";
import fc from "fast-check";

const source = readFileSync(new URL("../../../public/operator.js", import.meta.url), "utf8");
const context = vm.createContext({});
for (const name of ["qty", "receivingRemainingSalesQty", "hasReceivingRemainingQty"]) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  const end = source.indexOf("\n}", start) + 2;
  const executable = source.slice(0, start).replace(/[^\n]/g, " ") + source.slice(start, end)
    + source.slice(end).replace(/[^\n]/g, " ");
  new vm.Script(executable, { filename: path.resolve("public/operator.js") }).runInContext(context);
}

test("receiving UI uses the projected remaining quantity exactly once", () => {
  assert.equal(context.receivingRemainingSalesQty({ original_quantity: 100, quantity: 40, netsuite_received_qty: 60 }), 40);
  assert.equal(context.hasReceivingRemainingQty({ original_quantity: 100, quantity: 40, netsuite_received_qty: 60 }), true);
  assert.equal(context.receivingRemainingSalesQty({ quantity: 100, netsuite_received_qty: 60 }), 40);
  assert.equal(context.hasReceivingRemainingQty({ original_quantity: 100, quantity: 0, netsuite_received_qty: 100 }), false);
});

test("property: projected receiving quantities remain visible regardless of allocation or prior receipts", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 100000 }), fc.integer({ min: 0, max: 100000 }),
    fc.integer({ min: 0, max: 100000 }), (remaining, received, allocated) => {
      const line = { original_quantity: (remaining + received) / 100, quantity: remaining / 100,
        netsuite_received_qty: received / 100, so_allocated_sales_qty: allocated / 100 };
      assert.equal(context.receivingRemainingSalesQty(line), remaining / 100);
      assert.equal(context.hasReceivingRemainingQty(line), remaining > 0);
    }), { seed: 20260915, numRuns: 100 });
});
