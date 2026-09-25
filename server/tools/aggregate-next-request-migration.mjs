import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { query, withTransaction, closeDb } from '../src/db.js';

if (process.env.MBT_TEST_ISOLATED !== '1') { throw new Error('Disposable database required.'); }
const original = await readFile('migrations/215_aggregate_requests.sql', 'utf8');
const migration = await readFile('migrations/217_aggregate_request_cycles.sql', 'utf8');
const memoMigration = await readFile('migrations/218_aggregate_material_memos.sql', 'utf8');
async function legacySchema(work) {
  return withTransaction(async () => {
    await query('CREATE SCHEMA aggregate_cycle_rehearsal');
    await query('SET LOCAL search_path TO aggregate_cycle_rehearsal, public');
    await query('CREATE TABLE operators (id text PRIMARY KEY)');
    await query("INSERT INTO operators VALUES ('legacy')");
    await query(original);
    await work();
  }, { rollback: true });
}
async function insert(yard, date, status = 'submitted') {
  return (await query(`INSERT INTO aggregate_requests
    (yard_location_id,service_date,report_due_date,requested_by,status,confirmed_by,reported_by)
    VALUES ($1,$2::date,$2::date+1,'legacy',$3,'legacy',CASE WHEN $3='reported' THEN 'legacy' END) RETURNING id`,
  [yard, date, status])).rows[0].id;
}
async function snapshot() {
  const result = {};
  for (const table of ['aggregate_requests', 'aggregate_request_lines', 'aggregate_request_events']) {
    result[table] = (await query(`SELECT to_jsonb(t) - 'scm_memo' AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}
try {
  await legacySchema(async () => {
    await insert(1, '2026-09-23', 'reported');
    await insert(1, '2026-09-22', 'reported');
    await insert(28, '2026-09-23');
    await insert(15, '2026-09-23', 'confirmed');
    await insert(26, '2026-09-23', 'rejected');
    await query(`INSERT INTO aggregate_request_lines (request_id,material_code,requested_loads,confirmed_loads,actual_loads)
      SELECT r.id,m,3,CASE WHEN r.status IN ('confirmed','reported') THEN 3 END,
      CASE WHEN r.status='reported' THEN 2 END FROM aggregate_requests r
      CROSS JOIN unnest(ARRAY['gravel','hpb','screening','crusher_run','dump_concrete','dump_asphalt','dump_soil']) m`);
    await query(`INSERT INTO aggregate_request_events (request_id,actor_id,operation_id,payload_hash,action,after_snapshot)
      SELECT id,'legacy','legacy-'||id,'retained-history','submit',to_jsonb(r) FROM aggregate_requests r`);
    const before = await snapshot();
    await query(migration); await query(migration);
    await query(memoMigration); await query(memoMigration);
    assert.deepEqual(await snapshot(), before, 'Migration and reapplication preserve all historical rows exactly.');
    assert.ok((await query('SELECT scm_memo FROM aggregate_request_lines')).rows.every(row => row.scm_memo === ''));
    await query("UPDATE aggregate_request_lines SET scm_memo='Morning delivery 上午送货' WHERE request_id=1 AND material_code='gravel'");
    const line = (await query("SELECT requested_loads,confirmed_loads,actual_loads,scm_memo FROM aggregate_request_lines WHERE request_id=1 AND material_code='gravel'")).rows[0];
    assert.deepEqual(line, { requested_loads: 3, confirmed_loads: 3, actual_loads: 2, scm_memo: 'Morning delivery 上午送货' });
    await assert.rejects(() => withTransaction(() => query("UPDATE aggregate_request_lines SET scm_memo=$1 WHERE request_id=1 AND material_code='gravel'", ['x'.repeat(2001)])), { code: '23514' });
    await query("INSERT INTO aggregate_request_events(request_id,actor_id,operation_id,payload_hash,action,after_snapshot) VALUES(1,'legacy','memo-event','memo-hash','memo','{}')");
    await insert(1, '2026-09-23');
    await insert(26, '2026-09-23');
    for (const [yard, date, status] of [[1, '2026-09-24', 'submitted'], [28, '2026-09-24', 'confirmed'], [15, '2026-09-23', 'submitted']]) {
      await assert.rejects(() => withTransaction(() => insert(yard, date, status)), { code: '23505' });
    }
    await assert.rejects(() => withTransaction(() => query(`ALTER TABLE aggregate_requests
      ADD CONSTRAINT aggregate_requests_yard_location_id_service_date_key UNIQUE (yard_location_id,service_date)`)), { code: '23505' });
    console.log('Preserved headers, quantities and history; both migrations tolerate reapplication; memos default empty and are limited to 2,000 characters; only one unfinished request per yard.');
  });
  await legacySchema(async () => {
    await insert(1, '2026-09-23'); await insert(1, '2026-09-24', 'confirmed');
    const before = await snapshot();
    await assert.rejects(() => withTransaction(() => query(migration)), { code: '23505' });
    assert.deepEqual(await snapshot(), before);
    assert.equal((await query("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='aggregate_requests'::regclass AND conname='aggregate_requests_yard_location_id_service_date_key'")).rows[0].n, 1);
    assert.equal((await query("SELECT to_regclass('aggregate_cycle_rehearsal.aggregate_requests_one_unfinished_yard_idx') AS name")).rows[0].name, null);
    console.log('Conflicting legacy unfinished requests abort the migration without changing records or the original constraint.');
  });
  assert.equal((await query("SELECT to_regnamespace('aggregate_cycle_rehearsal') AS name")).rows[0].name, null);
  console.log('Migration rehearsal rolled back completely.');
} finally { await closeDb(); }
