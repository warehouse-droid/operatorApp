import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { query, withTransaction, closeDb } from '../src/db.js';

if (process.env.MBT_TEST_ISOLATED !== '1') { throw new Error('Disposable test database required.'); }
const migration = await readFile('migrations/215_aggregate_requests.sql', 'utf8');
try {
  await withTransaction(async () => {
    await query('CREATE SCHEMA aggregate_migration_rehearsal');
    await query('SET LOCAL search_path TO aggregate_migration_rehearsal, public');
    await query(migration);
    await query(migration);
    const result = await query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='aggregate_migration_rehearsal'");
    assert.equal(result.rows[0].n, 3);
  }, { rollback: true });
  assert.equal((await query("SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name='aggregate_migration_rehearsal'")).rows[0].n, 0);
  console.log('Migration creates three tables, tolerates reapplication, and rolls back completely.');
} finally { await closeDb(); }
