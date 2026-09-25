import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createNetSuiteRequestScheduler } from '../../src/netsuite-request-scheduler.js';
import { query } from '../../src/db.js';

export function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

export async function until(check, label) {
  const deadline = performance.now() + 3000;
  while (!await check()) {
    assert.ok(performance.now() < deadline, label);
    await sleep(10);
  }
}

async function registered(count) {
  await until(async () => Number((await query('SELECT count(*) FROM netsuite_request_queue')).rows[0].count) === count,
    'Each request must reach the shared queue before submitting the next FIFO waiter');
}

export async function priorityScenario(extraOperators = 3, extraBackground = 2, failAt = -1) {
  const schedulers = [createNetSuiteRequestScheduler({ pollMs: 5, waitTimeoutMs: 2000 }),
    createNetSuiteRequestScheduler({ pollMs: 5, waitTimeoutMs: 2000 })];
  const held = [gate(), gate(), gate(), gate()];
  const started = [], tasks = [];
  let active = 0, background = 0, peak = 0, backgroundPeak = 0;
  const submit = (tag, priority, wait = null) => {
    const promise = schedulers[tasks.length % 2].run(async () => {
      started.push(tag); active++; background += Number(priority === 'background');
      peak = Math.max(peak, active); backgroundPeak = Math.max(backgroundPeak, background);
      assert.ok(active <= 4, 'The shared budget must never exceed four');
      assert.ok(background <= 1, 'Background requests must leave three slots free');
      try {
        if (wait) { await wait.promise; } else { await sleep(4); }
        if (tag === `op-${failAt}`) { throw new Error('expected request failure'); }
        return tag;
      } finally { active--; background -= Number(priority === 'background'); }
    }, { priority, timeoutMs: 5000 });
    promise.catch(() => {}); tasks.push(promise); return promise;
  };
  try {
    submit('held-bg', 'background', held[0]);
    await until(() => started.length === 1, 'First background must start');
    for (let i = 1; i < 4; i++) {
      submit(`held-${i}`, 'operator', held[i]);
      await until(() => started.length === i + 1, 'Three Operator requests must use spare slots');
    }
    const backgrounds = [];
    for (let i = 0; i < extraBackground; i++) {
      backgrounds.push(submit(`bg-${i}`, 'background'));
      await registered(tasks.length);
    }
    const operators = [];
    for (let i = 0; i < extraOperators; i++) {
      operators.push(submit(`op-${i}`, 'operator'));
      await registered(tasks.length);
    }
    assert.equal(started.length, 4, 'Full capacity must hold queued callers');
    held[0].resolve();
    await until(() => started.length >= 4 + extraOperators + extraBackground, 'Both priorities must drain');
    assert.deepEqual(started.slice(4), [
      ...Array.from({ length: extraOperators }, (_, i) => `op-${i}`),
      ...Array.from({ length: extraBackground }, (_, i) => `bg-${i}`)
    ], 'Operators jump ahead of older background waiters; each priority is FIFO');
    assert.equal(peak, 4); assert.equal(backgroundPeak, 1);
    const outcomes = await Promise.allSettled(operators);
    outcomes.forEach((result, i) => {
      assert.equal(result.status, i === failAt ? 'rejected' : 'fulfilled');
      if (result.status === 'fulfilled') { assert.equal(result.value, `op-${i}`); }
      else { assert.match(result.reason.message, /expected request failure/u); }
    });
    assert.deepEqual(await Promise.all(backgrounds), Array.from({ length: extraBackground }, (_, i) => `bg-${i}`));
  } finally { held.forEach(item => item.resolve()); await Promise.allSettled(tasks); }
  assert.equal(active, 0);
}

export async function backgroundScenario(count = 4) {
  const release = gate(), started = [], tasks = [];
  const scheduler = createNetSuiteRequestScheduler({ pollMs: 5, waitTimeoutMs: 2000 });
  let active = 0, peak = 0;
  try {
    for (let i = 0; i < count; i++) {
      const pending = scheduler.run(async () => {
        active++; peak = Math.max(peak, active); started.push(i);
        try { await release.promise; return i; } finally { active--; }
      });
      pending.catch(() => {}); tasks.push(pending); await registered(tasks.length);
    }
    await until(() => started.length > 0, 'At least one background request must run');
    await sleep(30);
    assert.equal(peak, 1, 'Even spare capacity cannot allow multiple background requests');
    release.resolve();
    assert.deepEqual(await Promise.all(tasks), Array.from({ length: count }, (_, i) => i));
    assert.deepEqual(started, Array.from({ length: count }, (_, i) => i));
  } finally { release.resolve(); await Promise.allSettled(tasks); }
}
