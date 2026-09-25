// Read-only production verification: no repair or packing writes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { query, withTransaction, closeDb } from "../src/db.js";
import { getDeliveryOrder, listDeliveryOrders, validateConsolidatedDeliveryOrder } from "../src/delivery-repository.js";
import { getDispatchPlan } from "../src/dispatch-plan-repository.js";
import { pickupUi } from "../test/support/direct-to-same-yard-fixture.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const packedFields = ["packed_pallet_qty", "packed_layer_qty", "packed_section_qty", "packed_piece_qty", "packed_sales_qty"];
const isPacked = row => packedFields.some(field => Number(row[field]) > 0);

async function snapshot() {
  const state = {};
  for (const [key, sql] of [
    ["sourceLines", "SELECT * FROM sales_order_lines WHERE sales_order_id=995146 ORDER BY id"],
    ["co", "SELECT * FROM local_co_orders WHERE co_ref='CO-SOA08838'"],
    ["coLines", "SELECT * FROM local_co_order_lines WHERE co_id=183 ORDER BY id"],
    ["transferLines", "SELECT * FROM transfer_order_lines WHERE transfer_order_id=995267 ORDER BY id"],
    ["dependencies", "SELECT * FROM order_dependencies WHERE sales_order_ref='SOA08838' ORDER BY id"],
    ["allocations", "SELECT l.* FROM order_dependency_lines l JOIN order_dependencies d ON d.id=l.dependency_id WHERE d.sales_order_ref='SOA08838' ORDER BY l.id"],
    ["plans", "SELECT p.id,p.revision,s.orders,s.trucks FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id IN (328,329) ORDER BY p.id"]
  ]) {state[key] = (await query(sql)).rows;}
  return state;
}

async function verifyOperator() {
  const detail = await getDeliveryOrder("CO-SOA08838");
  assert.equal(detail.lines.length, 7);
  assert.equal(detail.lines.filter(isPacked).length, 5);
  const material = detail.lines.find(row => Number(row.item_id) === 1356);
  const pallet = detail.lines.find(row => Number(row.item_id) === 1784);
  assert.equal(material.original_quantity, 52.25);
  assert.equal(material.linked_direct_to_sales_qty, 52.25);
  assert.equal(material.quantity, 0);
  assert.equal(material.layer_qty, 0);
  assert.equal(material.no_yard_load_required, true);
  assert.equal(material.linked_supply_label, "No yard load required—direct supply");
  assert.equal(pallet.original_quantity, 7);
  assert.equal(pallet.linked_direct_to_sales_qty, 1);
  assert.equal(pallet.quantity, 6);
  assert.equal(pallet.no_yard_load_required, false);
  for (const status of ["packed", "active"]) {
    const card = (await listDeliveryOrders({ locationId: 26, status, orderType: "sales_order" }))
      .find(row => row.tranid === "CO-SOA08838");
    assert.ok(card, `CO missing from ${status}`);
    assert.equal(card.underpack_count, 1);
    assert.equal(card.line_count, 7);
  }
  assert.equal(validateConsolidatedDeliveryOrder(detail).ok, true);
  return { displayedLines: 7, packedLines: 5, trevista: { original: 52.25, directTo: 52.25, required: 0,
    notice: material.linked_supply_label }, pallets: { original: 7, directTo: 1, required: 6 },
  packedVisible: true, activeVisible: true, loadValidation: "passed" };
}

async function verifyDispatch() {
  const coPlan = await getDispatchPlan(328);
  const co = coPlan.orders.find(order => order.id === "CO-SOA08838");
  assert.equal(co.items.length, 6);
  assert.equal(co.items.some(item => Number(item.itemId) === 1356), false);
  assert.equal(Number(co.items.find(item => Number(item.itemId) === 1784).quantity), 6);
  const soPlan = await getDispatchPlan(329);
  const so = soPlan.orders.find(order => order.id === "SOA08838");
  const ui = pickupUi();
  const pickup = ui.tooltipItemsForOrder(so, { pickupLocation: "3445" });
  const drop = ui.tooltipItemsForOrder(so, { stop: { type: "drop" } });
  assert.equal(Number(drop.find(item => Number(item.itemId) === 1356).quantity), 52.25);
  assert.equal(Number(drop.find(item => Number(item.itemId) === 1784).quantity), 7);
  assert.equal(pickup.filter(item => Number(item.itemId) === 1784).reduce((sum, item) => sum + Number(item.quantity), 0), 7);
  const html = ui.tooltipItemRowsForOrder(so, { pickupLocation: "3445", includeOrderHeader: true });
  assert.equal((html.match(/<b>TOB01102<\/b>/gu) || []).length, 1);
  assert.deepEqual([Number(coPlan.revision), Number(soPlan.revision)], [44, 35]);
  return { coCargoLines: 6, toPickupHeaderCount: 1, customerPallets: 7, planRevisions: [44, 35] };
}

try {
  const report = await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const before = await snapshot();
    const views = await verifyOperator();
    const dispatch = await verifyDispatch();
    assert.deepEqual(await snapshot(), before);
    assert.equal(before.coLines.filter(isPacked).length, 5);
    assert.equal(before.sourceLines.some(isPacked), false);
    assert.equal(before.sourceLines.some(row => row.confirmed || row.confirmed_at), false);
    return { readOnly: true, canonicalHash: hash(before), ...views, dispatch };
  });
  console.log(JSON.stringify(report));
} finally {await closeDb();}
