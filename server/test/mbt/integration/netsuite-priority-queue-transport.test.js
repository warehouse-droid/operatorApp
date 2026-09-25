import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import * as ns from '../../../src/netsuite.js';
import { config } from '../../../src/config.js';
import { query } from '../../../src/db.js';
import { withOperatorNetSuitePriority } from '../../../src/operator-netsuite-request-pool.js';
import { searchReturnCustomerDirectory, getReturnCustomerDirectoryStatus } from '../../../src/return-customer-directory.js';
import { fixture } from '../../support/operator-suiteql-fixture.mjs';
import { gate, until } from '../../support/netsuite-priority-queue-fixture.mjs';

let app;
const nativeFetch = globalThis.fetch;
before(async () => { app = await fixture(); });
after(async () => { globalThis.fetch = nativeFetch; await app.close(); });

test('response bodies hold slots; a 429 retry releases its slot while sleeping', async () => {
  const release = gate();
  let bodies = 0, requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return { status: 200, ok: true, headers: new Headers(), text: async () => {
      bodies++; await release.promise; bodies--; return '{"id":99}';
    } };
  };
  const held = Array.from({ length: 4 }, () => withOperatorNetSuitePriority(() => ns.fetchItemFulfillmentFromNetSuite(99)));
  let background;
  try {
    await until(() => bodies === 4, 'Four bodies must be in flight');
    background = ns.fetchItemReceiptFromNetSuite(99);
    await until(async () => Number((await query("SELECT count(*) FROM netsuite_request_queue WHERE state='waiting'")).rows[0].count) === 1, 'Background must wait for a full body');
    assert.equal(requests, 4); release.resolve();
    await Promise.all([...held, background]); assert.equal(requests, 5);
  } finally { release.resolve(); await Promise.allSettled([...held, background]); globalThis.fetch = nativeFetch; }

  const first = gate(), calls = [];
  let attempts = 0;
  app.state.handle = async ({ body }) => {
    calls.push(body.q);
    if (body.q === 'retrying' && ++attempts === 1) { first.resolve(); return { status: 429, headers: { 'retry-after': '0.2' }, data: {} }; }
    return { data: { items: [{ tag: body.q }] } };
  };
  const operator = withOperatorNetSuitePriority(() => ns.suiteql('retrying'));
  await first.promise;
  assert.equal((await ns.suiteql('background-during-retry')).items[0].tag, 'background-during-retry');
  await operator;
  assert.deepEqual(calls, ['retrying', 'background-during-retry', 'retrying']);
});

test('all mutation entry points keep methods, target IDs and payloads under Operator priority', async () => {
  const calls = [];
  app.state.handle = async request => {
    calls.push(request);
    return { status: 200, data: request.method === 'GET' ? { lastModifiedDate: '2026-09-24', item: { items: [] } } : {} };
  };
  const payload = { memo: 'priority-fixture' };
  const transfer = { item: { items: [{ line: 1, item: { id: '22' }, quantity: 1 }] } };
  const cases = [
    [() => ns.transformSalesOrderToItemFulfillment(55, payload), 'POST', '/salesorder/55/!transform/itemfulfillment', payload],
    [() => ns.transformTransferOrderToItemFulfillment(55, payload), 'POST', '/transferorder/55/!transform/itemfulfillment', payload],
    [() => ns.transformPurchaseOrderToItemReceipt(55, payload), 'POST', '/purchaseorder/55/!transform/itemreceipt', payload],
    [() => ns.transformTransferOrderToItemReceipt(55, payload), 'POST', '/transferorder/55/!transform/itemreceipt', payload],
    [() => ns.createTransferOrderInNetSuite(payload), 'POST', '/transferOrder', payload],
    [() => ns.updateTransferOrderInNetSuite(55, transfer), 'PATCH', '/transferOrder/55', transfer],
    [() => ns.createPurchaseOrderInNetSuite(payload), 'POST', '/purchaseOrder', payload],
    [() => ns.createSalesOrderInNetSuite(payload), 'POST', '/salesOrder', payload],
    [() => ns.transformEstimateToSalesOrderInNetSuite(55, payload), 'POST', '/estimate/55/!transform/salesOrder', payload],
    [() => ns.createOrUpdateReturnAuthorizationInNetSuite({ salesOrderId: 55, payload }), 'POST', '/salesOrder/55/!transform/returnAuthorization', payload],
    [() => ns.createOrUpdateCreditMemoInNetSuite({ payload }), 'POST', '/creditMemo', payload],
    [() => ns.createStandaloneReturnAuthorizationInNetSuite(payload), 'POST', '/returnAuthorization', payload],
    [() => ns.updateTransferOrderStatusInNetSuite(55), 'PATCH', '/transferOrder/55', { orderStatus: { id: 'B' } }]
  ];
  for (const [run, method, suffix, body] of cases) {
    const beforeCount = calls.length;
    await withOperatorNetSuitePriority(run);
    assert.equal(calls.length, beforeCount + 1);
    assert.equal(calls.at(-1).method, method);
    assert.ok(calls.at(-1).url.pathname.endsWith(suffix));
    assert.deepEqual(calls.at(-1).body, body);
  }
  const updated = await withOperatorNetSuitePriority(() => ns.updatePurchaseOrderHistoryInNetSuite(55, { header: { memo: 'updated' } }));
  assert.equal(updated.entityId, 55); assert.equal(updated.status, 200);
  assert.deepEqual(calls.slice(-2).map(row => row.method), ['GET', 'PATCH']);
  const beforeCount = calls.length;
  await withOperatorNetSuitePriority(() => ns.synchronizeSpecialSalesDescriptionsInNetSuite({ salesOrderId: 55, changes: [] }));
  assert.equal(calls.length, beforeCount, 'A no-op description synchronization must not write');
});

test('RESTlet JSON and PDF transports consume their complete response within a shared grant', async () => {
  const oldRestlet = config.smartScm.pickingTicketRestletUrl, oldFieldSales = process.env.FIELD_SALES_RESTLET_URL;
  config.smartScm.pickingTicketRestletUrl = 'https://queue-test.restlets.api.netsuite.com/app/site/hosting/restlet.nl';
  process.env.FIELD_SALES_RESTLET_URL = config.smartScm.pickingTicketRestletUrl;
  const replies = [
    { ok: true, result: 'estimate' }, { ok: true, sandbox: true }, '%PDF-1.7 fixture',
    { ok: true, entityId: 55, contentBase64: Buffer.from('%PDF-1.7 json-fixture').toString('base64') },
    { ok: false, message: 'fixture rejected' }, 'not-json'
  ];
  const requests = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(Number((await query("SELECT count(*) FROM netsuite_request_queue WHERE state='running'")).rows[0].count), 1);
    requests.push(JSON.parse(options.body));
    const reply = replies.shift(), pdf = typeof reply === 'string' && reply.startsWith('%PDF');
    await sleep(1);
    return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), {
      status: reply?.ok === false ? 400 : 200, headers: { 'content-type': pdf ? 'application/pdf' : 'application/json' }
    });
  };
  try {
    assert.equal((await ns.callFieldSalesRestlet('estimate', { id: 55 })).result, 'estimate');
    assert.equal((await ns.probeNetSuiteRestlet()).sandbox, true);
    assert.equal((await ns.fetchPickingTicketFromNetSuite(55)).buffer.toString(), '%PDF-1.7 fixture');
    assert.equal((await ns.fetchPickingTicketFromNetSuite(55)).buffer.toString(), '%PDF-1.7 json-fixture');
    await assert.rejects(ns.fetchPickingTicketFromNetSuite(55), /fixture rejected/u);
    await assert.rejects(ns.fetchPickingTicketFromNetSuite(55), /invalid JSON/u);
    assert.deepEqual(requests.map(row => row.action), ['estimate', 'health', 'pickingTicket', 'pickingTicket', 'pickingTicket', 'pickingTicket']);
    assert.equal(Number((await query('SELECT count(*) FROM netsuite_request_queue')).rows[0].count), 0);
  } finally {
    globalThis.fetch = nativeFetch; config.smartScm.pickingTicketRestletUrl = oldRestlet;
    if (oldFieldSales === undefined) { delete process.env.FIELD_SALES_RESTLET_URL; } else { process.env.FIELD_SALES_RESTLET_URL = oldFieldSales; }
  }
});

test('a customer-facing return lookup stays high priority while its detached full directory refresh is background', async () => {
  await query('DELETE FROM return_customer_directory');
  await query("UPDATE return_customer_directory_sync SET status='idle', last_successful_at=NULL, last_started_at=NULL, current_run_token=NULL");
  const entered = gate(), release = gate(), observed = [];
  app.state.handle = async ({ body }) => {
    if (body.q === 'directory-background-held') { entered.resolve(); await release.promise; return { data: { items: [] } }; }
    const priorities = (await query("SELECT priority FROM netsuite_request_queue WHERE state='running' ORDER BY priority DESC")).rows.map(row => row.priority);
    observed.push({ full: !body.q.includes('FETCH FIRST'), priorities });
    return { data: { items: [{ id: '777', entityid: 'C777', companyname: 'Priority Fixture', isinactive: 'F' }] } };
  };
  const held = ns.suiteql('directory-background-held');
  try {
    await entered.promise;
    const customers = await withOperatorNetSuitePriority(() => searchReturnCustomerDirectory('Priority Fixture'));
    assert.equal(customers[0].id, 777);
    await until(async () => (await getReturnCustomerDirectoryStatus()).status === 'running', 'Detached refresh must begin');
    assert.deepEqual(observed, [{ full: false, priorities: [1, 0] }]);
    release.resolve(); await held;
    await until(async () => (await getReturnCustomerDirectoryStatus()).status === 'succeeded', 'Full refresh must resume after background capacity is free');
    assert.deepEqual(observed, [{ full: false, priorities: [1, 0] }, { full: true, priorities: [0] }]);
  } finally { release.resolve(); await held; }
});
