import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import fc from "fast-check";
import { readNetSuiteOrderLine, withNetSuiteOrderLines } from "../../../src/netsuite-order-line.js";

test("orderLine is an explicit REST identifier, never a unique key or array index", () => {
  assert.equal(readNetSuiteOrderLine({ line_id: 4961129, orderLine: "1" }), 1);
  for (const key of ["netsuite_order_line", "order_line", "restLineId", "rest_line_id"]) {
    assert.equal(readNetSuiteOrderLine({ [key]: "17" }), 17);
  }
  assert.equal(readNetSuiteOrderLine({ orderLine: 4, order_line: "4" }), 4);
  for (const line of [undefined, null, {}, { line_id: 4961129 }, { line: 4 }, { orderLine: null }]) {
    assert.equal(readNetSuiteOrderLine(line), null);
  }
});

test("invalid and conflicting explicit orderLine values fail closed", () => {
  for (const value of [0, -1, 1.5, true, {}, [], "1.2", "1e2", "1;SELECT", Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => readNetSuiteOrderLine({ orderLine: value }), { code: "NETSUITE_ORDER_LINE_INVALID" });
  }
  assert.throws(() => readNetSuiteOrderLine({ orderLine: 1, netsuite_order_line: 4 }), { code: "NETSUITE_ORDER_LINE_INVALID" });
});

function transferLines() {
  return [
    { sourceLineKey: "10001", sourceLineAliases: ["10001", "10002"], orderLine: 1, stage: "outbound", itemId: 77, identityStatus: "exact", logicalLineIdentity: "anchor:10001" },
    { sourceLineKey: "10003", orderLine: 3, stage: "receiving", itemId: 77, identityStatus: "exact", logicalLineIdentity: "anchor:10001" },
    { sourceLineKey: "10004", sourceLineAliases: ["10004", "10005"], orderLine: 4, stage: "outbound", itemId: 77, identityStatus: "exact", logicalLineIdentity: "anchor:10004" },
    { sourceLineKey: "10006", orderLine: 6, stage: "receiving", itemId: 77, identityStatus: "exact", logicalLineIdentity: "anchor:10004" }
  ];
}

test("TO receiving rows use the visible source anchor even when items repeat", () => {
  const lines = transferLines();
  const original = structuredClone(lines);
  assert.deepEqual(withNetSuiteOrderLines(lines, "TO").map(l => l.netsuite_order_line), [1, 1, 4, 4]);
  assert.deepEqual(lines, original);
  assert.deepEqual(withNetSuiteOrderLines([lines[1]], "TO").map(l => l.netsuite_order_line), [null]);
  assert.deepEqual(withNetSuiteOrderLines([{ ...lines[0], identityStatus: "ambiguous" }, lines[1]], "TO")
    .map(l => l.netsuite_order_line), [null, null]);
  assert.equal(withNetSuiteOrderLines([lines[0], { ...lines[0], orderLine: 2 }, lines[1]], "TO")[2].netsuite_order_line, null);
});

test("SO and PO mappings retain exact non-consecutive source line numbers", () => {
  for (const kind of ["SO", "PO"]) {
    const lines = [{ orderLine: 1, identityStatus: "exact" }, { orderLine: 17, identityStatus: "exact" },
      { orderLine: 3, identityStatus: "ambiguous" }, { identityStatus: "exact" }];
    assert.deepEqual(withNetSuiteOrderLines(lines, kind).map(l => l.netsuite_order_line), [1, 17, null, null]);
  }
  assert.throws(() => withNetSuiteOrderLines([], "INVALID"), /SO, PO, or TO/);
});

test("property: stable keys cannot change explicit orderLine, and TO mapping survives reorder", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }), fc.integer({ min: 1000001, max: 9000000 }),
    fc.shuffledSubarray([0, 1, 2, 3], { minLength: 4, maxLength: 4 }), (orderLine, key, indices) => {
      assert.equal(readNetSuiteOrderLine({ line_id: key, orderLine: String(orderLine) }), orderLine);
      assert.equal(readNetSuiteOrderLine({ line_id: key }), null);
      assert.throws(() => readNetSuiteOrderLine({ orderLine, order_line: orderLine + 1 }), { code: "NETSUITE_ORDER_LINE_INVALID" });
      const fixture = transferLines().map((line, index) => ({ ...line, orderLine: orderLine + index }));
      const shuffled = indices.map(index => fixture[index]);
      const mapped = withNetSuiteOrderLines(shuffled, "TO");
      for (const line of mapped) {
        assert.equal(line.netsuite_order_line, line.logicalLineIdentity === "anchor:10001" ? orderLine : orderLine + 2);
      }
    }), { numRuns: 200, seed: 1400333 });
});

function executeSender(file, lineNumbers) {
  const requests = [];
  let script;
  const rec = { id: 123,
    getValue: ({ fieldId }) => ({ tranid: "SO-ORDERLINE", location: 1 })[fieldId] || "",
    getText: () => "", getLineCount: () => lineNumbers.length,
    getSublistText: () => "",
    getSublistValue: ({ fieldId, line }) => ({ item: 77, itemtype: "InvtPart", lineuniquekey: 90001 + line,
      line: lineNumbers[line], quantity: 5 })[fieldId] ?? ""
  };
  const params = { custscriptmbbs_webhook_url: "https://example.invalid/webhook", custscriptwh_webhook_secret_i: "fixture",
    custscriptmbbs_wh_record_type: "salesorder", custscriptmbbs_wh_record_id: "123", custscriptmbbs_wh_event_type: "edit",
    custscriptmbbs_wh_url: "https://example.invalid/webhook", custscriptmbbs_wh_secret: "fixture" };
  vm.runInNewContext(readFileSync(file, "utf8"), { define: (_names, factory) => {
    script = factory({ post: request => { requests.push(JSON.parse(request.body)); return { code: 200 }; } },
      { debug() {}, audit() {}, error() {} }, { Type: {}, load: () => rec },
      { getCurrentScript: () => ({ getParameter: ({ name }) => params[name] }) }, { lookupFields: () => ({}) });
  } }, { filename: file });
  if (script.execute) {script.execute();} else {
    script.afterSubmit({ type: "edit", UserEventType: { DELETE: "delete", APPROVE: "approve" }, newRecord: { type: "salesorder", id: 123 } });
  }
  assert.equal(requests.length, 1);
  return requests[0].lines;
}

for (const file of ["netsuite-order-webhook-user-event-direct.js", "netsuite-order-webhook-scheduled.js"]) {
  test(`${file} sends actual non-consecutive orderLine independently of unique key`, () => {
    const lines = executeSender(file, [1, 4, 17, null]);
    assert.deepEqual(lines.map(line => line.orderLine), [1, 4, 17, null]);
    assert.deepEqual(lines.map(line => line.lineUniqueKey), [90001, 90002, 90003, 90004]);
  });
}
