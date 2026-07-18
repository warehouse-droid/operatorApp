import assert from "node:assert/strict";
import { getYardMovementDetail, listYardMovementCsvRows, listYardMovements } from "./yard-movement-repository.js";
import { yardMixedUnits } from "./yard-quantity.js";

assert.deepEqual(
  yardMixedUnits({ processed_qty: 61.5, to_plt: 61.5, to_lyr: 10.25 }).units.map(({ label, value }) => ({ label, value })),
  [{ label: "PLT", value: 1 }],
  "61.5 SQFT should decompose to exactly 1 PLT"
);
assert.deepEqual(
  yardMixedUnits({ processed_qty: 71.75, to_plt: 61.5, to_lyr: 10.25 }).units.map(({ label, value }) => ({ label, value })),
  [{ label: "PLT", value: 1 }, { label: "LYR", value: 1 }],
  "71.75 SQFT should decompose to 1 PLT and 1 LYR"
);

const range = { from: "2000-01-01", to: "2099-12-31", yard: "all" };
const movementTypes = {
  inbound: ["purchase_order", "transfer_order", "co_order"],
  outbound: ["sales_order", "transfer_order", "co_order", "vrma_order"]
};

const allMovements = [];
for (const [direction, orderTypes] of Object.entries(movementTypes)) {
  for (const orderType of orderTypes) {
    const rows = await listYardMovements({ ...range, direction, orderType });
    assert.ok(Array.isArray(rows), `${direction}/${orderType} should return an array`);
    for (const row of rows) {
      assert.equal(row.direction, direction);
      assert.equal(row.order_type, orderType);
      assert.ok(row.order_id, `${direction}/${orderType} row should retain its order ID`);
      assert.ok(row.last_processed_at, `${direction}/${orderType} row should retain its processed timestamp`);
    }
    allMovements.push(...rows);
  }
}

if (allMovements.length) {
  const movement = allMovements[0];
  const detail = await getYardMovementDetail({
    ...range,
    direction: movement.direction,
    orderType: movement.order_type,
    orderId: movement.order_id
  });
  assert.ok(detail, "Movement detail should exist for a listed movement");
  assert.equal(detail.order.direction, movement.direction);
  assert.equal(detail.order.order_type, movement.order_type);
  assert.ok(Array.isArray(detail.lines), "Movement detail should include lines");
  assert.ok(Array.isArray(detail.photos), "Movement detail should include photos");

  const searchableLine = detail.lines.find((line) => line.sku || line.item_name || line.item_description || line.item_id);
  if (searchableLine) {
    const itemTerm = searchableLine.sku || searchableLine.item_name || searchableLine.item_description || String(searchableLine.item_id);
    const itemMatches = await listYardMovements({ ...range, itemSearch: itemTerm });
    assert.ok(itemMatches.some((row) =>
      row.direction === movement.direction
      && row.order_type === movement.order_type
      && String(row.order_id) === String(movement.order_id)
    ), "Global item search should return the processed order containing that item");
  }

  const processedDate = new Date(movement.last_processed_at).toISOString().slice(0, 10);
  const csvRows = await listYardMovementCsvRows({
    from: processedDate,
    to: processedDate,
    yard: "all",
    direction: movement.direction,
    orderType: movement.order_type,
    search: movement.tranid || String(movement.order_id)
  });
  assert.ok(Array.isArray(csvRows), "CSV query should return rows");
  for (const row of csvRows) {
    assert.equal(row.direction, movement.direction);
    assert.equal(row.order_type, movement.order_type);
    assert.ok(Object.hasOwn(row, "processed_qty"));
    assert.ok(Object.hasOwn(row, "to_plt"));
    assert.ok(Object.hasOwn(row, "to_lyr"));
    assert.ok(Object.hasOwn(row, "to_sec"));
    assert.ok(Object.hasOwn(row, "to_pcs"));
  }
}

console.log(`Yard movement integration harness passed (${allMovements.length} processed orders).`);
