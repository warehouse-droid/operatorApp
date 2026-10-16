import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { closeDb } from "../../../src/db.js";
import { resolveSalesUnsplitFamily } from "../../../src/dispatch-sales-resplit-repository.js";
import { materializeSalesSplitOrder } from "../../../src/delivery-repository.js";

after(closeDb);
const root = "SOA01234";

test("a restored split cannot overwrite a positive NetSuite identity", async () => {
  await assert.rejects(materializeSalesSplitOrder({ id: `${root}-S2` }, {}, { existingSplitId: 123 }), /negative local order ID/u);
});
function definition(suffix, source = "", active = true) {
  const ref = `${root}-S${suffix}`;
  return { split_ref: ref, parent_order_ref: root, active,
    full_order: { id: ref, type: "SO", originalOrderId: root, resplitSourceOrderId: source } };
}
function nested(count = 2) {
  const first = definition(1), source = definition(2, "", false);
  const children = Array.from({ length: count }, (_value, index) => definition(index + 3, source.split_ref));
  source.full_order.resplitReplacement = { result: { orders: children.map(row => row.full_order) } };
  return [first, source, ...children];
}

test("S1/S2 resolve as one original SO group, regardless of the selected part", () => {
  const rows = [definition(1), definition(2)];
  for (const row of rows) {
    const group = resolveSalesUnsplitFamily(rows, row.split_ref);
    assert.equal(group.restoreRef, root);
    assert.deepEqual(group.siblings.map(item => item.split_ref), rows.map(item => item.split_ref));
  }
});

test("S3/S4 resolve to S2 while delivered S1 remains outside the merge", () => {
  const rows = nested();
  rows[0].full_order.dispatchCompletionStatus = "completed";
  const group = resolveSalesUnsplitFamily(rows, `${root}-S3`);
  assert.equal(group.restoreRef, `${root}-S2`);
  assert.deepEqual(group.siblings.map(row => row.split_ref), [`${root}-S3`, `${root}-S4`]);
  assert.deepEqual(group.source, rows[1]);
});

test("a group with further-split children must be reversed from the newest generation first", () => {
  const rows = nested();
  assert.throws(() => resolveSalesUnsplitFamily(rows, `${root}-S1`), { code: "DISPATCH_UNSPLIT_DESCENDANTS" });
  rows[2].active = false;
  rows.push(definition(5, `${root}-S3`), definition(6, `${root}-S3`));
  assert.throws(() => resolveSalesUnsplitFamily(rows, `${root}-S4`), { code: "DISPATCH_UNSPLIT_DESCENDANTS" });
});

test("inactive or unknown selection and incomplete replacement sets fail closed", () => {
  const rows = nested();
  for (const ref of [`${root}-S2`, `${root}-S99`, ""]) {
    assert.throws(() => resolveSalesUnsplitFamily(rows, ref), { code: "DISPATCH_UNSPLIT_STALE" });
  }
  rows.pop();
  assert.throws(() => resolveSalesUnsplitFamily(rows, `${root}-S3`), { code: "DISPATCH_UNSPLIT_DESCENDANTS" });
});

test("missing or still-active split parents and a lone remaining child cannot restore a larger order", () => {
  const rows = nested();
  rows[1].active = true;
  assert.throws(() => resolveSalesUnsplitFamily(rows, `${root}-S3`), { code: "DISPATCH_UNSPLIT_DESCENDANTS" });
  rows.splice(1, 1);
  assert.throws(() => resolveSalesUnsplitFamily(rows, `${root}-S3`), { code: "DISPATCH_UNSPLIT_DESCENDANTS" });
  assert.throws(() => resolveSalesUnsplitFamily([definition(1)], `${root}-S1`), { code: "DISPATCH_UNSPLIT_DESCENDANTS" });
});

test("property: each complete immediate generation restores its exact parent and excludes unrelated S1", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 10 }), fc.integer({ min: 0, max: 100 }), (count, index) => {
    const rows = nested(count), before = structuredClone(rows);
    const group = resolveSalesUnsplitFamily(rows, rows[2 + index % count].split_ref.toLowerCase());
    assert.equal(group.restoreRef, `${root}-S2`);
    assert.deepEqual(group.siblings.map(row => row.split_ref).sort(), rows.slice(2).map(row => row.split_ref).sort());
    assert.deepEqual(rows, before);
  }), { seed: 20261015, numRuns: 150 });
});
