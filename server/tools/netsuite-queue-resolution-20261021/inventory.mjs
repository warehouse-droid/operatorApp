// Operational read-only inventory. Run via stdin in the existing app container.
import { query, closeDb } from './src/db.js';
import { listOperatorNetSuitePostingAttentionCommands } from './src/operator-netsuite-posting-repository.js';
import { listSalesOrderAutoFulfillmentCandidates } from './src/sales-order-auto-fulfillment-repository.js';
import { listTransferPostingJobs } from './src/transfer-order-posting-repository.js';
try {
  const native = await listOperatorNetSuitePostingAttentionCommands({ limit: 500 });
  const sales = await listSalesOrderAutoFulfillmentCandidates({
    statuses: ['waiting_evidence', 'attention', 'uncertain', 'failed', 'historical', 'gate_disabled'], limit: 500 });
  const transfers = await listTransferPostingJobs();
  const counts = {};
  for (const table of ['operator_netsuite_posting_commands', 'dispatch_sales_order_if_candidates', 'transfer_order_posting_jobs']) {
    counts[table] = (await query(`SELECT status,count(*)::int AS count FROM ${table} GROUP BY status ORDER BY status`)).rows;
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), native, sales, transfers, counts }));
} finally { await closeDb(); }
