// HTTP and PostgreSQL side of the 2026-11-06 Special Request list stall: the Sales and SCM lists answer
// from saved SO/PO statuses without waiting for NetSuite, and a NetSuite status that did not change
// only renews freshness (no audit row, mirror event or page-reload broadcast).
import { assertIsolatedTestConnection } from '../support/test-database-isolation.mjs';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOperator } from '../../src/auth-repository.js';
import { query, closeDb } from '../../src/db.js';
import { persistSpecialOrderStatusObservation } from '../../src/special-stock-status-refresh.js';
import { app } from '../../src/server.js';
import { config } from '../../src/config.js';

const so = 8800401, po = 8800402, stamp = '2026-11-06 20:00:00.123456+00';
let caseId, server, base, token;
const previousMirrorRole = config.netSuiteMirror.role;
const observation = type => ({ orderType: type, netsuiteOrderId: type === 'sales_order' ? so : po,
  tranid: type === 'sales_order' ? 'TEST-STALL-SO' : 'TEST-STALL-PO', status: 'F',
  statusText: type === 'sales_order' ? 'Sales Order : Pending Billing' : 'Purchase Order : Pending Bill', syncedAt: stamp });

before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assertIsolatedTestConnection(process.env.DATABASE_URL);
  config.netSuiteMirror.role = 'source';
  await createOperator({ username: 'special-stall-test', displayName: 'TEST', password: 'test-stall-only',
    role: 'admin', roles: ['admin', 'sales', 'scm'], yardLocationIds: [1] });
  const operator = (await query("SELECT id FROM operators WHERE username='special-stall-test'")).rows[0];
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,synced_at,foreign_total,netsuite_active,fulfillment_status)
    VALUES($1,'TEST-STALL-SO','B','Sales Order : Pending Fulfillment',$2,10,true,'not_fulfilled')`, [so, stamp]);
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,synced_at,foreign_total,netsuite_active,receipt_status)
    VALUES($1,'TEST-STALL-PO','B','Purchase Order : Pending Receipt',$2,5,true,'not_received')`, [po, stamp]);
  caseId = Number((await query(`INSERT INTO sales_stock_requests(request_ref,request_type,destination_location_id,destination_name,requested_by)
    VALUES('SPREQ-TEST-STALL','special',1,'3445',$1) RETURNING id`, [operator.id])).rows[0].id);
  await query(`INSERT INTO sales_special_stock_cases(request_id,inquiry_date,customer_name,vendor_name,
    fulfillment_method,operational_yard_location_id,delivery_address,delivery_date,delivery_window_start,delivery_window_end,delivery_instructions,
    sales_order_netsuite_id,sales_order_ref,sales_order_status,sales_order_approved,purchase_order_netsuite_id,purchase_order_ref,purchase_order_status)
    VALUES($1,'2026-11-06','TEST Customer','TEST Vendor','mbt_delivery',1,'TEST Address','2026-11-10','09:00','10:00','TEST',
    $2,'TEST-STALL-SO','Old SO',true,$3,'TEST-STALL-PO','Old PO')`, [caseId, so, po]);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'special-stall-test', password: 'test-stall-only' }) });
  assert.equal(login.status, 200);
  token = (await login.json()).token;
});
after(async () => {
  config.netSuiteMirror.role = previousMirrorRole;
  if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  await closeDb();
});
beforeEach(async () => {
  for (const [table, id, label] of [['sales_orders', so, 'Sales Order : Pending Fulfillment'], ['purchase_orders', po, 'Purchase Order : Pending Receipt']]) {
    await query(`UPDATE ${table} SET status='B',status_text=$2,synced_at=$3 WHERE netsuite_id=$1`, [id, label, stamp]);
  }
});
async function counts() {
  return (await query(`SELECT (SELECT count(*) FROM delivery_audit_log WHERE action='special.order_status.refreshed')::int AS audit,
    (SELECT count(*) FROM netsuite_mirror_events WHERE change_type='status')::int AS mirror`)).rows[0];
}

test('Sales and SCM lists answer from saved statuses while NetSuite has not replied; one batch runs; statuses follow', async () => {
  const originalFetch = globalThis.fetch, originalConfig = { ...config.netsuite };
  let release; const pending = new Promise(done => { release = done; }); const calls = [];
  await query(`INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,'isolated-stall-test',now()+interval '1 day')
    ON CONFLICT(id) DO UPDATE SET access_token=EXCLUDED.access_token,expires_at=EXCLUDED.expires_at`);
  Object.assign(config.netsuite, { directAccessEnabled: true, restBaseUrl: 'https://special-stall.invalid/services/rest' });
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith(base + '/')) return originalFetch(url, options);
    const kind = JSON.parse(options.body).q.includes("'PurchOrd'") ? 'purchase_order' : 'sales_order';
    calls.push(kind);
    await pending;
    const observed = observation(kind);
    return new globalThis.Response(JSON.stringify({ items: [{ id: String(observed.netsuiteOrderId), tranid: observed.tranid,
      status: observed.status, status_text: observed.statusText }] }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    for (const audience of ['sales', 'scm']) {
      const response = await Promise.race([
        fetch(base + `/api/${audience}/special-stock-requests?search=SPREQ-TEST-STALL`, { headers: { authorization: `Bearer ${token}` } }),
        new Promise((_resolve, reject) => setTimeout(() => reject(Error(`${audience} list waited for NetSuite`)), 5000))
      ]);
      assert.equal(response.status, 200);
      const listed = (await response.json()).requests.find(row => row.id === caseId);
      assert.equal(listed.salesOrderStatus, 'Sales Order : Pending Fulfillment', 'the saved status is shown at once');
    }
    assert.deepEqual(calls, ['sales_order'], 'the second list load joins the batch already asking NetSuite');
    release();
    for (let attempt = 0; attempt < 100 && (await query('SELECT status FROM purchase_orders WHERE netsuite_id=$1', [po])).rows[0].status !== 'F'; attempt++) {
      await new Promise(done => setTimeout(done, 50));
    }
    assert.deepEqual((await query(`SELECT (SELECT status_text FROM sales_orders WHERE netsuite_id=$1) AS so,
      (SELECT status_text FROM purchase_orders WHERE netsuite_id=$2) AS po`, [so, po])).rows[0],
    { so: 'Sales Order : Pending Billing', po: 'Purchase Order : Pending Bill' });
  } finally {
    release();
    globalThis.fetch = originalFetch;
    Object.assign(config.netsuite, originalConfig);
    await query('DELETE FROM netsuite_tokens WHERE id=1');
  }
});

test('an unchanged NetSuite status renews freshness without an audit row or mirror event; a change still records both', async () => {
  const count = await counts();
  const unchanged = { ...observation('sales_order'), status: 'B', statusText: 'Sales Order : Pending Fulfillment' };
  assert.equal(await persistSpecialOrderStatusObservation(unchanged), false, 'nothing changed, so no page reload is broadcast');
  const row = (await query('SELECT status,status_text,synced_at>$2::timestamptz AS renewed FROM sales_orders WHERE netsuite_id=$1', [so, stamp])).rows[0];
  assert.deepEqual(row, { status: 'B', status_text: 'Sales Order : Pending Fulfillment', renewed: true });
  assert.deepEqual(await counts(), count);
  assert.equal(await persistSpecialOrderStatusObservation(unchanged), false, 'the renewed fence rejects a stale repeat');
  assert.equal(await persistSpecialOrderStatusObservation(observation('purchase_order')), true);
  assert.deepEqual(await counts(), { audit: count.audit + 1, mirror: count.mirror + 1 });
});
