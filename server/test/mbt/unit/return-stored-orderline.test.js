import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { mapStoredReturnSalesOrderLines } from "../../../src/return-stored-orderline.js";

function order() {
  return { id: 42, tranid: "SOM06642", status: "F", customer: { id: 9 }, lines: [
    { sourceLineId: 4998676, itemId: 3026, itemName: "SAME ITEM", suiteQlLineNumber: 1,
      salesQuantity: 918.8, salesUomId: 483, rate: 4.5, fulfilledQuantity: 918.8 },
    { sourceLineId: 4998677, itemId: 3026, itemName: "SAME ITEM", suiteQlLineNumber: 2,
      salesQuantity: 183.76, salesUomId: 486, rate: 5, fulfilledQuantity: 183.76 }
  ] };
}

function rows() {
  return [
    { sales_order_id: "42", line_id: "4998677", item_id: "3026", netsuite_order_line: "17", netsuite_active: true },
    { sales_order_id: "42", line_id: "4998676", item_id: "3026", netsuite_order_line: "10", netsuite_active: true }
  ];
}

const ambiguous = error => error.status === 409 && error.code === "NETSUITE_ORDER_LINE_AMBIGUOUS";
const missing = error => error.status === 409 && error.code === "NETSUITE_ORDER_LINE_MISSING";

test("U1 stable keys select saved REST IDs for repeated SKUs without changing live business values", () => {
  const live = order();
  const before = structuredClone(live);
  const mapped = mapStoredReturnSalesOrderLines(live, rows());
  assert.deepEqual(mapped.lines.map(line => line.netSuiteOrderLine), [10, 17]);
  assert.deepEqual(mapped.lines.map(line => line.netSuiteOrderLineSource), ["stored_order_line_v1", "stored_order_line_v1"]);
  assert.equal(mapped.customer, live.customer);
  for (const [index, line] of mapped.lines.entries()) {
    for (const key of Object.keys(before.lines[index])) {assert.deepEqual(line[key], before.lines[index][key]);}
    assert.equal(line.netSuiteOrderLineSnapshot.orderLine, line.netSuiteOrderLine);
    assert.equal(line.netSuiteOrderLineSnapshot.sourceLineKey, String(line.sourceLineId));
  }
  assert.deepEqual(live, before);
});

test("U2 absent or incomplete saved mappings request the existing REST fallback", () => {
  assert.equal(mapStoredReturnSalesOrderLines(order(), []), null);
  assert.equal(mapStoredReturnSalesOrderLines(order(), rows().slice(1)), null);
  assert.equal(mapStoredReturnSalesOrderLines(order(), rows().map(row => ({ ...row, netsuite_order_line: null }))), null);
  assert.equal(mapStoredReturnSalesOrderLines(order(), rows().map(row => ({ ...row, netsuite_order_line: "" }))), null);
  assert.equal(mapStoredReturnSalesOrderLines(order(), rows().map(row => ({ ...row, netsuite_active: false }))), null);
});

test("U3 wrong source order or item cannot supply a live return line", () => {
  for (const changed of [{ sales_order_id: 43 }, { item_id: 999 }]) {
    const saved = rows();
    Object.assign(saved[0], changed);
    assert.throws(() => mapStoredReturnSalesOrderLines(order(), saved), ambiguous);
  }
});

test("U4 duplicate REST IDs and duplicate live or stored stable keys fail closed", () => {
  assert.throws(() => mapStoredReturnSalesOrderLines(order(), rows().map(row => ({ ...row, netsuite_order_line: 10 }))), ambiguous);
  assert.throws(() => mapStoredReturnSalesOrderLines(order(), [...rows(), rows()[0]]), ambiguous);
  const live = order();
  live.lines.push({ ...live.lines[0] });
  assert.throws(() => mapStoredReturnSalesOrderLines(live, rows()), ambiguous);
});

test("U5 hostile populated REST IDs cannot be sent as NetSuite orderLine", () => {
  for (const value of [0, -1, 0.5, NaN, Infinity, "1e2", "1.5", "Infinity", "  ", {}, [], true, "9007199254740992", "17;DROP TABLE sales_orders"]) {
    const saved = rows();
    saved[0].netsuite_order_line = value;
    assert.throws(() => mapStoredReturnSalesOrderLines(order(), saved), missing, String(value));
  }
});

test("U6 unrelated or inactive saved rows cannot override a selected source key", () => {
  const saved = [...rows(), { ...rows()[0], line_id: 999, netsuite_order_line: 10 },
    { ...rows()[0], netsuite_active: false, netsuite_order_line: 10 }];
  assert.deepEqual(mapStoredReturnSalesOrderLines(order(), saved).lines.map(line => line.netSuiteOrderLine), [10, 17]);
});

test("U7 malformed order or live source identities fail with a reviewable conflict", () => {
  for (const id of [0, -1, NaN, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => mapStoredReturnSalesOrderLines({ ...order(), id }, rows()), missing);
    const live = order();
    live.lines[0].sourceLineId = id;
    assert.throws(() => mapStoredReturnSalesOrderLines(live, rows()), missing);
  }
  assert.throws(() => mapStoredReturnSalesOrderLines({ ...order(), lines: [] }, []), missing);
});

test("generated G1 complete exact mappings preserve quantities and map both bounds of every saved ID", () => {
  fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 100000 }), { minLength: 1, maxLength: 20 }), ids => {
    const live = { id: 42, lines: ids.map((id, index) => ({ sourceLineId: 1000000 + index, itemId: 3026,
      suiteQlLineNumber: index + 1, salesQuantity: index + 0.25, rate: id / 100, salesUomId: 483 })) };
    const saved = live.lines.map((line, index) => ({ sales_order_id: 42, line_id: line.sourceLineId,
      item_id: 3026, netsuite_order_line: ids[index], netsuite_active: true })).reverse();
    const mapped = mapStoredReturnSalesOrderLines(live, saved);
    assert.equal(mapped.lines.length, live.lines.length);
    assert.deepEqual(mapped.lines.map(line => line.netSuiteOrderLine), ids);
    assert.deepEqual(mapped.lines.map(line => [line.sourceLineId, line.salesQuantity, line.rate, line.salesUomId]),
      live.lines.map(line => [line.sourceLineId, line.salesQuantity, line.rate, line.salesUomId]));
  }), { numRuns: 200, seed: 6642 });
});

test("generated G2 identity conflicts and duplicate native IDs are rejected rather than silently repaired", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }), fc.integer({ min: 1, max: 100000 }), (nativeId, itemId) => {
    const saved = rows().map(row => ({ ...row, netsuite_order_line: nativeId }));
    assert.throws(() => mapStoredReturnSalesOrderLines(order(), saved), ambiguous);
    assert.throws(() => mapStoredReturnSalesOrderLines(order(), rows().map(row => ({ ...row, item_id: itemId + 3026 }))), ambiguous);
    assert.throws(() => mapStoredReturnSalesOrderLines(order(), rows().map(row => ({ ...row, sales_order_id: itemId + 42 }))), ambiguous);
  }), { numRuns: 200, seed: 6643 });
});
