// Read-only transaction status proof. SuiteQL POST executes SELECT only.
import path from "node:path";
import { pathToFileURL } from "node:url";
const source = name => pathToFileURL(path.resolve("src", name)).href;
const { pool, query, withTransaction, closeDb } = await import(source("db.js"));
pool.options.options = "-c jit=off -c default_transaction_read_only=on -c statement_timeout=45000";
const { fetchTransactionStatusesFromNetSuite } = await import(source("netsuite.js"));
const { listDriverPwaCompletedDispatchRefs } = await import(source("dispatch-history-mode.js"));
const { config } = await import(source("config.js"));
config.netsuite.requestTimeoutMs = 45000;
try {
  const { rows: candidates } = await query("SELECT netsuite_id,tranid,status,status_text FROM transfer_orders WHERE netsuite_id>0 ORDER BY netsuite_id");
  const locallyDelivered = await listDriverPwaCompletedDispatchRefs({ candidateRefs: candidates.map(row => row.tranid) });
  // Read receipt evidence for every TO, including locally delivered transfers.
  // Local delivery still never triggers NetSuite status reconciliation.
  const startedAt = new Date().toISOString(), rows = [];
  for (let i = 0; i < candidates.length; i += 500) {
    const result = await withTransaction(async () => {
      await query("SET TRANSACTION READ ONLY");
      return fetchTransactionStatusesFromNetSuite(candidates.slice(i, i + 500).map(row => row.netsuite_id), "TrnfrOrd");
    }, { rollback: true });
    rows.push(...result);
    process.stderr.write(`Read-only TO verification: ${Math.min(i + 500, candidates.length)}/${candidates.length}; ${rows.length} returned.\n`);
  }
  process.stdout.write(`${JSON.stringify({ mode: "netsuite-read-only-select", transactionType: "TrnfrOrd", startedAt,
    completedAt: new Date().toISOString(), locallyDelivered: [...locallyDelivered].sort(), requested: candidates, rows }, null, 2)}\n`);
} finally { await closeDb(); }
