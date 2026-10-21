// Read-only diagnostic collection. Execute in the existing production app runtime.
import { query, closeDb } from '/app/src/db.js';
import { suiteqlAll } from '/app/src/netsuite.js';

const startedAt = new Date().toISOString();
try {
  const items = (await query(`SELECT item_id,item_name,stock_unit,purchase_unit,item_weight,raw
    FROM inventory_items WHERE item_name ILIKE '%aggregate%' OR product_type ILIKE '%aggregate%' ORDER BY item_id`)).rows;
  const itemIds = items.map(item => Number(item.item_id));
  const local = {};
  for (const [kind, table, orderTable, key] of [
    ['SO', 'sales_order_lines', 'sales_orders', 'sales_order_id'],
    ['PO', 'purchase_order_lines', 'purchase_orders', 'purchase_order_id'],
    ['TO', 'transfer_order_lines', 'transfer_orders', 'transfer_order_id']
  ]) {
    const result = await query(`SELECT l.*,o.tranid,o.trandate,o.status AS order_status,o.status_text AS order_status_text,
      o.netsuite_active AS order_active FROM ${table} l JOIN ${orderTable} o ON o.netsuite_id=l.${key}
      WHERE l.item_id=ANY($1::bigint[]) OR l.item_name ILIKE '%aggregate%' ORDER BY o.netsuite_id,l.line_id`, [itemIds]);
    local[kind] = result.rows;
    console.error(`${kind}: ${result.rows.length} local lines`);
  }
  const sourceItems = await suiteqlAll(`SELECT i.id,i.itemid,i.isinactive,i.unitstype,
    i.stockunit AS stock_unit_id,BUILTIN.DF(i.stockunit) AS stock_unit,
    i.saleunit AS sales_unit_id,BUILTIN.DF(i.saleunit) AS sales_unit,
    i.purchaseunit AS purchase_unit_id,BUILTIN.DF(i.purchaseunit) AS purchase_unit,
    i.weight AS item_weight FROM item i WHERE UPPER(i.itemid) LIKE '%AGGREGATE%' OR i.id IN (${itemIds.join(',')}) ORDER BY i.id`);
  const allItemIds = [...new Set([...itemIds,...sourceItems.map(item=>Number(item.id))])];
  const source = await suiteqlAll(`SELECT t.id AS order_id,t.tranid,t.type AS order_type,t.trandate,t.status,
    BUILTIN.DF(t.status) AS status_text,tl.uniquekey AS line_id,tl.id AS order_line,
    tl.item AS item_id,BUILTIN.DF(tl.item) AS item_name,tl.quantity,
    tl.quantitycommitted AS committed_quantity,tl.quantitybackordered AS backordered_quantity,
    tl.quantityshiprecv AS progress_quantity,tl.rate,tl.foreignamount AS amount,
    tl.units AS unit_id,BUILTIN.DF(tl.units) AS unit,uom.conversionrate AS conversion_rate,
    tl.location AS location_id,tl.isclosed AS line_closed
    FROM transaction t JOIN transactionline tl ON tl.transaction=t.id
    LEFT JOIN UnitsTypeUom uom ON uom.internalid=tl.units
    WHERE t.type IN ('SalesOrd','PurchOrd','TrnfrOrd') AND tl.item IN (${allItemIds.join(',')})
      AND tl.mainline='F' AND (tl.taxline='F' OR tl.taxline IS NULL)
    ORDER BY t.id,tl.uniquekey`);
  console.error(`NetSuite: ${source.length} aggregate source lines across all dates`);
  console.log(JSON.stringify({startedAt,collectedAt:new Date().toISOString(),items,sourceItems,local,source},null,2));
} finally {
  await closeDb();
}
