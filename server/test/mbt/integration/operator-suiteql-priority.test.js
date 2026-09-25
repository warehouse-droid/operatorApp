import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import fc from 'fast-check';
import { suiteql, suiteqlAll } from '../../../src/netsuite.js';
import { fetchPickupExistingFulfillment } from '../../../src/operator-pickup-existing-if-source.js';
import { operatorNetSuiteRequestPool } from '../../../src/operator-netsuite-request-pool.js';
import { operatorPostingTelemetry } from '../../../src/operator-netsuite-posting-telemetry.js';
import { fixture, latch, deadline, mixedQueueScenario } from '../../support/operator-suiteql-fixture.mjs';

let app;
before(async () => { app = await fixture(); });
after(async () => { await app.close(); });

test('SOB121250 regression: pickup status validation finishes while background SuiteQL remains blocked', async () => {
  const started = latch(), release = latch();
  let statusQuery;
  app.state.handle = async ({ body }) => {
    if (body.q === 'background-held') { started.resolve(); await release.promise; return { data: { items: [] } }; }
    statusQuery = body.q;
    return { data: { items: [{ id: '1012515', tranid: 'SOB121250', status_text: 'Sales Order : Pending Fulfillment' }] } };
  };
  const background = suiteql('background-held');
  let pickup;
  try {
    await deadline(started.promise, 'Background request never started');
    pickup = fetchPickupExistingFulfillment({ sourceNetSuiteId: 1012515, sourceOrderRef: 'SOB121250', selectedItems: [] });
    assert.equal(await deadline(pickup, 'Pickup validation is stuck behind unrelated SuiteQL'), null);
    assert.match(statusQuery, /t\.id IN \(1012515\)/u);
    assert.match(statusQuery, /t\.type = 'SalesOrd'/u);
  } finally { release.resolve(); await Promise.allSettled([background, pickup]); }
});

test('mixed SQL/REST load preserves the Operator limit, background FIFO, failures and exact results', async () => {
  await mixedQueueScenario(app.state, 10, 1);
});

test('Operator SuiteQL retains parameters, pagination, retries, errors and command timing attribution', async () => {
  const calls = [], events = [];
  const originalInfo = console.info;
  console.info = entry => events.push(JSON.parse(entry));
  app.state.handle = async request => {
    calls.push({ path: request.url.pathname, query: request.url.search, body: request.body });
    if (request.body.q === 'invalid') { return { status: 400, data: { error: 'invalid test query' } }; }
    if (calls.length === 1) { return { status: 429, headers: { 'retry-after': '0.001' }, data: {} }; }
    const offset = Number(request.url.searchParams.get('offset') || 0);
    return { data: { items: [{ offset }], hasMore: offset === 0, count: 1 } };
  };
  try {
    const rows = await operatorPostingTelemetry.context({ commandId: 'queue-test', stage: 'source_validation' }, () =>
      operatorNetSuiteRequestPool.run(() => suiteqlAll('SELECT test', [1012515], { pageSize: 1 })));
    assert.deepEqual(rows, [{ offset: 0 }, { offset: 1 }]);
    assert.deepEqual(calls.map(row => row.body), Array.from({ length: 3 }, () => ({ q: 'SELECT test', params: [1012515] })));
    assert.deepEqual(calls.map(row => row.query), ['?limit=1', '?limit=1', '?limit=1&offset=1']);
    assert.deepEqual(events.filter(row => row.operation === 'netsuite.http').map(row => [row.attempt, row.status]), [[1, 429], [2, 200], [1, 200]]);
    assert.ok(events.some(row => row.operation === 'netsuite.queue' && row.queue === 'operator'));
    assert.ok(events.every(row => row.commandId === 'queue-test' && row.stage === 'source_validation'));
    await assert.rejects(operatorNetSuiteRequestPool.run(() => suiteql('invalid')), /SuiteQL failed: 400/u);
    assert.equal(calls.filter(row => row.body.q === 'invalid').length, 1);
    assert.deepEqual((await operatorNetSuiteRequestPool.run(() => suiteql('valid'))).items, [{ offset: 0 }]);
  } finally { console.info = originalInfo; }
});

test('property: independent queues preserve bounded mixed concurrency and every outcome', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 4, max: 12 }), fc.nat({ max: 11 }),
    (count, failure) => mixedQueueScenario(app.state, count, failure % count)),
  { seed: 24092026, numRuns: 16, endOnFailure: true });
});
