import assert from "node:assert/strict";
import test, { after } from "node:test";
import { query, withTransaction, closeDb } from "../../../src/db.js";
import { getDeliveryOrder, listDeliveryOrders, confirmDeliveryLine, confirmDeliveryLines,
  setDeliveryLinePackedQuantity } from "../../../src/delivery-repository.js";
import { getLocalCoOrder } from "../../../src/dispatch-repository.js";
import { applyLocalCoCargo } from "../../../src/dispatch-local-co-cargo.js";
import { referenceCo } from "../../support/co-supply-reference-fixture.mjs";
import { seedOperatorPickup } from "../../support/operator-ui-enhancements-fixture.mjs";
import { sources } from "../../support/co-direct-to-fixture.mjs";

after(closeDb);
const rollback = run => withTransaction(run, { rollback: true });

test("CO delivery retains fully supplied Trevista as a non-packable reference without changing cargo", () => rollback(async () => {
  const f = await referenceCo();
  const before = await getLocalCoOrder(f.co.co_ref);
  const beforeSources = await sources(f);
  const detail = await getDeliveryOrder(f.co.co_ref);
  const reference = detail.lines.find(row => Number(row.item_id) === 1356);
  assert.ok(reference, "Trevista reference must be visible");
  assert.equal(reference.original_quantity, 52.25);
  assert.equal(reference.linked_direct_to_sales_qty, 52.25);
  assert.equal(reference.original_layer_qty, 5);
  assert.equal(reference.linked_direct_to_layer_qty, 5);
  assert.equal(reference.operator_required_sales_qty, 0);
  assert.equal(reference.quantity, 0);
  assert.equal(reference.no_yard_load_required, true);
  assert.equal(reference.linked_supply_label, "No yard load required—direct supply");
  const pallet = detail.lines.find(row => Number(row.item_id) === 1784);
  assert.equal(pallet.original_quantity, 7);
  assert.equal(pallet.linked_direct_to_sales_qty, 1);
  assert.equal(pallet.quantity, 6);
  assert.equal(pallet.no_yard_load_required, false);
  for (const status of ["active", "packed"]) {
    const card = (await listDeliveryOrders({ locationId: 26, status })).find(row => row.tranid === f.co.co_ref);
    assert.equal(card.line_count, 7);
    assert.equal(card.underpack_count, 1);
  }
  assert.equal(detail.lines.filter(row => row.confirmed_at).length, 5);
  assert.deepEqual(await getLocalCoOrder(f.co.co_ref), before);
  assert.deepEqual(await sources(f), beforeSources);
  const cargo = applyLocalCoCargo({ id: f.co.co_ref }, { coRef: f.co.co_ref, cargoLines: before.lines });
  assert.equal(cargo.items.length, 6);
  assert.equal(cargo.items.some(row => Number(row.itemId) === 1356), false);
  assert.equal(cargo.items.find(row => Number(row.itemId) === 1784).quantity, 6);
}));

for (const [name, write] of [["confirm", confirmDeliveryLine], ["absolute update", setDeliveryLinePackedQuantity]]) {
  test(`${name} rejects fully supplied CO line and rolls back ownership, confirmations and audit`, () => rollback(async () => {
    const f = await referenceCo();
    const operator = (await seedOperatorPickup()).operator;
    const before = await getLocalCoOrder(f.co.co_ref);
    const material = before.lines.find(row => Number(row.item_id) === 1356);
    const audits = async () => (await query("SELECT * FROM delivery_audit_log WHERE order_id=$1 ORDER BY id", [f.co.delivery_order_id])).rows;
    const beforeAudits = await audits();
    await assert.rejects(write(f.co.delivery_order_id, material.id, { layers: 5, salesQty: 52.25 }, operator.id),
      error => error.code === "DELIVERY_NO_YARD_LOAD_REQUIRED" && error.status === 409);
    assert.deepEqual(await getLocalCoOrder(f.co.co_ref), before);
    assert.deepEqual(await audits(), beforeAudits);
  }));
}

test("page confirmation reports reference failure and packs only the six residual pallets", () => rollback(async () => {
  const f = await referenceCo();
  const operator = (await seedOperatorPickup()).operator;
  const before = await getLocalCoOrder(f.co.co_ref);
  const material = before.lines.find(row => Number(row.item_id) === 1356);
  const pallet = before.lines.find(row => Number(row.item_id) === 1784);
  const result = await confirmDeliveryLines(f.co.delivery_order_id, [
    { lineId: material.id, values: { layers: 5 } }, { lineId: pallet.id, values: { salesQty: 6 } }
  ], operator.id);
  assert.equal(result.confirmed, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(String(result.failures[0].lineId), String(material.id));
  assert.equal(result.failures[0].error, "TREVISTA requires no Operator yard load because its full quantity is direct supplied.");
  const updated = await getLocalCoOrder(f.co.co_ref);
  assert.deepEqual(updated.lines.find(row => String(row.id) === String(material.id)), material);
  assert.equal(Number(updated.lines.find(row => String(row.id) === String(pallet.id)).packed_sales_qty), 6);
  assert.deepEqual(updated.lines.filter(row => Number(row.packed_piece_qty) > 0), before.lines.filter(row => Number(row.packed_piece_qty) > 0));
}));

test("loaded CO underpacking is not mislabeled as direct supply", () => rollback(async () => {
  const f = await referenceCo();
  await query("UPDATE local_co_orders SET status='loaded',loaded_at=now() WHERE id=$1", [f.co.id]);
  await query("UPDATE local_co_order_lines SET quantity=4,packed_sales_qty=4 WHERE co_id=$1 AND item_id=1784", [f.co.id]);
  const detail = await getDeliveryOrder(f.co.co_ref);
  const pallet = detail.lines.find(row => Number(row.item_id) === 1784);
  assert.equal(Number(pallet.quantity), 4);
  assert.equal(pallet.no_yard_load_required, undefined);
  assert.equal(pallet.linked_direct_to_sales_qty, undefined);
  assert.equal(detail.lines.some(row => Number(row.item_id) === 1356), false);
}));
