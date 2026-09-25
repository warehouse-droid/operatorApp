import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fixture, latch, deadline, mixedQueueScenario } from '../test/support/operator-suiteql-fixture.mjs';
import { suiteql } from '../src/netsuite.js';
import { fetchPickupExistingFulfillment } from '../src/operator-pickup-existing-if-source.js';

const app = await fixture();
const started = latch(), release = latch();
let background, pickup, elapsed;
try {
  app.state.handle = async ({ body }) => {
    if (body.q === 'background-held') {
      started.resolve(); await release.promise;
      return { data: { items: [] } };
    }
    assert.match(body.q, /t\.id IN \(1012515\)/u);
    return { data: { items: [{ id: '1012515', tranid: 'SOB121250', status_text: 'Pending Fulfillment' }] } };
  };
  background = suiteql('background-held');
  await deadline(started.promise, 'Background never started');
  const begin = performance.now();
  pickup = fetchPickupExistingFulfillment({ sourceNetSuiteId: 1012515, sourceOrderRef: 'SOB121250', selectedItems: [] });
  assert.equal(await deadline(pickup, 'Pickup validation is stuck behind unrelated SuiteQL'), null);
  elapsed = performance.now() - begin;
  release.resolve(); await background;
  await mixedQueueScenario(app.state, 9, 1);
} finally {
  release.resolve(); await Promise.allSettled([background, pickup]); await app.close();
}

const child = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: '3098' }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', data => { output += data; });
child.stderr.on('data', data => { output += data; });
try {
  let health;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { health = await fetch('http://127.0.0.1:3098/health'); if (health.ok) { break; } } catch { /* Wait for startup. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(health?.status, 200, output);
  assert.equal((await fetch('http://127.0.0.1:3098/api/auth/bootstrap-needed')).status, 200);
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
  }
}
console.log(JSON.stringify({ passed: true, blockedBackgroundPickupMs: Math.round(elapsed * 100) / 100,
  mixedRequests: 9, operatorPeak: 3, serverHealth: 200, databaseProbe: 200 }));
