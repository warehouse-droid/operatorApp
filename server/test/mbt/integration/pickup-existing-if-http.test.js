import assert from 'node:assert/strict';
import http from 'node:http';
import test, { before, after } from 'node:test';
import { config } from '../../../src/config.js';
import { query, closeDb } from '../../../src/db.js';
import { fetchPickupExistingFulfillment } from '../../../src/operator-pickup-existing-if-source.js';
import { createOperatorNetSuitePostingRealSourceResolver, createOperatorNetSuitePostingTargetResolver } from '../../../src/operator-netsuite-posting-targets.js';
import { buildOperatorNetSuitePostingDraft } from '../../../src/operator-netsuite-posting-domain.js';
import { pickupEvidence, pickupCommand } from '../../support/pickup-existing-if-fixture.mjs';

const previous = { ...config.netsuite };
const e = pickupEvidence(), calls = [];
let server, base, status = 'Sales Order : Billed', failRecord = false;
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  await query("INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,'pickup-http-test',now()+interval '1 hour') ON CONFLICT(id) DO UPDATE SET access_token=EXCLUDED.access_token,expires_at=EXCLUDED.expires_at");
  server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) { body += chunk; }
    const path = new URL(req.url, base).pathname; calls.push({ method: req.method, path });
    res.setHeader('content-type', 'application/json');
    if (path.endsWith('/query/v1/suiteql')) {
      const sql = JSON.parse(body).q;
      const items = sql.includes('NextTransactionLineLink') ? e.links.map(row => ({
        source_order_id: row.sourceOrderId, source_record_type: row.sourceRecordType, source_order_ref: row.sourceOrderRef,
        source_order_line: row.sourceOrderLine, source_line_key: row.sourceLineKey, transaction_id: row.transactionId,
        transaction_type: row.transactionType, transaction_ref: row.transactionRef, status_text: row.statusText,
        transaction_line: row.transactionLine, transaction_line_key: '551113', item_id: row.itemId,
        quantity: row.quantity, unit: row.unit, location_id: row.locationId
      })) : [{ id: '963502', tranid: 'SOA07444', status_text: status }];
      res.end(JSON.stringify({ items, count: items.length, hasMore: false })); return;
    }
    if (path.endsWith('/salesOrder/963502')) { res.end(JSON.stringify({ item: { items: e.sourceItems } })); return; }
    if (path.endsWith('/itemFulfillment/977092')) {
      res.statusCode = failRecord ? 404 : 200;
      res.end(JSON.stringify(failRecord ? {} : e.records[0])); return;
    }
    res.statusCode = 400; res.end(JSON.stringify({ unexpected: path }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/services/rest`;
  Object.assign(config.netsuite, { directAccessEnabled: true, restBaseUrl: base });
});
after(async () => { Object.assign(config.netsuite, previous); await new Promise(resolve => server.close(resolve)); await closeDb(); });

async function resolution() {
  const source = createOperatorNetSuitePostingRealSourceResolver({ useStoredOrderLines: true, fetchPickupSource: fetchPickupExistingFulfillment,
    query: async () => ({ rows: [{ source_line_key: '4828215', netsuite_order_line: 1, item_id: 2875, quantity: 109, location_id: 1 }] }) });
  return createOperatorNetSuitePostingTargetResolver({ getDeliveryOrder: async () => e.order,
    getReceivableReceivingOrder: async () => null, resolveRealSource: source })({ functionKey: 'customer_pickup', orderId: 963502, clientLocationId: 1 });
}
function draft(result) {
  return buildOperatorNetSuitePostingDraft({ ...result, requestId: pickupCommand().requestId, actorOperatorId: 'test', photoRefs: [],
    policy: { gateKey: 'operator_netsuite_customer_pickup_if_3445', revision: 1, effective: true, functionKey: 'customer_pickup', transactionType: 'IF', locationId: 1, yardCode: '3445' } });
}

test('real NetSuite HTTP readers resolve the existing IF with query/GET only and create zero posting steps', async () => {
  const begin = calls.length; const command = draft(await resolution());
  assert.equal(command.steps.length, 0);
  assert.equal(command.lineReconciliation.lines[0].linkedTransactions[0].ref, 'IF151113');
  assert.deepEqual(calls.slice(begin).map(row => row.method), ['POST', 'GET', 'POST', 'GET']);
  assert.ok(calls.slice(begin).every(row => row.method === 'GET' || row.path.endsWith('/query/v1/suiteql')));
});

test('normal open pickup adds one read-only status query and retains its exact posting quantity', async () => {
  status = 'Sales Order : Pending Fulfillment';
  try {
    const begin = calls.length; const command = draft(await resolution());
    assert.equal(command.steps.length, 1);
    assert.equal(command.steps[0].payload.item.items[0].quantity, 109);
    assert.deepEqual(calls.slice(begin), [{ method: 'POST', path: '/services/rest/query/v1/suiteql' }]);
  } finally { status = 'Sales Order : Billed'; }
});

test('unreadable existing IF blocks before any transform HTTP request', async () => {
  failRecord = true;
  try {
    const begin = calls.length;
    await assert.rejects(resolution(), { code: 'OPERATOR_PICKUP_EXISTING_IF_UNVERIFIED' });
    assert.ok(calls.slice(begin).every(row => !row.path.includes('/!transform/')));
  } finally { failRecord = false; }
});
