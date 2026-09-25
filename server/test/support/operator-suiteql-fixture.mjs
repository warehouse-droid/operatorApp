import assert from 'node:assert/strict';
import http from 'node:http';
import { config } from '../../src/config.js';
import { query, closeDb } from '../../src/db.js';
import { suiteql, fetchItemFulfillmentFromNetSuite } from '../../src/netsuite.js';
import { operatorNetSuiteRequestPool } from '../../src/operator-netsuite-request-pool.js';

export function latch() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

export async function deadline(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

export async function fixture() {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const previous = { ...config.netsuite };
  await query("INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,'suiteql-test-only',now()+interval '1 hour') ON CONFLICT(id) DO UPDATE SET access_token=EXCLUDED.access_token,expires_at=EXCLUDED.expires_at");
  const state = { handle: async () => ({ status: 500, data: { error: 'Unexpected request' } }) };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) { body += chunk; }
    try {
      const result = await state.handle({ url: new URL(req.url, 'http://localhost'),
        method: req.method, body: body ? JSON.parse(body) : null });
      res.writeHead(result.status || 200, { 'content-type': 'application/json', ...result.headers });
      res.end(JSON.stringify(result.data));
    } catch (error) {
      res.writeHead(500); res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(config.netsuite, { directAccessEnabled: true,
    restBaseUrl: `http://127.0.0.1:${server.address().port}/services/rest` });
  return {
    state,
    async close() {
      Object.assign(config.netsuite, previous);
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await closeDb();
    }
  };
}

export async function mixedQueueScenario(state, count, failAt) {
  const backgroundStarted = latch(), backgroundRelease = latch(), waveStarted = latch(), waveRelease = latch();
  const started = [], tasks = [];
  let active = 0, peak = 0;
  state.handle = async ({ url, body }) => {
    const tag = body?.q || `op-${Number(url.pathname.split('/').at(-1)) - 7000}`;
    started.push(tag);
    if (tag.startsWith('background-')) {
      if (tag === 'background-0') { backgroundStarted.resolve(); await backgroundRelease.promise; }
      return { status: tag === 'background-1' ? 400 : 200, data: { items: [{ tag }] } };
    }
    active++; peak = Math.max(peak, active);
    if (active === 3) { waveStarted.resolve(); }
    try {
      await waveRelease.promise;
      await new Promise(resolve => setTimeout(resolve, 2));
      const index = Number(tag.slice(3));
      return { status: index === failAt ? 400 : 200,
        data: body ? { items: [{ tag }] } : { id: 7000 + index, tranId: tag } };
    } finally { active--; }
  };
  const observe = promise => { promise.catch(() => {}); tasks.push(promise); return promise; };
  const background = observe(suiteql('background-0'));
  try {
    await deadline(backgroundStarted.promise, 'Background query did not start');
    const operators = Array.from({ length: count }, (_, index) => observe(operatorNetSuiteRequestPool.run(() =>
      index % 3 === 1 ? fetchItemFulfillmentFromNetSuite(7000 + index) : suiteql(`op-${index}`))));
    const laterBackground = [observe(suiteql('background-1')), observe(suiteql('background-2'))];
    await deadline(waveStarted.promise, 'Three Operator requests must run while background SQL is blocked');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(active, 3, 'Operator SQL and REST share the three-request limit');
    assert.deepEqual(started.filter(tag => tag.startsWith('background-')), ['background-0'], 'Background work remains serialized outside Operator context');
    waveRelease.resolve();
    const outcomes = await deadline(Promise.allSettled(operators), 'Operator requests waited for the background queue');
    assert.equal(peak, 3);
    assert.equal(active, 0);
    for (const [index, outcome] of outcomes.entries()) {
      if (index === failAt) {
        assert.equal(outcome.status, 'rejected');
        assert.match(outcome.reason.message, /400/);
      } else {
        assert.equal(outcome.status, 'fulfilled');
        assert.equal(index % 3 === 1 ? outcome.value.tranId : outcome.value.items[0].tag, `op-${index}`);
      }
    }
    assert.deepEqual(started.filter(tag => tag.startsWith('op-')).sort(), Array.from({ length: count }, (_, index) => `op-${index}`).sort(), 'Each request executes exactly once');
    backgroundRelease.resolve();
    assert.deepEqual((await background).items, [{ tag: 'background-0' }]);
    const tails = await Promise.allSettled(laterBackground);
    assert.equal(tails[0].status, 'rejected');
    assert.deepEqual(tails[1].value.items, [{ tag: 'background-2' }]);
    assert.deepEqual(started.filter(tag => tag.startsWith('background-')), ['background-0', 'background-1', 'background-2']);
  } finally {
    backgroundRelease.resolve(); waveRelease.resolve();
    await Promise.allSettled(tasks);
  }
}
