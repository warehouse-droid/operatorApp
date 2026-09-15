import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { normalizeOperatorYardLocationIds, operatorYardLocationIds, assertOperatorYard } from "../../../src/operator-yard-access.js";

const yards = [1, 28, 15, 26];

test("Operator grants start empty and never inherit Sales or manager grants", () => {
  for (const role of ["operator", "yard_manager", "sales"]) {
    const account = { role, yardLocationIds: yards };
    assert.deepEqual(operatorYardLocationIds(account), []);
    assert.throws(() => assertOperatorYard(account, 1), { status: 403, code: "OPERATOR_YARD_FORBIDDEN" });
  }
});

test("grant normalization accepts only complete supported IDs with stable deduplication", () => {
  assert.deepEqual(normalizeOperatorYardLocationIds(["28", 1, 28, "26"]), [1, 28, 26]);
  assert.deepEqual(normalizeOperatorYardLocationIds(), []);
  for (const value of [null, "1", {}, [195], [0], [-1], [1.5], [true], ["1x"], [""], [null], [[1]]]) {
    assert.throws(() => normalizeOperatorYardLocationIds(value), { status: 400 });
  }
});

test("admin primary or secondary role has precisely the four Operator yards", () => {
  for (const account of [{ role: "admin" }, { role: "dispatcher", roles: ["dispatcher", "admin"] }]) {
    assert.deepEqual(operatorYardLocationIds(account), yards);
    for (const id of yards) {assert.equal(assertOperatorYard(account, id), id);}
    assert.throws(() => assertOperatorYard(account, 4), { status: 403 });
  }
});

test("property: authorized set membership is exact in both directions and independent of Sales rights", () => {
  fc.assert(fc.property(fc.subarray(yards), fc.subarray(yards), fc.integer({ min: -10, max: 200 }), (grants, sales, id) => {
    const account = { role: "operator", operatorYardLocationIds: grants, yardLocationIds: sales };
    assert.deepEqual(operatorYardLocationIds(account), yards.filter((yard) => grants.includes(yard)));
    for (const candidate of [...yards, id]) {
      if (grants.includes(candidate)) {assert.equal(assertOperatorYard(account, candidate), candidate);}
      else {assert.throws(() => assertOperatorYard(account, candidate), { status: 403 });}
    }
  }), { seed: 20260915, numRuns: 200 });
});

test("property: grant parser preserves every assigned yard and rejects every other numeric ID", () => {
  fc.assert(fc.property(fc.array(fc.constantFrom(...yards)), fc.integer().filter((id) => !yards.includes(id)), (grants, invalid) => {
    const expected = yards.filter((id) => grants.includes(id));
    assert.deepEqual(normalizeOperatorYardLocationIds(grants), expected);
    assert.deepEqual(normalizeOperatorYardLocationIds(grants.map(String)), expected);
    assert.throws(() => normalizeOperatorYardLocationIds([...grants, invalid]), { status: 400 });
  }), { seed: 20260915, numRuns: 200 });
});
