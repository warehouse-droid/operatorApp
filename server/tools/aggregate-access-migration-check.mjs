import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { query, withTransaction, closeDb } from '../src/db.js';
if (process.env.MBT_TEST_ISOLATED !== '1') { throw new Error('Disposable test database required.'); }
try {
  const migration = await readFile('migrations/216_aggregate_request_access.sql', 'utf8');
  const accounts = await query('SELECT id, role, roles, yard_location_ids, operator_yard_location_ids FROM operators ORDER BY id');
  await withTransaction(async () => {
    await query('CREATE SCHEMA aggregate_access_rehearsal');
    await query('SET LOCAL search_path TO aggregate_access_rehearsal, public');
    await query(migration); await query(migration);
    const rows = (await query('SELECT yard_location_id,operator_id,revision FROM aggregate_access_rehearsal.aggregate_request_yard_assignments ORDER BY yard_location_id')).rows;
    assert.deepEqual(rows, [1, 15, 26, 28].map(id => ({ yard_location_id: id, operator_id: null, revision: 0 })));
  }, { rollback: true });
  assert.equal((await query("SELECT to_regnamespace('aggregate_access_rehearsal') AS schema")).rows[0].schema, null);
  assert.deepEqual((await query('SELECT id, role, roles, yard_location_ids, operator_yard_location_ids FROM operators ORDER BY id')).rows, accounts.rows);
  console.log('Migration216: four unassigned yards, reapplication, complete rollback and unchanged normal account permissions verified.');
} finally { await closeDb(); }
