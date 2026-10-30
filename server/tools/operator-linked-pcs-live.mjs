import { pool, query, withTransaction, closeDb } from '../src/db.js';
import { getDeliveryOrder } from '../src/delivery-repository.js';

pool.options.options = '-c default_transaction_read_only=on -c jit=off -c statement_timeout=20000';
try {
  const report = await withTransaction(async () => {
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const group = await getDeliveryOrder('GOA-10760-10762');
    const line = group?.lines.find(row => Number(row.item_id) === 1784);
    const original = (await query(`SELECT l.quantity,l.unit,l.piece_qty,l.loaded_qty,l.packed_sales_qty
      FROM sales_order_lines l JOIN sales_orders o ON o.netsuite_id=l.sales_order_id
      WHERE o.tranid='SOA10762' AND l.item_id=1784`)).rows;
    return { at: new Date().toISOString(), group: group?.tranid, yard: group?.outbound_location,
      underpack: group?.underpack_count, pallet: line && { sourceOrder: 'SOA10762', unit: line.unit,
        linkedPoSales: line.linked_po_sales_qty, linkedPcs: line.linked_po_piece_qty,
        requiredSales: line.operator_required_sales_qty, blocked: line.linked_quantity_blocked,
        errors: line.linked_quantity_errors }, original, readOnly: true };
  }, { rollback: true });
  console.log(JSON.stringify(report));
} finally {await closeDb();}
