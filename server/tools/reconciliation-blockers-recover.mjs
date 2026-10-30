import assert from 'node:assert/strict';
import { query, closeDb } from '../src/db.js';
import { writeAudit } from '../src/auth-repository.js';
import { synchronizeReturnBatchAuthorization } from '../src/return-batch-ra-service.js';

// Recovery only reads the existing NetSuite transaction. Reject a financial write
// before it can reach the network, even if a future service change tries one.
const originalFetch = globalThis.fetch;
let readRequests = 0;
globalThis.fetch = async (url, options = {}) => {
  const pathname = new URL(String(url)).pathname;
  const method = String(options.method || 'GET').toUpperCase();
  const read = ['GET', 'HEAD'].includes(method)
    || (method === 'POST' && /\/(?:query\/v1\/suiteql|oauth2\/v1\/token)$/.test(pathname));
  assert.ok(read, `Recovery cannot send ${method} ${pathname}`);
  readRequests++;
  return originalFetch(url, options);
};

try {
  const before = (await query('SELECT * FROM return_batch_authorizations WHERE batch_id=27')).rows[0];
  assert.equal(Number(before.netsuite_transaction_id), 1077652);
  assert.equal(before.netsuite_transaction_ref, 'CMM02514');
  assert.equal(before.intent_snapshot.transactionType, 'credit_memo');
  assert.equal(before.draft_id, null);
  await synchronizeReturnBatchAuthorization({ recordId: 36, reconcile: true });
  const after = (await query('SELECT * FROM return_batch_authorizations WHERE batch_id=27')).rows[0];
  assert.equal(after.sync_status, 'succeeded');
  assert.equal(after.automatic_retry_blocked, false);
  assert.equal(after.sync_error_code, null);
  assert.equal(after.netsuite_transaction_id, before.netsuite_transaction_id);
  assert.equal(after.sync_attempts, before.sync_attempts);
  assert.deepEqual(after.intent_snapshot, before.intent_snapshot);
  const result = { recoveredAt: new Date().toISOString(), returnReference: 'SR-000007',
    transactionRef: after.netsuite_transaction_ref, status: after.sync_status,
    remoteStatus: after.netsuite_transaction_status, remoteTotal: after.netsuite_snapshot.total,
    originalMaterialLines: after.intent_snapshot.lines.length,
    observedRows: after.netsuite_snapshot.item.items.length,
    automaticRetryBlocked: after.automatic_retry_blocked, netSuiteWrites: 0, readRequests };
  await writeAudit({ actorType: 'system', source: 'maintenance',
    action: 'returns.reconciliation_blocker.resolved', details: result });
  console.log(JSON.stringify(result));
} finally {
  globalThis.fetch = originalFetch;
  await closeDb();
}
