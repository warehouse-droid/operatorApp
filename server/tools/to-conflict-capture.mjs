import { writeFileSync } from "node:fs";
import { pool, closeDb } from "../src/db.js";
import { readTransferCleanupState } from "./to-cleanup-repository.mjs";
pool.options.options = "-c default_transaction_read_only=on -c jit=off -c statement_timeout=60000";
try {
  const state = await readTransferCleanupState();
  writeFileSync(process.argv[2], JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ orders: state.orders.length, lines: state.lines.length, capturedAt: new Date().toISOString() }));
} finally { await closeDb(); }
