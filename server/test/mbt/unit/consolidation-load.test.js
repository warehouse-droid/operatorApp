import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import fc from "fast-check";
import { buildConsolidationSnapshot, compareConsolidationOrders, consolidationSnapshotHash, originalConsolidationOrders } from "../../../src/consolidation-load-domain.js";

const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("../../../public/operator-load-summary.js", import.meta.url), "utf8"), context);
const summary = context.MBBS_LOAD_SUMMARY;
const physical = (values = {}) => ({ item_id: 1, item_name: "Paver", unit: "EA", to_plt: 100, to_lyr: 10,
  packed_pallet_qty: 3, packed_layer_qty: 2, packed_section_qty: 0, packed_piece_qty: 0, ...values });
const order = (id, values = {}) => ({ netsuite_id: String(id), tranid: `SOB${id}`, order_type: "sales_order",
  outbound_location_id: 1, operator_status: "packed", assignment: { planId: "7", loadId: "L1", planDate: "2026-09-15", truckPlate: "TRUCK", sequence: 1 },
  lines: [{ ...physical(), id: String(id), line_id: "1", quantity: 320, loaded_qty: 0, item_type: "InvtPart", netsuite_active: true }], ...values });

test("group expansion checks actual child yards and rejects overlapping selections", () => {
  const current = order(1), moved = order(2, { outbound_location_id: 28 });
  const group = { is_dispatch_group: true, child_orders: [current, moved] };
  assert.deepEqual(originalConsolidationOrders([group], 1, false), [current]);
  assert.throws(() => originalConsolidationOrders([group], 1, true), { code: "OPERATOR_YARD_FORBIDDEN" });
  assert.throws(() => originalConsolidationOrders([current, current], 1, true), /overlaps/);
  assert.deepEqual(originalConsolidationOrders([current, current], 1, false), [current]);
});

test("compact quantities omit every zero physical unit and preserve unit order", () => {
  assert.equal(summary.format(physical()), "3 plt 2 lyr");
  assert.equal(summary.format(physical({ packed_pallet_qty: 0, packed_layer_qty: 0, to_pcs: 1, packed_piece_qty: 0.5 })), "0.5 pcs");
});
test("missing conversions use current packed sales quantity and sales UOM", () => {
  assert.equal(summary.format({ item_name: "Bag", quantity: 50, loaded_qty: 10, packed_sales_qty: 12, packed_piece_qty: 12, unit: "EA" }), "12 EA");
  assert.equal(summary.format({ packed_sales_qty: 4, sku: "PALLET", unit: "EA" }), "4 EA");
  assert.equal(summary.format({ packed_sales_qty: 4, sku: "PALLET", unit: "EACH" }), "4 EACH");
  assert.equal(summary.format({ packed_sales_qty: 4, item_name: "PALLET", unit: "EACH" }), "4 EACH");
  const pallets = summary.rows([
    { sku: "PALLET", unit: "EACH", packed_sales_qty: 4 },
    { sku: "PALLET", unit: "BOX", packed_sales_qty: 2 }
  ]);
  assert.deepEqual(Array.from(pallets, (row) => row.quantity), ["4 EACH", "2 BOX"]);
});
test("compatible duplicate items aggregate, distinct units and conversions remain separate", () => {
  const rows = summary.rows([physical(), physical({ packed_pallet_qty: 1, packed_layer_qty: 0 }), physical({ unit: "SQFT" }), physical({ to_plt: 50 })]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].itemName, "Paver");
  assert.equal(rows[0].quantity, "4 plt 2 lyr");
});
test("snapshot preserves original line identities and accepts all local loading types", () => {
  const input = [order(1), order(2, { order_type: "transfer_order" }), order(3, { order_type: "co_order" })];
  const snapshot = buildConsolidationSnapshot(input);
  assert.equal(snapshot.orders.length, 3);
  assert.equal(snapshot.orders[1].lines[0].id, "2");
  assert.equal(snapshot.locationId, 1);
  assert.equal(consolidationSnapshotHash(snapshot).length, 64);
});
test("snapshot rejects a different physical load, yard, unplanned or repeated order", () => {
  for (const second of [order(2, { assignment: { ...order(2).assignment, loadId: "L2" } }), order(2, { outbound_location_id: 28 }), order(2, { assignment: null }), order(1)]) {
    assert.throws(() => buildConsolidationSnapshot([order(1), second]), { code: "CONSOLIDATION_LOAD_INVALID" });
  }
});
test("invalid load assignment and blocked or empty packed lines require review", () => {
  for (const selected of [order(1, { assignment: null }), order(1, { lines: [] }), order(1, { lines: [{ ...physical(), id: 1, line_id: 1, sync_exception: "Changed by NetSuite" }] })]) {
    assert.throws(() => buildConsolidationSnapshot([selected]), { code: "CONSOLIDATION_LOAD_INVALID" });
  }
});
test("selection ordering is date then truck then numeric sequence then reference", () => {
  const rows = [order(10, { assignment: { ...order(1).assignment, sequence: 10 } }), order(2), order(3, { assignment: { ...order(1).assignment, planDate: "2026-09-14" } })];
  assert.deepEqual(rows.sort(compareConsolidationOrders).map((row) => row.tranid), ["SOB3", "SOB2", "SOB10"]);
});
test("properties: compact summaries conserve compatible physical quantities", () => {
  fc.assert(fc.property(fc.array(fc.record({ p: fc.integer({ min: 0, max: 50 }), l: fc.integer({ min: 0, max: 50 }) }), { minLength: 1, maxLength: 30 }), (values) => {
    const p = values.reduce((sum, value) => sum + value.p, 0), l = values.reduce((sum, value) => sum + value.l, 0);
    const rows = summary.rows(values.map((value) => physical({ packed_pallet_qty: value.p, packed_layer_qty: value.l })));
    if (p + l === 0) return assert.equal(rows.length, 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].quantity, [p ? `${p} plt` : "", l ? `${l} lyr` : ""].filter(Boolean).join(" "));
  }), { seed: 20260915, numRuns: 250 });
});
test("properties: snapshots are stable under selection reorder and sensitive to changed packed quantity", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 99 }), (p) => {
    const a = order(1), b = order(2);
    assert.equal(consolidationSnapshotHash(buildConsolidationSnapshot([a, b])), consolidationSnapshotHash(buildConsolidationSnapshot([b, a])));
    const changed = order(1); changed.lines[0].packed_pallet_qty += p;
    assert.notEqual(consolidationSnapshotHash(buildConsolidationSnapshot([a, b])), consolidationSnapshotHash(buildConsolidationSnapshot([changed, b])));
    assert.throws(() => buildConsolidationSnapshot([a, { ...b, assignment: { ...b.assignment, loadId: `other-${p}` } }]), { code: "CONSOLIDATION_LOAD_INVALID" });
  }), { seed: 20260915, numRuns: 100 });
});
