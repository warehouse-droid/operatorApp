// Measure the running application's pool through GET endpoints. A short-lived
// diagnostic login is removed in finally; no user accounts or orders are edited.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { query, withTransaction, closeDb } from '../src/db.js';

const id = randomUUID();
const token = randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(token).digest('hex');
const report = { endpoints: [], locks: [], diagnosticLoginRemoved: false };
const business = async () => (await query(`SELECT r.request_ref,md5(jsonb_build_object(
  'request',to_jsonb(r),'case',to_jsonb(c),'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id)
  FROM sales_special_stock_lines l WHERE l.request_id=r.id))::text) AS hash
  FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id
  WHERE r.request_ref IN ('SPREQ-000006','SPREQ-000007') ORDER BY r.id`)).rows;
const before = await business();
try {
  await withTransaction(async () => {
    await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,
      role,roles,yard_location_ids,operator_yard_location_ids,active)
      VALUES($1,$2,'Temporary Dispatch performance verification',$3,$4,'scm',
        ARRAY['scm','dispatcher','sales'],ARRAY[1],ARRAY[1],true)`,
    [id, `performance-check-${id}`, randomBytes(64).toString('hex'), randomBytes(32).toString('hex')]);
    await query(`INSERT INTO operator_sessions(token_hash,operator_id,expires_at)
      VALUES($1,$2,now()+interval '5 minutes')`, [hash, id]);
  });
  for (let round = 0; round < 3; round++) {
    for (const path of ['/api/scm/special-stock-requests', '/api/sales/special-stock-requests',
      '/api/dispatch/v2/bootstrap?date=2026-09-26', '/api/dispatch/v2/order-pool?type=SO&limit=50']) {
      const started = performance.now();
      const response = await fetch(`http://127.0.0.1:3000${path}`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000)
      });
      const bytes = (await response.arrayBuffer()).byteLength;
      const result = { round, path, status: response.status, ms: Math.round(performance.now() - started), bytes };
      report.endpoints.push(result);
      console.log(JSON.stringify(result));
      assert.equal(response.status, 200);
    }
    for (let sample = 0; sample < 10; sample++) {
      report.locks.push((await query(`SELECT clock_timestamp() AS at,
        count(*) FILTER (WHERE NOT granted)::int AS waiting,count(*) FILTER (WHERE granted)::int AS holding
        FROM pg_locks WHERE locktype='advisory' AND objid=4276681444`)).rows[0]);
      await delay(1000);
    }
  }
  assert.deepEqual(await business(), before);
  report.protectedRequestsUnchanged = true;
} finally {
  await query('DELETE FROM operator_sessions WHERE token_hash=$1 AND operator_id=$2', [hash, id]);
  await query('DELETE FROM operators WHERE id=$1 AND username=$2', [id, `performance-check-${id}`]);
  report.diagnosticLoginRemoved = (await query('SELECT id FROM operators WHERE id=$1', [id])).rowCount === 0;
  await closeDb();
  writeFileSync('/tmp/dispatch-contention-live.json', JSON.stringify(report, null, 2));
}
