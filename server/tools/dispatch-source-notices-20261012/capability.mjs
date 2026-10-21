import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { query, withTransaction, closeDb } from './src/db.js';
import { dispatchSourceNoticeChanges } from './src/dispatch-source-notice-policy.js';

try {
  assert.equal((await fetch('http://127.0.0.1:3000/api/dispatch/plans/355/executed-order-reviews')).status, 401);
  const page = await fetch('http://127.0.0.1:3000/dispatch/planning');
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('/dispatch.js?v=20261012-source-notices'));
  const client = readFileSync('public/dispatch.js', 'utf8');
  assert.ok(client.includes('review.notifyDispatcher === false'));
  assert.ok(client.includes('review.noticeChanges || review.changes'));
  assert.ok(!client.includes('if (reason) routeNotice = reason;'));
  assert.ok(client.includes('/split-preview?type='));
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    const record = (await query(`SELECT r.order_ref,r.changes,r.token,co.id FROM dispatch_executed_order_reviews r
      JOIN local_co_orders co ON co.co_ref=r.order_ref WHERE r.order_ref='CO-SOA10106'
      ORDER BY r.observed_at DESC LIMIT 1`)).rows[0];
    assert.ok(record, 'The previously observed local CO notice must remain in its audit ledger');
    const changes = dispatchSourceNoticeChanges({ source: { type: 'CO', netsuiteId: -Number(record.id) }, changes: record.changes });
    assert.deepEqual(changes, []);
    return { localCoNoticeHidden: true, checkedOrder: record.order_ref, retainedLedgerToken: record.token };
  });
  console.log(JSON.stringify({ featureAvailable: true, unauthorizedBlocked: true, backgroundRefreshQuiet: true,
    splitFastPathRetained: true, noticeProjectionReadOnly: true, ...result }));
} finally { await closeDb(); }
