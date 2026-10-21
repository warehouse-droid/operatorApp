// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { projectLinkedDirectShipAllocations } from "../../../src/linked-direct-ship-sync-domain.js";

const target = (id, quantity = 90, extra = {}) => ({ salesLineId: id, targetLineKey: `GROUP::SO::${id}`,
  sourceOrderRef: "SO", itemId: 1189, itemName: "Parkwall", unit: "PC", quantity,
  pallets: 1, layers: 0, sections: 0, pieces: 30, toPlt: 60, toLyr: 0, toSec: 0, toPcs: 1, ...extra });
const source = (id, quantity = 90, extra = {}) => ({ id, line_stage: "outbound", item_id: 1189,
  item_name: "Parkwall", unit: "PC", quantity, netsuite_active: true, ...extra });

test("full matching TO quantities replace the old shortage and include new material and group PALLET demand", () => {
  const result = projectLinkedDirectShipAllocations({ targetLines: [target(1),
    target(2, 91.88, { itemId: 3632, unit: "SQFT", pallets: 1, pieces: 0, toPlt: 91.88, toLyr: 10.21, toPcs: 0 }),
    target(3, 14, { itemId: 1784, itemName: "PALLET", unit: "EACH", pallets: 0, pieces: 0,
      toPlt: 0, toPcs: 0, loadedQuantity: 11 })], sourceLines: [source(11),
    source(12, 91.88, { item_id: 3632, unit: "SQFT" }), source(13, 3, { item_id: 1784, unit: "EACH" })],
  existingLines: [{ id: 21, sales_line_id: 1, dispatch_target_line_key: "GROUP::SO::1", allocated_quantity: 6 }] });
  assert.deepEqual(result.map(line => [line.sales_line_id, line.allocated_quantity, line.pallet_qty, line.piece_qty]),
    [[1, 90, 1, 30], [2, 91.88, 1, 0], [3, 3, 0, 0]]);
  assert.equal(result[0].id, 21);
});

test("other allocations and recorded yard loads bound direct coverage", () => {
  const [line] = projectLinkedDirectShipAllocations({ targetLines: [target(1, 100, { loadedQuantity: 10, pallets: 0, pieces: 100, toPlt: 0 })],
    sourceLines: [source(11, 100)], otherAllocations: [{ sales_line_id: 1, allocated_quantity: 20 },
      { sales_line_id: 1, allocated_sales_qty: 15 }] });
  assert.equal(line.allocated_quantity, 55);
  assert.equal(line.piece_qty, 55);
});

test("duplicate source and target item rows conserve supply and prefer existing exact source identities", () => {
  const result = projectLinkedDirectShipAllocations({ targetLines: [target(1, 10, { pallets: 0, pieces: 10 }),
    target(2, 10, { pallets: 0, pieces: 10 })], sourceLines: [source(11, 6), source(12, 9)],
  existingLines: [{ id: 21, sales_line_id: 2, dispatch_target_line_key: "GROUP::SO::2", transfer_outbound_line_id: 12 }] });
  assert.equal(result.find(line => line.sales_line_id === 2)?.allocated_quantity, 10);
  assert.equal(result.find(line => line.sales_line_id === 1)?.allocated_quantity, 5);
  assert.equal(result.reduce((sum, line) => sum + line.allocated_quantity, 0), 15);
});

test("inactive and unit-mismatched supply leaves no coverage and retires the old allocation", () => {
  const result = projectLinkedDirectShipAllocations({ targetLines: [target(1)], sourceLines: [source(11, 90, { netsuite_active: false }),
    source(12, 90, { unit: "SQFT" })], existingLines: [{ id: 21, sales_line_id: 1,
      line_role: "sales_allocation", dispatch_target_line_key: "GROUP::SO::1", allocated_quantity: 6 }] });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 21);
  assert.equal(result[0].allocated_quantity, 0);
});

test("invalid quantities are rejected instead of silently hiding demand", () => {
  for (const quantity of [NaN, Infinity, -1]) {
    assert.throws(() => projectLinkedDirectShipAllocations({ targetLines: [target(1, quantity)], sourceLines: [source(11)] }),
      error => error.code === "LINKED_DIRECT_SHIP_QUANTITY_INVALID");
  }
});

test("changed SO and TO line numbers rebind existing direct-ship allocation by item and unit", () => {
  const [line] = projectLinkedDirectShipAllocations({ targetLines: [target(100)], sourceLines: [source(200)],
    existingLines: [{ id: 21, sales_line_id: 999, item_id: 1189, unit: "PC", line_role: "sales_allocation",
      dispatch_target_line_key: "GROUP::SO::999", transfer_outbound_line_id: 888, allocated_quantity: 6 }] });
  assert.equal(line.id,21);
  assert.equal(line.sales_line_id,100);
  assert.equal(line.transfer_outbound_line_id,200);
  assert.equal(line.dispatch_target_line_key,"GROUP::SO::100");
  assert.equal(line.allocated_quantity,90);
});

test("generated quantities satisfy both conservation and maximal matching coverage", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 10000 }), fc.integer({ min: 0, max: 10000 }),
    fc.integer({ min: 0, max: 10000 }), fc.integer({ min: 0, max: 10000 }), (demand, supply, loaded, other) => {
      const input = { targetLines: [target(1, demand, { loadedQuantity: loaded, pallets: 0, pieces: demand, toPlt: 0 })],
        sourceLines: [source(11, supply)], otherAllocations: [{ sales_line_id: 1, allocated_quantity: other }] };
      const result = projectLinkedDirectShipAllocations(input);
      const allocated = result.reduce((sum, line) => sum + line.allocated_quantity, 0);
      assert.equal(allocated, Math.min(supply, Math.max(0, demand - loaded - other)));
      assert.deepEqual(projectLinkedDirectShipAllocations(input), result);
    }), { seed: 101722967, numRuns: 1000 });
});

test("new matching sales lines cannot consume quantities reserved as manual transfer cargo", () => {
  const result=projectLinkedDirectShipAllocations({targetLines:[target(1,8,{pallets:0,pieces:8})],
    sourceLines:[source(11,9)],existingLines:[{id:22,item_id:1189,unit:"PC",line_role:"manual_transfer",allocated_quantity:5}]});
  assert.equal(result.find(line => line.sales_line_id===1)?.allocated_quantity,4);
  assert.equal(result.some(line => line.id===22),false);
});

test("duplicate matching group items keep the allocation on its current source row", () => {
  const result=projectLinkedDirectShipAllocations({targetLines:[target(1,10,{pallets:0,pieces:10}),target(2,10,{pallets:0,pieces:10})],
    sourceLines:[source(11,10)],existingLines:[{id:22,sales_line_id:2,item_id:1189,unit:"PC",line_role:"sales_allocation",
      dispatch_target_line_key:"GROUP::SO::2",allocated_quantity:6}]});
  assert.equal(result.find(line => line.id===22)?.sales_line_id,2);
  assert.equal(result.find(line => line.id===22)?.allocated_quantity,10);
});

test("partial mixed PLT and PCS coverage preserves the physical quantity equation", () => {
  const [line]=projectLinkedDirectShipAllocations({targetLines:[target(1)],sourceLines:[source(11,55)]});
  assert.ok(Math.abs(line.pallet_qty*60+line.piece_qty-55)<0.0001);
  assert.ok(line.pallet_qty<=1 && line.piece_qty<=30);
});

test("removed sales items release current coverage while ancillary PALLET quantities follow current supply", () => {
  const result=projectLinkedDirectShipAllocations({targetLines:[target(1)],sourceLines:[source(11),source(12,3,{item_id:1784,unit:"EACH"})],
    existingLines:[{id:22,sales_line_id:2,item_id:3632,unit:"SQFT",line_role:"sales_allocation",allocated_quantity:91.88,delivered_quantity:5},
      {id:23,item_id:1784,unit:"EACH",line_role:"pallet",allocated_quantity:2,piece_qty:2}]});
  assert.equal(result.find(line => line.id===22)?.allocated_quantity,0);
  assert.equal(result.find(line => line.id===22)?.delivered_quantity,5);
  assert.equal(result.find(line => line.id===23)?.allocated_quantity,3);
  assert.equal(result.find(line => line.id===23)?.piece_qty,3);
});
