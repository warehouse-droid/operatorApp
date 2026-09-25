// Private, full-fidelity capture. Never send this corpus to CI or external services.
import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createGzip } from 'node:zlib';
import path from 'node:path';
import { pool } from '../src/db.js';

const output = path.resolve(process.argv[2] || 'test-artifacts/dispatch-save-reliability/private-history');
await mkdir(output, { recursive: true, mode: 0o700 });
await chmod(output, 0o700);
const tables = [
  'dispatch_plans', 'dispatch_plan_snapshots', 'dispatch_plan_snapshot_history',
  'dispatch_plan_commands', 'dispatch_audit_log', 'dispatch_global_order_groups',
  'dispatch_global_order_group_members', 'dispatch_global_order_splits',
  'dispatch_custom_orders', 'dispatch_order_completion_events', 'driver_job_records',
  'driver_job_corrections', 'scm_netsuite_po_history_changes', 'scm_reconciliation_audit_events'
];
const manifest = { version: 1, startedAt: new Date().toISOString(), readOnly: true,
  fidelity: 'PostgreSQL row_to_json text, including every stored column; no sanitization or numeric round trip',
  limits: ['Original requests not retained in command receipts cannot be reproduced exactly.',
    'Pruned history and historical source states absent from retained evidence remain gaps.'], tables: {} };
const client = await pool.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const state = await client.query('SELECT current_setting(\'transaction_read_only\') AS read_only, txid_current_snapshot()::text AS snapshot, version() AS version');
  if (state.rows[0].read_only !== 'on') throw new Error('Capture must be read only');
  manifest.database = state.rows[0];
  for (const table of tables) {
    const hash = crypto.createHash('sha256');
    const gzip = createGzip();
    const file = createWriteStream(path.join(output, `${table}.jsonl.gz`), { mode: 0o600, flags: 'wx' });
    gzip.pipe(file);
    let rows = 0;
    // Identifiers above are a closed allowlist. Returning text preserves decimal precision.
    await client.query(`DECLARE capture_rows NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS record FROM ${table} t`);
    for (;;) {
      const batch = await client.query('FETCH 20 FROM capture_rows');
      if (!batch.rowCount) break;
      for (const row of batch.rows) {
        const record = `${row.record}\n`;
        hash.update(record);
        if (!gzip.write(record)) await once(gzip, 'drain');
        rows++;
      }
    }
    await client.query('CLOSE capture_rows');
    gzip.end();
    await once(file, 'close');
    manifest.tables[table] = { rows, uncompressedSha256: hash.digest('hex') };
    console.log(JSON.stringify({ table, rows }));
  }
  await client.query('COMMIT');
  manifest.completedAt = new Date().toISOString();
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally { client.release(); await pool.end(); }
