import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { buildSalesResplits } from "../../../src/dispatch-sales-resplit-repository.js";
import { sourceSplit, threeParts } from "../support/unfinished-sales-resplit-fixture.js";

const code = { code: "DISPATCH_SPLIT_QUANTITY_INVALID" };

test("S2 becomes root S3 S4 S5 containing only the remaining 106 PALLET units and three charges", () => {
  const source = sourceSplit(), before = structuredClone(source);
  const result = buildSalesResplits(source, threeParts(source), 3);
  assert.deepEqual(result.map(order => order.id), ["SOA09143-S3", "SOA09143-S4", "SOA09143-S5"]);
  assert.deepEqual(result.map(order => order.items[0].quantity), [36, 35, 35]);
  assert.ok(result.every(order => order.originalOrderId === "SOA09143" && order.resplitSourceOrderId === source.id));
  assert.ok(result.every(order => order.address === source.address && order.items[0].itemId === source.items[0].itemId));
  assert.deepEqual(source, before);
});

test("mixed packing units retain their exact totals and sales conversions", () => {
  const source = sourceSplit();
  source.items = [{ ...source.items[0], quantity: 121, pallets: 2, layers: 2, pieces: 1, toPlt: 50, toLyr: 10, toPcs: 1 }];
  const parts = [{ items: [{ ...source.items[0], quantity: 61, pallets: 1, layers: 1, pieces: 1 }] },
    { items: [{ ...source.items[0], quantity: 60, pallets: 1, layers: 1, pieces: 0 }] }];
  const result = buildSalesResplits(source, parts, 3);
  for (const key of ["quantity", "pallets", "layers", "sections", "pieces"]) {
    assert.equal(result.reduce((sum, order) => sum + Number(order.items[0][key] || 0), 0), Number(source.items[0][key] || 0));
  }
});

for (const [name, change] of [
  ["excess", parts => { parts[0].items[0].quantity += 1; }],
  ["shortage", parts => { parts[0].items[0].quantity -= 1; }],
  ["negative", parts => { parts[0].items[0].quantity = -1; }],
  ["nonfinite", parts => { parts[0].items[0].quantity = Infinity; }],
  ["unknown line", parts => { parts[0].items[0].lineId = 99; }],
  ["duplicate line", parts => { parts[0].items.push(parts[0].items[0]); }],
  ["empty child", parts => { parts[0].items = []; }],
  ["empty parts", parts => { parts.length = 0; }],
  ["too many parts", parts => { parts.push(...Array.from({ length: 8 }, () => structuredClone(parts[0]))); }],
  ["invented packing", parts => { parts[0].items[0].pallets = 1; }]
]) {
  test(`reject ${name} before replacing the unfinished split`, () => {
    const source = sourceSplit(), parts = threeParts(source); change(parts);
    assert.throws(() => buildSalesResplits(source, parts, 3), code);
  });
}

test("property: all children preserve each arbitrary remaining quantity and inherit root identity", () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 10000 }), { minLength: 2, maxLength: 10 }),
    fc.integer({ min: 3, max: 999 }), (values, next) => {
      const source = sourceSplit(); source.items = [source.items[0]];
      source.items[0].quantity = values.reduce((sum, value) => sum + value, 0) / 100;
      const parts = values.map(value => ({ items: [{ ...source.items[0], quantity: value / 100 }] }));
      const result = buildSalesResplits(source, parts, next);
      assert.deepEqual(result.map(order => order.id), values.map((_value, index) => `SOA09143-S${next + index}`));
      assert.ok(Math.abs(result.reduce((sum, order) => sum + order.items[0].quantity, 0) - source.items[0].quantity) < 0.000001);
      assert.ok(result.every(order => order.originalOrderId === "SOA09143"));
      const excess = structuredClone(parts); excess[0].items[0].quantity += 0.01;
      assert.throws(() => buildSalesResplits(source, excess, next), code);
    }), { seed: 20261012, numRuns: 75 });
});


test("per-child sales quantities must match the canonical physical unit conversions", () => {
  const source = sourceSplit();
  source.items = [{ ...source.items[0], quantity: 100, pallets: 2, toPlt: 50 }];
  const parts = [1, 99].map(quantity => ({ items: [{ ...source.items[0], quantity, pallets: 1 }] }));
  assert.throws(() => buildSalesResplits(source, parts, 3), code);
});

test("duplicate canonical source identities must never hide quantity loss", () => {
  const source = sourceSplit(); source.items.push(structuredClone(source.items[0]));
  assert.throws(() => buildSalesResplits(source, threeParts(source), 3), code);
});

test("zero quantity lines cannot masquerade as a nonempty child", () => {
  const source = sourceSplit(), parts = threeParts(source);
  parts[0].items = [{ ...source.items[0], quantity: 0 }];
  assert.throws(() => buildSalesResplits(source, parts, 3), code);
});
