// SuiteQL POST executes SELECT only; no NetSuite records are written.
import path from "node:path";
import { pathToFileURL } from "node:url";
const source = name => pathToFileURL(path.resolve("src", name)).href;
const { pool, query, closeDb } = await import(source("db.js"));
const { fetchScmReconciliationOrdersFromNetSuite } = await import(source("netsuite.js"));
const { config } = await import(source("config.js"));
pool.options.options = "-c default_transaction_read_only=on -c jit=off -c statement_timeout=45000";
config.netsuite.requestTimeoutMs = 45000;
const refs = ["TOB00569", "TOB00766", "TOB00793", "TOB00800", "TOB00838", "TOB00896", "TOB00903", "TOB00942", "TOB00956", "TOB00965", "TOB00973", "TOB00974", "TOB00975", "TOB00982", "TOB00983", "TOB00984", "TOB00987", "TOB00989", "TOB00994", "TOB00995", "TOB01001", "TOB01022", "TOB01023", "TOB01025", "TOB01027", "TOB01083"];
try {
  const startedAt = new Date().toISOString();
  const requested = (await query("SELECT netsuite_id,tranid FROM transfer_orders WHERE tranid=ANY($1::text[]) AND netsuite_id>0 ORDER BY netsuite_id", [refs])).rows;
  if (requested.length !== refs.length || new Set(requested.map(row => row.tranid)).size !== refs.length) {throw new Error("TO identities changed");}
  const orders = await fetchScmReconciliationOrdersFromNetSuite({ kind: "TO", orderIds: requested.map(row => row.netsuite_id), targetOnly: true, includeOpen: false });
  process.stdout.write(JSON.stringify({ mode: "netsuite-read-only-select", transactionType: "TrnfrOrd", startedAt, completedAt: new Date().toISOString(), requested, orders }, null, 2) + "\n");
  process.stderr.write(`Read authoritative NetSuite details for ${orders.length}/${requested.length} conflicted TOs.\n`);
} finally { await closeDb(); }
