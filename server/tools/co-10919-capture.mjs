// Read-only operational snapshot. Run from /app; keep output in a private audit file.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const source = name => pathToFileURL(path.resolve('src', name)).href;
const { query, withTransaction, closeDb } = await import(source('db.js'));
const { fetchItemFulfillmentFromNetSuite, suiteqlAll } = await import(source('netsuite.js'));
const rows = async (sql, values = []) => (await query(sql, values)).rows;
try {
  const local = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    return {
      co: (await rows("SELECT * FROM local_co_orders WHERE co_ref='CO-GOA-10919-10923'"))[0],
      cargo: await rows('SELECT * FROM local_co_order_lines WHERE co_id=197 ORDER BY id'),
      orders: await rows('SELECT * FROM sales_orders WHERE netsuite_id IN(1094559,1094575) ORDER BY netsuite_id'),
      lines: await rows('SELECT * FROM sales_order_lines WHERE sales_order_id IN(1094559,1094575) ORDER BY id'),
      loads: await rows('SELECT * FROM operator_load_records WHERE order_id IN(1094559,1094575,-197) OR id IN(7159,7160) ORDER BY id'),
      candidates: await rows('SELECT * FROM dispatch_sales_order_if_candidates WHERE source_sales_order_id IN(1094559,1094575) ORDER BY id'),
      claims: await rows('SELECT * FROM dispatch_sales_order_if_line_claims WHERE source_sales_order_id IN(1094559,1094575) ORDER BY candidate_id,source_line_id'),
      postingClaims: await rows("SELECT * FROM operator_netsuite_posting_order_claims WHERE active AND local_order_key IN('delivery_prep:sales_order:1094559','delivery_prep:sales_order:1094575')"),
      reloads: await rows('SELECT * FROM operator_reload_cycles WHERE sales_order_id IN(1094559,1094575) ORDER BY id')
    };
  });
  const fulfillments = [];
  for (const id of [1095903, 1096033]) {fulfillments.push(await fetchItemFulfillmentFromNetSuite(id));}
  const transactions = await suiteqlAll(`SELECT id,tranid,type,status,BUILTIN.DF(status) AS status_text,postingperiod
    FROM transaction WHERE id IN(1094559,1094575,1095903,1096033) ORDER BY id`);
  const links = await suiteqlAll(`SELECT DISTINCT link.previousdoc,link.nextdoc,link.linktype,
    related.tranid,related.type,related.status FROM NextTransactionLineLink link
    JOIN transaction related ON related.id=link.nextdoc
    WHERE link.previousdoc IN(1094559,1094575,1095903,1096033) ORDER BY link.previousdoc,link.nextdoc`);
  console.log(JSON.stringify({ capturedAt: new Date().toISOString(), local, fulfillments, transactions, links }));
} finally {await closeDb();}
