import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import fc from "fast-check";
import { destinationFunctions } from "../../support/dispatch-po-line-destination-functions.mjs";

const sourceOverride = process.env.PO_IDENTITY_SOURCE;
const { linesForEntry } = destinationFunctions(sourceOverride || "../../src/dispatch-order-target-repository.js", [
  "text", "number", "splitParentRef", "targetLineKey", "targetItemQuantity",
  "lineMatchesItem", "sourceLineIdentity", "normalizedTargetLine", "linesForEntry",
  ...(readFileSync(sourceOverride || new URL("../../../src/dispatch-order-target-repository.js", import.meta.url), "utf8")
    .includes("function findLineForItem(") ? ["findLineForItem"] : [])
], { EPSILON: 0.000001 });

function fixture() {
  const sourceRef = "SOA09948-S1";
  const lines = [
    { id: "-67318607752703", line_id: "5100029", item_id: "2055", unit: "SQFT", quantity: "947.73",
      item_description: "BLU 60 MM SLAB HD2 SMOOTH Caffè Crema", parentRow: "520096" },
    { id: "-4131836072916", line_id: "5100032", item_id: "2055", unit: "PC", quantity: "11",
      item_description: "SIENASTONE™ SMOOTH COPING SAFARI", parentRow: "520099" }
  ].map(line => ({ ...line, sales_order_id: "-17761295776066", source_order_ref: sourceRef,
    sku: "MBBS-Special Order", item_name: "MBBS-Special Order", item_type: "NonInvtPart" }));
  const entry = { id: sourceRef, type: "SO", originalOrderId: "SOA09948", items: lines.map(line => ({
    lineRowId: line.parentRow, lineId: Number(line.line_id), itemId: 2055, sku: line.sku,
    itemName: line.item_name, description: line.item_description, quantity: Number(line.quantity), unit: line.unit
  })) };
  return { targetRef: "GOA-9948S1-9949S1", kind: "group", entry,
    canonical: { headers: new Map([[sourceRef, {}]]), lines: new Map([[sourceRef, lines]]) } };
}

test("GOA-9948S1-9949S1 keeps BLU slab and SIENASTONE coping as distinct source lines", () => {
  const input = fixture();
  const before = structuredClone(input);
  const resolved = linesForEntry(input);
  assert.deepEqual(resolved.map(line => [line.salesLineId, line.lineId, line.description, line.unit, line.quantity]), [
    [-67318607752703, "5100029", "BLU 60 MM SLAB HD2 SMOOTH Caffè Crema", "SQFT", 947.73],
    [-4131836072916, "5100032", "SIENASTONE™ SMOOTH COPING SAFARI", "PC", 11]
  ]);
  assert.deepEqual(resolved.map(line => line.targetLineKey), [
    "GOA-9948S1-9949S1::SOA09948-S1::520096", "GOA-9948S1-9949S1::SOA09948-S1::520099"
  ]);
  assert.deepEqual(input, before);
});

test("a split resolves its second repeated item using the NetSuite line ID", () => {
  const input = fixture();
  input.targetRef = input.entry.id;
  input.kind = "split";
  input.entry.items = [input.entry.items[1]];
  const [line] = linesForEntry(input);
  assert.equal(line.salesLineId, -4131836072916);
  assert.equal(line.unit, "PC");
  assert.equal(line.quantity, 11);
});

test("repeated item resolution is independent of canonical row ordering", () => {
  fc.assert(fc.property(fc.boolean(), fc.double({ min: 0.01, max: 1000, noNaN: true }), (reverse, quantity) => {
    const input = fixture();
    if (reverse) { input.canonical.lines.get(input.entry.id).reverse(); }
    input.entry.items = [{ ...input.entry.items[1], quantity }];
    const [line] = linesForEntry(input);
    assert.equal(line.salesLineId, -4131836072916);
    assert.equal(line.unit, "PC");
    assert.equal(line.quantity, quantity);
  }), { seed: 99489949, numRuns: 100 });
});

function parentFixture() {
  const input = fixture();
  const parentRef = input.entry.originalOrderId;
  const lines = input.canonical.lines.get(input.entry.id).map(line => ({
    ...line, id: line.parentRow, sales_order_id: "1046936", source_order_ref: parentRef
  }));
  input.kind = "split";
  input.targetRef = input.entry.id;
  input.canonical = { headers: new Map([[parentRef, {}]]), lines: new Map([[parentRef, lines]]) };
  return input;
}

test("an exact parent row ID outranks an earlier repeated item when the line ID is absent", () => {
  const input = parentFixture();
  input.entry.items = [input.entry.items[1]];
  delete input.entry.items[0].lineId;
  const [line] = linesForEntry(input);
  assert.equal(line.salesLineId, 520099);
  assert.equal(line.unit, "PC");
});

test("an exact parent row ID outranks a conflicting stale NetSuite line ID", () => {
  const input = parentFixture();
  input.entry.items = [{ ...input.entry.items[1], lineId: input.entry.items[0].lineId }];
  const [line] = linesForEntry(input);
  assert.equal(line.salesLineId, 520099);
  assert.equal(line.lineId, "5100032");
});

test("the parent fallback finds the exact line before accepting a shared item code", () => {
  const input = parentFixture();
  input.canonical.headers.set(input.entry.id, {});
  input.entry.items = [input.entry.items[1]];
  const [line] = linesForEntry(input);
  assert.equal(line.salesLineId, 520099);
  assert.equal(line.sourceOrderRef, "SOA09948");
  assert.equal(line.unit, "PC");
});

test("materialized group members ignore parent row IDs that collide with another child row", () => {
  const input = fixture();
  input.canonical.lines.get(input.entry.id)[0].id = "520099";
  input.entry.items = [input.entry.items[1]];
  const [line] = linesForEntry(input);
  assert.equal(line.salesLineId, -4131836072916);
  assert.equal(line.unit, "PC");
});

test("legacy item ID and case-insensitive SKU fallbacks remain available", () => {
  for (const item of [{ itemId: 2055, quantity: 3 }, { sku: "mbbs-special order", quantity: 3 }]) {
    const input = parentFixture();
    input.entry.items = [item];
    const [line] = linesForEntry(input);
    assert.equal(line.salesLineId, 520096);
    assert.equal(line.quantity, 3);
  }
});

test("unmatched items remain absent and canonical entries without snapshot items retain all lines", () => {
  const input = fixture();
  input.entry.items = [{ itemId: 999999, sku: "unknown", quantity: 1 }];
  assert.deepEqual(linesForEntry(input), []);
  input.entry.items = [];
  assert.deepEqual(linesForEntry(input).map(line => line.salesLineId), [-67318607752703, -4131836072916]);
});

test("exact parent row selection survives canonical reordering and preserves split quantities", () => {
  fc.assert(fc.property(fc.boolean(), fc.integer({ min: 1, max: 1000 }), (reverse, quantity) => {
    const input = parentFixture();
    if (reverse) { input.canonical.lines.get(input.entry.originalOrderId).reverse(); }
    input.entry.items = [{ ...input.entry.items[1], quantity }];
    delete input.entry.items[0].lineId;
    const [line] = linesForEntry(input);
    assert.equal(line.salesLineId, 520099);
    assert.equal(line.unit, "PC");
    assert.equal(line.quantity, quantity);
  }), { seed: 520099, numRuns: 100 });
});
