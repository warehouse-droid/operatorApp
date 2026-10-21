import { query, withTransaction, closeDb } from "./src/db.js";

try {
  const counts = await withTransaction(async () => {
    await query("SET TRANSACTION READ ONLY");
    await query("SET LOCAL statement_timeout='3s'");
    return (await query(`SELECT
      (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing')) AS posting,
      (SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing') AS driver,
      (SELECT count(*) FROM scm_dependency_action_receipts WHERE status='executing') AS scm`)).rows[0];
  });
  console.log(JSON.stringify({ count: Object.values(counts).reduce((sum, value) => sum + Number(value), 0), ...counts }));
} finally {
  await closeDb();
}
