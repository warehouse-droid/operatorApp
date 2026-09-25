// Run from the server directory. SELECT-only; redirect stdout to a private
// artifact (mode 0600), never commit the operational snapshot contents.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { query, withTransaction, closeDb } = await import(pathToFileURL(path.resolve('src/db.js')).href);
try {
  const capture = await withTransaction(async () => {
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await query("SET LOCAL statement_timeout='10s'");
    const snapshots = (await query(`SELECT id::text,plan_id::text,plan_date::text,revision,
      orders,trucks,summary,original_saved_at,archive_reason
      FROM dispatch_plan_snapshot_history WHERE id IN (17722,17723) ORDER BY id`)).rows;
    const command = (await query(`SELECT result->'plan'->>'status' AS status,result->'plan'->>'note' AS note,
      result->'acknowledgement'->>'digest' AS digest FROM dispatch_plan_commands WHERE id=2246`)).rows[0];
    const failure = (await query(`SELECT details->'request'->'body'->'baseRevision' AS revision,
      details->'request'->'body'->>'baseDigest' AS digest,
      details->'status' AS status FROM delivery_audit_log WHERE id=2151016`)).rows[0];
    return { capturedAt: new Date().toISOString(), snapshots, command, failure };
  });
  process.stdout.write(JSON.stringify(capture));
} finally { await closeDb(); }
