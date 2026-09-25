import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { query, withTransaction, closeDb } from '../src/db.js';
import { aggregateDates, AGGREGATE_MATERIALS } from '../src/aggregate-request-domain.js';
import { createAggregateRequest, changeAggregateRequest, getAggregateRequest } from '../src/aggregate-request-repository.js';

if (process.env.MBT_TEST_ISOLATED !== '1') { throw new Error('Disposable database required.'); }
const actors = ['old', 'new', 'scm'].map(name => ({ id: `aggregate-cycle-${name}-${randomUUID()}`,
  role: name === 'scm' ? 'scm' : 'operator', aggregateRequestYardLocationIds: [1] }));
const loads = Object.fromEntries(AGGREGATE_MATERIALS.map(m => [m.code, m.code === 'gravel' ? 3 : 0]));
const body = () => ({ loads, yardLocationId: 1, serviceDate: aggregateDates().serviceDate, operationId: randomUUID() });
try {
  for (const table of ['aggregate_request_events', 'aggregate_request_lines', 'aggregate_requests']) { await query(`DELETE FROM ${table}`); }
  for (const actor of actors) {
    await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles)
      VALUES($1,$1,$1,'test','test',$2,ARRAY[$2])`, [actor.id, actor.role]);
  }
  await query('UPDATE aggregate_request_yard_assignments SET operator_id=$1 WHERE yard_location_id=1', [actors[0].id]);
  const original = await createAggregateRequest(body(), actors[0]);
  const confirmed = await changeAggregateRequest(original.id, 'confirm', { expectedRevision: original.revision, loads, operationId: randomUUID() }, actors[2]);
  await query('UPDATE aggregate_request_yard_assignments SET operator_id=$1 WHERE yard_location_id=1', [actors[1].id]);
  let release, ready;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { ready = resolve; });
  const writer = withTransaction(async () => {
    await changeAggregateRequest(original.id, 'report', { expectedRevision: confirmed.revision, loads, operationId: randomUUID() }, actors[2]);
    ready(); await gate;
  });
  await started;
  const creating = createAggregateRequest(body(), actors[1]);
  creating.catch(() => {});
  try {
    let waiting = false;
    for (let n = 0; n < 100 && !waiting; n += 1) {
      waiting = (await query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
        AND pid<>pg_backend_pid() AND wait_event_type='Lock'
        AND (query LIKE '%pg_advisory_xact_lock%' OR query LIKE '%INSERT INTO aggregate_requests%')`)).rows[0].n > 0;
      if (!waiting) { await delay(10); }
    }
    assert.equal(waiting, true, 'New submission waits for the in-flight actual report to commit.');
  } finally { release(); await writer; }
  const next = await creating;
  const saved = await getAggregateRequest(original.id, actors[2]);
  assert.notEqual(next.id, original.id);
  assert.equal(next.requestedBy, actors[1].id);
  assert.equal(next.status, 'submitted');
  assert.equal(saved.status, 'reported');
  assert.deepEqual(saved.events.map(event => event.action), ['submit', 'confirm', 'report']);
  assert.equal((await query("SELECT count(*)::int AS n FROM aggregate_requests WHERE yard_location_id=1 AND status IN ('submitted','confirmed')")).rows[0].n, 1);
  console.log('Reassigned requester waits for SCM report commit; one fresh request and the complete prior history remain.');
} finally { await closeDb(); }
