import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { destinationFunctions } from "../../support/dispatch-po-line-destination-functions.mjs";
import { uniqueDispatchLocations } from "../../../src/dispatch-location.js";
import { dispatchRequiredPickupVisitLocations } from "../../../src/dispatch-pickup-visits.js";
import { stripDispatchRelationshipProjections, reconcileAuthoritativeDispatchOrderProjection } from "../../../src/dispatch-plan-order-projection.js";

const GROUP = "GOM-6255S2-6256S2-6662-6663";
const VENDOR = "TECHO BLOC Vaughan";
const members = [
  ["SOM06663", 473697, 1784, 2, 0, "LOINC-036776"],
  ["SOM06662", 473646, 2055, 270.78, 2, "LOINC-036776"],
  ["SOM06256-S2", 412412, 2055, 52.75, 0, "LOINC-035332"],
  ["SOM06255-S2", 412406, 2055, 1274.4, 0, "LOINC-035332"]
];

function fixture() {
  const children = members.map(([id, lineRowId, itemId, quantity, pallets]) => ({
    id, type: "SO", originalOrderId: id.split("-S")[0], sourceYard: "150", pickupLocations: ["150"],
    items: [{ lineRowId, itemId, quantity, pallets, itemName: itemId === 2055 ? "MBBS-Special Order" : "PALLET" }]
  }));
  return { id: GROUP, type: "SO", sourceYard: "150", pickupLocations: ["150"],
    childOrders: children.map(child => child.id), childOrderDetails: children,
    items: children.flatMap(child => child.items) };
}

function allocations() {
  return members.map(([ref, line, item, quantity, , po], index) => ({
    id: 216 + index, status: "active", dispatch_target_ref: ref, sales_order_ref: ref,
    dispatch_target_line_key: `${ref}::${ref}::${line}`, po_order_ref: po,
    po_line_id: index + 10, po_vendor_yard: VENDOR, item_id: item, allocated_sales_qty: quantity
  }));
}

function repository(rows) {
  return destinationFunctions("../../src/dispatch-repository.js", [
    "positiveQuantity", "isMbbsSpecialLine", "allocationDetails", "dispatchItemLineIdentities",
    "allocationMatchesDispatchItem", "allocatedDispatchPhysicalQuantity", "selectedServiceSalesLines",
    "selectedDirectServicePoLineIds", "applyTargetPoAllocationsToOrder", "enrichDispatchOrdersWithPoTargetAllocations"
  ], {
    MBBS_SPECIAL_ITEM_ID: 2055, uniqueDispatchLocations,
    poPickupSql: { location: "po.vendor", address: "po.dispatch_address", joins: "" },
    query: async (sql, [refs]) => {
      assert.match(sql, /allocation.status = 'active'/u);
      return { rows: structuredClone(rows.filter(row => row.status === "active" && (
        refs.includes(row.dispatch_target_ref.toLowerCase()) || refs.includes(row.po_order_ref.toLowerCase())
      ))) };
    }
  });
}

async function project(order = fixture(), rows = allocations()) {
  return (await repository(rows).enrichDispatchOrdersWithPoTargetAllocations(stripDispatchRelationshipProjections([order])))[0];
}

function manifestQuantity(order) {
  return (order.poPickupManifest || []).flatMap(entry => entry.items).reduce((sum, item) => sum + item.quantity, 0);
}

test("member links survive grouping and eliminate the fully allocated 150 pickup", async () => {
  const input = fixture();
  const before = structuredClone(input);
  const result = await project(input);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(result), [VENDOR]);
  assert.deepEqual(result.items.map(item => item.poAllocatedSalesQty), [2, 270.78, 52.75, 1274.4]);
  assert.equal(result.items[1].poAllocatedPallets, 2);
  assert.deepEqual(result.poPickupManifest.map(entry => entry.poOrderRef).sort(), ["LOINC-035332", "LOINC-036776"]);
  assert.equal(result.poPickupManifest.flatMap(entry => entry.items).length, 4);
  assert.deepEqual(input, before);
});

test("partial member allocation retains both the vendor and 150 residual pickups", async () => {
  const rows = allocations();
  rows[1].allocated_sales_qty /= 2;
  const result = await project(fixture(), rows);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(result), ["150", VENDOR]);
  assert.equal(result.items[1].poAllocatedPallets, 1);
});

test("mixed group and child target links are each counted once despite duplicate membership aliases", async () => {
  const source = fixture();
  source.childOrders.push(...source.childOrders.map(ref => ` ${ref.toLowerCase()} `));
  const rows = allocations();
  rows[0].dispatch_target_ref = GROUP;
  rows[0].dispatch_target_line_key = `${GROUP}::SOM06663::473697`;
  const result = await project(source, rows);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(result), [VENDOR]);
  assert.equal(manifestQuantity(result), 1599.93);
  assert.equal(result.poPickupManifest.flatMap(entry => entry.items).length, 4);
});

test("nested groups preserve leaf member PO links", async () => {
  const inner = fixture();
  const outer = { ...inner, id: "GOM-OUTER", childOrders: [inner.id], childOrderDetails: [inner] };
  const result = await project(outer);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(result), [VENDOR]);
  assert.equal(manifestQuantity(result), 1599.93);
});

test("S2 never inherits S1 or parent allocations, and CO source children do not gain SO cargo", async () => {
  const input = fixture();
  const unrelated = ["SOM06255", "SOM06255-S1"].map((ref, index) => ({ ...allocations()[3], id: 300 + index,
    dispatch_target_ref: ref, dispatch_target_line_key: `${ref}::${ref}::412406`, allocated_sales_qty: 999 }));
  const result = await project(input, [...allocations(), ...unrelated]);
  assert.equal(manifestQuantity(result), 1599.93);
  assert.equal(result.items.at(-1).poAllocatedSalesQty, 1274.4);
  const co = await project({ ...input, id: `CO-${GROUP}`, type: "CO" }, allocations());
  assert.equal(co.poPickupManifest, undefined);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(co), ["150"]);
});

test("cancelled member links disappear during authoritative refresh", async () => {
  const enriched = await project();
  const rows = allocations().map(row => ({ ...row, status: "cancelled" }));
  const cleared = await project(enriched, rows);
  assert.equal(cleared.poPickupManifest, undefined);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(cleared), ["150"]);
  assert.ok(cleared.items.every(item => item.poAllocatedSalesQty === undefined));
});

test("reopening the corrected route requires no extra pickup before the customer drop", async () => {
  const projected = await project();
  const plan = { orders: [projected], trucks: [{ id: "T5", loads: [{ id: "L2", stops: [
    { id: "vendor", type: "pick", location: VENDOR, orderId: GROUP, orderRefs: [GROUP] },
    { id: "customer", type: "drop", orderId: GROUP, location: "Customer" }
  ] }] }] };
  const fresh = await project(plan.orders[0]);
  const saved = reconcileAuthoritativeDispatchOrderProjection({ plan, projectedOrders: [fresh] }).plan;
  assert.deepEqual(saved.trucks[0].loads[0].stops.map(stop => stop.id), ["vendor", "customer"]);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(saved.orders[0]), [VENDOR]);
});

test("generated member allocations conserve quantities and stay idempotent across reloads", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 4, maxLength: 4 }), async fractions => {
    const source = fixture();
    const rows = allocations().map((row, index) => ({ ...row, allocated_sales_qty: row.allocated_sales_qty * fractions[index] / 100 }));
    const result = await project(source, rows);
    const repeated = await project(result, rows);
    assert.deepEqual(repeated, result);
    assert.deepEqual(result.items.map(item => item.quantity), source.items.map(item => item.quantity));
    assert.deepEqual(result.items.map(item => item.poAllocatedSalesQty), rows.map(row => row.allocated_sales_qty));
    assert.equal(manifestQuantity(result), rows.reduce((sum, row) => sum + row.allocated_sales_qty, 0));
    assert.deepEqual(dispatchRequiredPickupVisitLocations(result), [
      ...(fractions.some(value => value < 100) ? ["150"] : []),
      ...(fractions.some(value => value > 0) ? [VENDOR] : [])
    ]);
  }), { seed: 62556256, numRuns: 150 });
});
