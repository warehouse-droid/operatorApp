import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../../../src/config.js';
import { query } from '../../../src/db.js';
import { fixture } from '../../support/operator-suiteql-fixture.mjs';
import { gate, until } from '../../support/netsuite-priority-queue-fixture.mjs';

test('four separate app/worker processes share one HTTP budget and one background slot', async () => {
  const app = await fixture();
  const release = gate(), children = [], results = [], ready = [], exited = [];
  let active = 0, background = 0, peak = 0, backgroundPeak = 0;
  const seen = [];
  app.state.handle = async ({ url }) => {
    const id = Number(url.pathname.split('/').at(-1)), low = id < 300;
    active++; background += Number(low); seen.push(id);
    peak = Math.max(peak, active); backgroundPeak = Math.max(backgroundPeak, background);
    try { await release.promise; await sleep(5); return { data: { id } }; }
    finally { active--; background -= Number(low); }
  };
  try {
    for (let index = 0; index < 4; index++) {
      const child = fork('test/support/netsuite-priority-queue-child.mjs',
        [config.netsuite.restBaseUrl, index < 2 ? 'background' : 'operator', String(100 * (index + 1))],
        { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      children.push(child);
      child.on('message', message => { if (message.ready) { ready.push(child); } else { results.push(message); } });
      exited.push(new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))));
    }
    await until(() => ready.length === 4, 'All independent callers must initialize');
    children.forEach(child => child.send('run'));
    await until(() => active === 4, 'The scheduler must use all four slots');
    await sleep(150);
    assert.equal(peak, 4); assert.ok(backgroundPeak <= 1);
    assert.equal(Number((await query("SELECT count(*) FROM netsuite_request_queue WHERE state='waiting'")).rows[0].count), 8);
    release.resolve();
    await until(() => results.length === 4, 'Every process must finish');
    assert.ok(results.every(result => !result.error && result.result.length === 3), JSON.stringify(results));
    assert.deepEqual(await Promise.all(exited), Array.from({ length: 4 }, () => ({ code: 0, signal: null })));
    assert.equal(new Set(seen).size, 12); assert.equal(seen.length, 12);
    assert.equal(peak, 4); assert.equal(backgroundPeak, 1);
    assert.equal(active, 0);
    assert.equal(Number((await query('SELECT count(*) FROM netsuite_request_queue')).rows[0].count), 0);
  } finally {
    release.resolve(); children.forEach(child => { if (child.exitCode === null) { child.kill(); } });
    await Promise.all(exited); await app.close();
  }
});
