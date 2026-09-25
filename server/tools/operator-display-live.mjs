// Production smoke check: PostgreSQL enforces read-only transactions throughout.
import assert from "node:assert/strict";
import { pool, query, withTransaction, closeDb } from "/app/src/db.js";
import { getDeliveryOrder, listDeliveryOrders, listVrmaDeliveryPrepOrders } from "/app/src/delivery-repository.js";

pool.options.options = "-c jit=off -c default_transaction_read_only=on -c statement_timeout=30000";
try {
  const result = await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const groupId = "GOB-120607-120608";
    const order = await getDeliveryOrder(groupId);
    assert.ok(order, "Reported group must remain readable");
    const special = order.lines.find((line) => Number(line.item_id) === 2055);
    const pallet = order.lines.find((line) => Number(line.item_id) === 1784);
    assert.ok(special && pallet, "Both reference lines must be returned");
    assert.equal(special.no_yard_load_required, true);
    assert.equal(Number(special.original_quantity), 2332);
    assert.equal(Number(special.linked_po_sales_qty), 2332);
    assert.equal(Number(special.operator_required_sales_qty), 0);
    assert.equal(pallet.no_yard_load_required, true);
    assert.equal(Number(pallet.original_quantity), 20);
    const counts = {};
    let planned = false;
    for (const status of ["active", "packed"]) {
      const so = await listDeliveryOrders({ locationId: 1, status, orderType: "sales_order" });
      const to = await listDeliveryOrders({ locationId: 1, status, orderType: "transfer_order" });
      const vrma = await listVrmaDeliveryPrepOrders({ locationId: 1, status });
      counts[status] = { salesOrders: so.length, transferOrders: to.length, vrma: vrma.length };
      if (status === "active") planned = so.some((item) => item.netsuite_id === groupId && item.dispatch_planned);
      else assert.ok(!so.some((item) => item.netsuite_id === groupId), "References alone must not put the group into Packed");
    }
    assert.equal(planned, true, "Reference group remains in Planned");
    const allocations = (await query(`SELECT DISTINCT po_order_ref FROM dispatch_so_po_allocations
      WHERE sales_order_id=ANY($1::bigint[]) AND status='active' ORDER BY po_order_ref`, [[996632, 996634]])).rows;
    assert.ok(allocations.some((row) => String(row.po_order_ref) === "3022225167"));
    return { passed: true, readOnly: true, groupId, planned, counts, poRefs: allocations.map((row) => row.po_order_ref),
      references: [special, pallet].map((line) => ({ item: line.item_name, original: Number(line.original_quantity),
        poAllocation: Number(line.linked_po_sales_qty), yardResidual: Number(line.operator_required_sales_qty), unit: line.unit })) };
  }, { rollback: true });
  console.log(JSON.stringify(result));
} finally { await closeDb(); }
