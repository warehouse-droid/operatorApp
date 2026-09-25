import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeDb, query, withTransaction } from '../../../src/db.js';
import { seedCoFixture, insertLegacyCoJob } from '../../support/co-completion-fixture.mjs';
after(closeDb);

test('concurrent stale completion retries converge to one transfer identity and one correction', async () => {
  const { f, record } = await withTransaction(async () => {
    const fixture = await seedCoFixture();
    return { f: fixture, record: await insertLegacyCoJob(fixture) };
  });
  await Promise.all(Array.from({ length: 6 }, () => withTransaction(() => query(
    'UPDATE driver_job_records SET order_refs=$2::jsonb WHERE id=$1', [record.id, JSON.stringify(f.members)]))));
  const actual = (await query('SELECT * FROM driver_job_records WHERE id=$1', [record.id])).rows[0];
  assert.deepEqual(actual.order_refs, [f.coRef]);
  assert.deepEqual(actual.photo_data_urls, record.photo_data_urls);
  assert.deepEqual(actual.completed_at, record.completed_at);
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_driver_co_identity_corrections WHERE driver_job_record_id=$1', [record.id])).rows[0].n, 1);
  assert.equal((await query('SELECT status FROM local_co_orders WHERE co_ref=$1', [f.coRef])).rows[0].status, 'completed');
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_effective_order_completion_events WHERE order_ref=ANY($1)', [f.members])).rows[0].n, 0);
});
