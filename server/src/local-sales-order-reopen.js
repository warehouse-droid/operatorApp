import { query } from "./db.js";

// The immutable Control correction authorizes local work; a client flag or an
// Open header alone does not. Current physical evidence always ends the exception.
/** @param {unknown} alias */
export function locallyReopenedSalesOrderSql(alias) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(String(alias || ""))) {
    throw new TypeError("A safe sales order SQL alias is required.");
  }
  return `EXISTS (
    SELECT 1 FROM sales_orders reopened
     WHERE reopened.netsuite_id = ${alias}.netsuite_id
       AND reopened.netsuite_active = true AND reopened.netsuite_missing_at IS NULL
       AND upper(COALESCE(reopened.status, '')) NOT IN ('F','H','C')
       AND COALESCE(reopened.status_text, '') !~* '(pending billing|fulfilled|closed|cancelled|canceled)'
       AND lower(COALESCE(reopened.operator_status, '')) IN ('open','preparing','confirmed','packed')
       AND lower(COALESCE(reopened.local_yard_order_status, 'Open')) IN ('open','preparing','confirmed','packed')
       AND lower(COALESCE(reopened.fulfillment_status, 'not_fulfilled')) IN ('','open','not_fulfilled')
       AND reopened.last_item_fulfillment_id IS NULL AND reopened.fulfilled_at IS NULL
       AND EXISTS (SELECT 1 FROM operator_order_reopens correction
                    WHERE correction.order_keys @> ARRAY['sales_order:' || reopened.netsuite_id::text])
       AND NOT EXISTS (SELECT 1 FROM sales_order_lines line WHERE line.sales_order_id=reopened.netsuite_id
         AND (COALESCE(line.loaded_qty,0)>0
           OR COALESCE(line.fulfilled_pallet_qty,0)>0 OR COALESCE(line.fulfilled_layer_qty,0)>0
           OR COALESCE(line.fulfilled_section_qty,0)>0 OR COALESCE(line.fulfilled_piece_qty,0)>0))
       AND NOT EXISTS (SELECT 1 FROM delivery_fulfillment_records fulfillment
         WHERE fulfillment.order_id=reopened.netsuite_id AND fulfillment.item_fulfillment_id IS NOT NULL)
  )`;
}

/** @param {Array<string | number>} [ids] */
export async function locallyReopenedSalesOrderIds(ids = []) {
  const result = await query(`SELECT candidate.netsuite_id FROM sales_orders candidate
    WHERE candidate.netsuite_id=ANY($1::bigint[]) AND ${locallyReopenedSalesOrderSql("candidate")}`, [ids]);
  return new Set(result.rows.map((/** @type {{netsuite_id: string | number}} */ row) => String(row.netsuite_id)));
}
