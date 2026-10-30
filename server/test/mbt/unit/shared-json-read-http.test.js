import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { get } from 'node:http';
import test from 'node:test';
import express from 'express';
import fc from 'fast-check';
import { createSharedJsonRead } from '../../../src/shared-json-read.js';

const serverSource = readFileSync(new URL('../../../src/server.js', import.meta.url), 'utf8');
const route = serverSource.match(/app\.get\("\/api\/dispatch\/planned-assignments", (async[\s\S]*?\n\})\);/)[1];

// fetch adds Cache-Control: no-cache to conditional requests. Use HTTP directly
// so the request exercises ordinary If-None-Match / 304 semantics.
function conditionalGet(url, etag) {
  return new Promise((resolve, reject) => {
    get(url, { headers: { 'If-None-Match': etag } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ status: response.statusCode, text: async () => body, json: async () => JSON.parse(body) });
      });
      response.on('error', reject);
    }).on('error', reject);
  });
}

async function serve(t, load, onArrival = () => {}) {
  const app = express();
  const handler = new Function('listDispatchPlannedAssignments', 'readPlannedAssignmentsResponse', `return (${route});`)(load, createSharedJsonRead(load));
  app.get('/api/dispatch/planned-assignments', (req, res, next) => { onArrival(); return handler(req, res, next); });
  app.get('/baseline', async (req, res) => { res.json(await load({ includeSnapshots: req.query.includeSnapshots !== 'false' })); });
  app.use((error, req, res, _next) => { res.status(500).json({ error: error.message }); });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('real route coalesces a concurrent burst including response serialization', async t => {
  let loads = 0;
  let arrivals = 0;
  let release;
  let serializations = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const base = await serve(t, async () => {
    loads++;
    await gate;
    return [{ toJSON() { serializations++; return { orderRef: 'SO-5825', data: 'x'.repeat(32768) }; } }];
  }, () => { if (++arrivals === 16) { release(); } });
  const responses = await Promise.all(Array.from({ length: 16 }, () => fetch(`${base}/api/dispatch/planned-assignments`).then(async res => ({ status: res.status, body: await res.json(), etag: res.headers.get('etag') }))));
  assert.equal(loads, 1);
  assert.equal(serializations, 1);
  assert.ok(responses.every(res => res.status === 200 && res.body[0].orderRef === 'SO-5825' && res.body[0].data.length === 32768 && res.etag === responses[0].etag));
});

test('real route preserves Express JSON, UTF-8 headers, ETag and conditional GET', async t => {
  let rows = [];
  const seen = [];
  const base = await serve(t, options => { seen.push(options); return rows; });
  await fc.assert(fc.asyncProperty(fc.array(fc.jsonValue(), { maxLength: 5 }), async value => {
    rows = value;
    const response = await fetch(`${base}/api/dispatch/planned-assignments`);
    const baseline = await fetch(`${base}/baseline`);
    assert.equal(response.status, baseline.status);
    for (const header of ['content-type', 'content-length', 'etag']) {
      assert.equal(response.headers.get(header), baseline.headers.get(header));
    }
    assert.equal(await response.text(), await baseline.text());
  }), { seed: 58250, numRuns: 35 });
  rows = [{ note: '雪😀<script>"&\u2028', empty: null }];
  const response = await fetch(`${base}/api/dispatch/planned-assignments?includeSnapshots=false`);
  assert.deepEqual(await response.json(), rows);
  assert.deepEqual(seen.at(-1), { includeSnapshots: false });
  const baselineUnchanged = await conditionalGet(`${base}/baseline?includeSnapshots=false`, response.headers.get('etag'));
  assert.equal(baselineUnchanged.status, 304);
  const unchanged = await conditionalGet(`${base}/api/dispatch/planned-assignments?includeSnapshots=false`, response.headers.get('etag'));
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');
  rows = [{ changed: true }];
  const changed = await conditionalGet(`${base}/api/dispatch/planned-assignments`, response.headers.get('etag'));
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), rows);
});

test('real route reports read failures and recovers on a subsequent request', async t => {
  let fail = true;
  const base = await serve(t, () => { if (fail) { throw new Error('temporary read failure'); } return []; });
  const failed = await fetch(`${base}/api/dispatch/planned-assignments`);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'temporary read failure' });
  fail = false;
  const recovered = await fetch(`${base}/api/dispatch/planned-assignments`);
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), []);
});
