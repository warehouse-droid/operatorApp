import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { createSharedJsonRead } from '../../../src/shared-json-read.js';

const deferred = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};

test('overlapping reads perform one load and share one encoded response', async () => {
  const gate = deferred();
  let loads = 0;
  const read = createSharedJsonRead(async options => {
    loads++;
    await gate.promise;
    assert.deepEqual(options, { includeSnapshots: true });
    return [{ orderRef: 'SO-5825', note: '雪 <>& 😀' }];
  });
  const reads = Array.from({ length: 64 }, () => read(true));
  await Promise.resolve();
  assert.equal(loads, 1);
  gate.release();
  const responses = await Promise.all(reads);
  for (const response of responses) {
    assert.strictEqual(response, responses[0]);
    assert.ok(Buffer.isBuffer(response.body));
    assert.deepEqual(JSON.parse(response.body), [{ orderRef: 'SO-5825', note: '雪 <>& 😀' }]);
  }
  assert.match(responses[0].etag, /^W\/"[a-f0-9]+-[A-Za-z0-9+/]{27}"$/);
});

test('snapshot modes stay separate and completed reads never cache stale data', async () => {
  const gate = deferred();
  const seen = [];
  let revision = 1;
  const read = createSharedJsonRead(async ({ includeSnapshots }) => {
    seen.push(includeSnapshots);
    await gate.promise;
    return [{ revision, includeSnapshots }];
  });
  const full = read(true);
  const light = read(false);
  await Promise.resolve();
  assert.deepEqual(seen, [true, false]);
  gate.release();
  const [a, b] = await Promise.all([full, light]);
  assert.notEqual(a.etag, b.etag);
  assert.equal(JSON.parse(b.body)[0].includeSnapshots, false);
  revision++;
  const fresh = await read(true);
  assert.equal(JSON.parse(fresh.body)[0].revision, 2);
  assert.notEqual(fresh.etag, a.etag);
  assert.deepEqual(seen, [true, false, true]);
});

test('a rejected load is shared and a later read retries', async () => {
  const failure = new Error('upstream read failed');
  let loads = 0;
  const read = createSharedJsonRead(async () => {
    if (++loads === 1) { throw failure; }
    return [];
  });
  const results = await Promise.allSettled([read(false), read(false)]);
  assert.equal(loads, 1);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason === failure));
  assert.equal((await read(false)).body.toString(), '[]');
  assert.equal(loads, 2);
});

test('serialization failure releases the pending read', async () => {
  const cyclic = {};
  cyclic.self = cyclic;
  let loads = 0;
  const read = createSharedJsonRead(() => ++loads === 1 ? [cyclic] : [{ ok: true }]);
  const results = await Promise.allSettled([read(true), read(true)]);
  assert.equal(loads, 1);
  assert.ok(results.every(result => result.status === 'rejected' && /circular/i.test(result.reason.message)));
  assert.deepEqual(JSON.parse((await read(true)).body), [{ ok: true }]);
  assert.equal(loads, 2);
});

test('property: JSON values survive bursts, mode separation, and a fresh next read', async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.jsonValue(), { maxLength: 8 }), fc.integer({ min: 2, max: 32 }),
    async (rows, readers) => {
      let loads = 0;
      const read = createSharedJsonRead(({ includeSnapshots }) => {
        loads++;
        return [{ includeSnapshots, rows }];
      });
      const responses = await Promise.all(Array.from({ length: readers }, () => read(true)));
      assert.equal(loads, 1);
      assert.ok(responses.every(response => response === responses[0]));
      assert.equal(responses[0].body.toString(), JSON.stringify([{ includeSnapshots: true, rows }]));
      const light = await read(false);
      assert.equal(light.body.toString(), JSON.stringify([{ includeSnapshots: false, rows }]));
      assert.notEqual(light.etag, responses[0].etag);
      await read(true);
      assert.equal(loads, 3);
    }
  ), { seed: 5825, numRuns: 75 });
});
