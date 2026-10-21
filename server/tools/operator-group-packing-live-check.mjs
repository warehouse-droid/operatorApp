import assert from "node:assert/strict";
import { query, withTransaction, closeDb } from "../src/db.js";
import { getDeliveryOrder, getCurrentOperatorDeliveryDraft } from "../src/delivery-repository.js";

try {
  const result = await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const order = await getDeliveryOrder("GOB-121625-121634");
    assert(order?.is_dispatch_group, "Affected dispatch group must exist");
    const children = (await query(`SELECT netsuite_id,tranid,operator_status,preparing_operator_id
      FROM sales_orders WHERE tranid=ANY($1::text[]) ORDER BY tranid`, [["SOB121625", "SOB121634"]])).rows;
    assert.equal(children.length, 2);
    const preparing = children.find(child => child.preparing_operator_id && child.operator_status === "preparing")
      || children.find(child => child.preparing_operator_id && child.operator_status !== "packed");
    assert.equal(order.preparing_operator_id || null, preparing?.preparing_operator_id || null);
    let draftVerified = false;
    if (preparing) {
      const draft = await getCurrentOperatorDeliveryDraft(preparing.preparing_operator_id, { locationId: 1 });
      assert.equal(draft.netsuite_id, order.netsuite_id);
      draftVerified = true;
    }
    return {
      readOnly: true, group: order.netsuite_id, status: order.operator_status,
      preparingOwnerPresent: Boolean(order.preparing_operator_id), draftVerified,
      children: children.map(({ tranid, operator_status }) => ({ order: tranid, status: operator_status })),
      lines: order.lines.filter(line => ["PALLET", "UNI-PISAS-COP-CG"].includes(line.item_name)).map(line => ({
        item: line.item_name, quantity: line.quantity,
        packedPallets: line.packed_pallet_qty, packedPieces: line.packed_piece_qty, packedSales: line.packed_sales_qty,
      })),
    };
  }, { rollback: true });
  console.log(JSON.stringify(result));
} finally {
  await closeDb();
}
