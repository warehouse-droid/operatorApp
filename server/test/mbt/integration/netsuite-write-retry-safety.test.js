import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { config } from '../../../src/config.js';
import { query, closeDb } from '../../../src/db.js';
import { createPurchaseOrderInNetSuite, fetchItemFulfillmentFromNetSuite } from '../../../src/netsuite.js';

const previous = { ...config.netsuite }, nativeFetch = globalThis.fetch;
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  Object.assign(config.netsuite, { directAccessEnabled: true, restBaseUrl: 'https://netsuite.invalid/services/rest' });
  await query("INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,'retry-synthetic-token',now()+interval '1 hour') ON CONFLICT(id) DO UPDATE SET access_token=EXCLUDED.access_token,expires_at=EXCLUDED.expires_at");
});
after(async () => { globalThis.fetch = nativeFetch; Object.assign(config.netsuite, previous); await closeDb(); });

function transport(responses) {
  const calls = [];
  globalThis.fetch = async (input, options) => {
    assert.equal(new URL(input).origin, 'https://netsuite.invalid');
    calls.push({ method: options.method, body: options.body });
    const row = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(row.body || {}), { status: row.status,
      headers: { 'content-type': 'application/json', ...(row.status < 300 ? { location: 'https://netsuite.invalid/record/v1/purchaseOrder/123' } : {}) } });
  };
  return calls;
}
test('an ambiguous write response is never retried even when its message mentions request limits', async () => {
  for (const status of [500, 502, 503, 504]) {
    const calls = transport([{ status, body: { message: 'Request may have been processed; exceeded request timeout' } }]);
    await assert.rejects(createPurchaseOrderInNetSuite({ memo: 'Synthetic PO' }), error => error.status === status);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
  }
});
test('read-only record requests retain transient 503 recovery', async () => {
  const calls = transport([{ status: 503 }, { status: 200, body: { id: 123, item: { items: [] } } }]);
  assert.deepEqual(await fetchItemFulfillmentFromNetSuite(123), { id: 123, item: { items: [] } });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.method === 'GET'));
});
for (const response of [{ status: 429 }, { status: 503, body: { 'o:errorDetails': [{ 'o:errorCode': 'CONCURRENT_REQUEST_LIMIT_EXCEEDED' }] } }]) {
  test(`an explicit concurrency rejection (${response.status}) may retry the exact write`, async () => {
    const calls = transport([response, { status: 201 }]);
    assert.equal((await createPurchaseOrderInNetSuite({ memo: 'Synthetic PO' })).id, 123);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], calls[0]);
  });
}
test('explicit concurrency retries stop after four attempts', async () => {
  const calls = transport([{ status: 429 }]);
  await assert.rejects(createPurchaseOrderInNetSuite({ memo: 'Synthetic PO' }), error => error.status === 429);
  assert.equal(calls.length, 4);
});
