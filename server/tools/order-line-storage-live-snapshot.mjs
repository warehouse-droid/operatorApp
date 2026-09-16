// Read-only rehearsal using the currently deployed application's credentials.
import { suiteqlAll } from "/app/src/netsuite.js";
import { query, closeDb } from "/app/src/db.js";
const tables = { SalesOrd: ["SO", "sales_order_lines", "sales_order_id"],
  PurchOrd: ["PO", "purchase_order_lines", "purchase_order_id"], TrnfrOrd: ["TO", "transfer_order_lines", "transfer_order_id"] };
try {
  const headers = await suiteqlAll(`SELECT t.id,t.type,t.tranid,BUILTIN.DF(t.status) AS status_text
    FROM transaction t WHERE t.type IN ('SalesOrd','PurchOrd','TrnfrOrd')
      AND (UPPER(BUILTIN.DF(t.status)) LIKE '%PENDING%' OR UPPER(BUILTIN.DF(t.status)) LIKE '%PARTIALLY%') ORDER BY t.id`);
  const orders = headers.filter(row => !/ : Pending Bill(?:ing)?$/u.test(row.status_text) && !String(row.tranid).startsWith("SOT"));
  console.log(JSON.stringify({ event: "headers", headers }));
  for (const [type, [kind, table, parent]] of Object.entries(tables)) {
    const ids = orders.filter(row => row.type === type).map(row => Number(row.id));
    for (let offset = 0; offset < ids.length; offset += 50) {
      const batch = ids.slice(offset, offset + 50);
      const local = (await query(`SELECT id,${parent} AS order_id,line_id,item_id,item_type,netsuite_active,
        to_jsonb(l)->>'netsuite_order_line' AS netsuite_order_line,
        to_jsonb(l)->>'netsuite_order_line_synced_at' AS netsuite_order_line_synced_at,synced_at::text
        FROM ${table} l WHERE ${parent}=ANY($1::bigint[]) ORDER BY ${parent},id`, [batch])).rows;
      const remote = await suiteqlAll(`SELECT t.id AS order_id,t.type,t.tranid,BUILTIN.DF(t.status) AS status_text,
        tl.uniquekey AS line_id,tl.id AS order_line_number,tl.id AS netsuite_order_line,
        tl.item AS item_id,tl.quantity,tl.location AS location_id,BUILTIN.DF(tl.units) AS unit,
        tl.donotprintline AS do_not_print_line,tl.linesequencenumber AS line_sequence_number
        FROM transaction t JOIN transactionline tl ON tl.transaction=t.id
        WHERE t.type='${type}' AND t.id IN (${batch.join(",")}) AND tl.item IS NOT NULL AND tl.mainline='F'
          AND (tl.taxline='F' OR tl.taxline IS NULL) ORDER BY t.id,tl.id,tl.uniquekey`);
      console.log(JSON.stringify({ event: "batch", kind, ids: batch, local, remote }));
    }
  }
} finally {await closeDb();}
