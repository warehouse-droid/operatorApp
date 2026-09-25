import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { query, pool, closeDb } from '../../../src/db.js';
import { createNetSuiteRequestScheduler } from '../../../src/netsuite-request-scheduler.js';
import { netSuiteRequestQueueStore as store } from '../../../src/netsuite-request-queue-store.js';
import { gate, until } from '../../support/netsuite-priority-queue-fixture.mjs';
import { isOperatorNetSuiteRequest, withOperatorNetSuitePriority, withBackgroundNetSuitePriority } from '../../../src/operator-netsuite-request-pool.js';

after(closeDb);
const count = async () => Number((await query('SELECT count(*) FROM netsuite_request_queue')).rows[0].count);

test('cancelled and timed-out waiters never execute or strand following work', async () => {
  const scheduler = createNetSuiteRequestScheduler(), entered = gate(), release = gate();
  const held = scheduler.run(async () => { entered.resolve(); await release.promise; });
  let sent = 0;
  try {
    await entered.promise;
    const controller = new AbortController();
    const pending = scheduler.run(async () => { sent++; }, { signal: controller.signal });
    const rejected = assert.rejects(pending, error => error.name === 'AbortError');
    await until(async () => await count() === 2, 'Waiting reservation must exist');
    controller.abort(); await rejected;
    await assert.rejects(createNetSuiteRequestScheduler({ waitTimeoutMs: 60, pollMs: 5 }).run(async () => { sent++; }),
      error => ['AbortError', 'TimeoutError'].includes(error.name));
    assert.equal(sent, 0); assert.equal(await count(), 1);
  } finally { release.resolve(); await held; }
  assert.equal(await scheduler.run(async () => 'recovered'), 'recovered'); assert.equal(await count(), 0);
});

test('active request deadline and caller abort cancel the transport and release capacity', async () => {
  const scheduler = createNetSuiteRequestScheduler();
  await assert.rejects(scheduler.run(signal => sleep(5000, 'unexpected', { signal }), { timeoutMs: 25 }),
    error => error.name === 'AbortError');
  const controller = new AbortController(), entered = gate();
  const pending = scheduler.run(async signal => { entered.resolve(); return sleep(5000, 'unexpected', { signal }); }, { signal: controller.signal });
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  await entered.promise; controller.abort(); await rejected;
  assert.equal(await count(), 0);
  assert.equal(await scheduler.run(async () => 42), 42);
});

test('database enqueue/claim errors fail closed; release failure preserves a successful write', async () => {
  let sent = 0;
  for (const operation of ['enqueue', 'claim']) {
    const scheduler = createNetSuiteRequestScheduler({ store: { ...store, [operation]: async () => { throw new Error(`database-${operation}`); } } });
    await assert.rejects(scheduler.run(async () => { sent++; }), new RegExp(`database-${operation}`, 'u'));
    assert.equal(await count(), 0);
  }
  assert.equal(sent, 0);
  let reserved;
  const warnings = [], original = console.warn;
  console.warn = value => warnings.push(value);
  try {
    const scheduler = createNetSuiteRequestScheduler({ store: { ...store,
      enqueue: async priority => { reserved = await store.enqueue(priority); return reserved; },
      release: async () => { throw new Error('private-database-failure'); } } });
    assert.deepEqual(await scheduler.run(async () => ({ id: 1012625 })), { id: 1012625 });
    assert.equal(await count(), 1); assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /private/u);
    await query("UPDATE netsuite_request_queue SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [reserved]);
    assert.equal(await createNetSuiteRequestScheduler().run(async () => 'recovered'), 'recovered');
  } finally { console.warn = original; if (reserved) { await store.release(reserved); } }
});

test('expired process reservations are swept, while unexpired active leases still enforce capacity', async () => {
  const ids = Array.from({ length: 4 }, () => randomUUID());
  try {
    for (const id of ids) {
      await query("INSERT INTO netsuite_request_queue(id,priority,state,expires_at) VALUES($1,1,'running',clock_timestamp()+interval '10 seconds')", [id]);
    }
    let sent = 0;
    await assert.rejects(createNetSuiteRequestScheduler({ waitTimeoutMs: 40, pollMs: 5 }).run(async () => { sent++; }),
      error => ['AbortError', 'TimeoutError'].includes(error.name));
    assert.equal(sent, 0);
    await query("UPDATE netsuite_request_queue SET expires_at=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])", [ids]);
    const dead = await store.enqueue('operator');
    await query("UPDATE netsuite_request_queue SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [dead]);
    assert.equal(await createNetSuiteRequestScheduler().run(async () => 'after crash'), 'after crash');
    assert.equal(await count(), 0);
    await assert.rejects(store.claim(dead, 100), { code: 'NETSUITE_QUEUE_EXPIRED' });
  } finally { await query('DELETE FROM netsuite_request_queue WHERE id=ANY($1::uuid[])', [ids]); }
});

test('stale grant and invalid options cannot send; queue growth is bounded', async () => {
  let sent = 0;
  const scheduler = createNetSuiteRequestScheduler({ store: { ...store, claim: async (...args) => {
    const grant = await store.claim(...args); await sleep(35); return grant;
  } } });
  await assert.rejects(scheduler.run(async () => { sent++; }, { timeoutMs: 20 }), { code: 'NETSUITE_GRANT_EXPIRED' });
  assert.equal(sent, 0);
  for (const timeoutMs of [0, -1, 1.5, Infinity, 3600001]) {
    await assert.rejects(scheduler.run(async () => {}, { timeoutMs }), RangeError);
    assert.throws(() => createNetSuiteRequestScheduler({ pollMs: timeoutMs }), RangeError);
  }
  await assert.rejects(scheduler.run(async () => {}, { priority: 'untrusted' }), TypeError);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(scheduler.run(async () => { sent++; }, { signal: controller.signal }));
  assert.equal(await count(), 0);
  await query("INSERT INTO netsuite_request_queue(id,priority,expires_at) SELECT gen_random_uuid(),0,clock_timestamp()+interval '30 seconds' FROM generate_series(1,500)");
  try { await assert.rejects(scheduler.run(async () => { sent++; }), { code: 'NETSUITE_QUEUE_FULL' }); }
  finally { await query('DELETE FROM netsuite_request_queue'); }
  assert.equal(sent, 0);
});

test('queue transactions work when business connections are all held; migration is repeatable', async () => {
  const migration = readFileSync('migrations/227_netsuite_request_priority.sql', 'utf8');
  await query(migration); await query(migration);
  const clients = [];
  try {
    for (let i = 0; i < 10; i++) { clients.push(await pool.connect()); }
    assert.equal(await createNetSuiteRequestScheduler().run(async () => 'independent'), 'independent');
  } finally { clients.forEach(client => client.release()); }
  assert.equal(await count(), 0);
});

test('Operator priority persists across awaits and explicit background work does not inherit it', async () => {
  assert.equal(isOperatorNetSuiteRequest(), false);
  await withOperatorNetSuitePriority(async () => {
    await sleep(1); assert.equal(isOperatorNetSuiteRequest(), true);
    await withBackgroundNetSuitePriority(async () => { await sleep(1); assert.equal(isOperatorNetSuiteRequest(), false); });
    assert.equal(isOperatorNetSuiteRequest(), true);
  });
  assert.equal(isOperatorNetSuiteRequest(), false);
  const directory = readFileSync('src/return-customer-directory.js', 'utf8');
  assert.match(directory, /withBackgroundNetSuitePriority\(\(\) => syncReturnCustomerDirectory\(\)\)/u);
});
