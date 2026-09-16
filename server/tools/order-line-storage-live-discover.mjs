// Read-only discovery; executed inside the live application container.
import { suiteqlAll } from "/app/src/netsuite.js";
import { query, withTransaction, pool } from "/app/src/db.js";

try {
  const local = await withTransaction(async () => {
    await query("SET TRANSACTION READ ONLY");
    return (await query(`SELECT 'SO' AS kind,netsuite_id,tranid,status,status_text FROM sales_orders o
      WHERE netsuite_id>0 AND COALESCE(to_jsonb(o)->>'is_test_fixture','false')='false'
      UNION ALL SELECT 'PO',netsuite_id,tranid,status,status_text FROM purchase_orders o
      WHERE netsuite_id>0 AND COALESCE(to_jsonb(o)->>'is_test_fixture','false')='false'
      UNION ALL SELECT 'TO',netsuite_id,tranid,status,status_text FROM transfer_orders o
      WHERE netsuite_id>0 AND COALESCE(to_jsonb(o)->>'is_test_fixture','false')='false'`)).rows;
  });
  const remote = await suiteqlAll(`SELECT t.id,t.type,t.tranid,t.status,BUILTIN.DF(t.status) AS status_text
    FROM transaction t WHERE t.type IN ('SalesOrd','PurchOrd','TrnfrOrd')
      AND (UPPER(BUILTIN.DF(t.status)) LIKE '%PENDING%' OR UPPER(BUILTIN.DF(t.status)) LIKE '%PARTIALLY%')
    ORDER BY t.type,t.id`);
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), local, remote }));
} finally {await pool.end();}
