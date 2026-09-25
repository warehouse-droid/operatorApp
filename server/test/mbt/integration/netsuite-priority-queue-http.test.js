import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import express from 'express';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { query } from '../../../src/db.js';
import { suiteql, createStandaloneReturnAuthorizationInNetSuite, createSalesOrderInNetSuite,
  fetchReturnAuthorizationFromNetSuite, transformSalesOrderToItemFulfillment, fetchItemFulfillmentFromNetSuite } from '../../../src/netsuite.js';
import { fetchPickupExistingFulfillment } from '../../../src/operator-pickup-existing-if-source.js';
import { findReturnTransactionByExternalId } from '../../../src/return-netsuite.js';
import { operatorNetSuitePriority } from '../../../src/operator-netsuite-priority-middleware.js';
import { fixture, latch, deadline } from '../../support/operator-suiteql-fixture.mjs';

let app, httpServer, origin;
before(async () => {
  app = await fixture();
  const api = express();
  api.use(['/api/operator', '/api/returns', '/api/customer-pickup', '/api/inventory'], operatorNetSuitePriority);
  api.post('/api/customer-pickup/orders/1012515/load', async (_req, res, next) => {
    try {
      await fetchPickupExistingFulfillment({ sourceNetSuiteId: 1012515, sourceOrderRef: 'SOB121250', selectedItems: [] });
      const result = await transformSalesOrderToItemFulfillment(1012515, { externalId: 'priority-pickup' });
      res.json(await fetchItemFulfillmentFromNetSuite(result.id));
    } catch (error) { next(error); }
  });
  api.post('/api/returns/submit', async (_req, res, next) => {
    try {
      assert.equal(await findReturnTransactionByExternalId('priority-return', 'return_authorization'), null);
      const result = await createStandaloneReturnAuthorizationInNetSuite({ externalId: 'priority-return' });
      res.json(await fetchReturnAuthorizationFromNetSuite(result.id));
    } catch (error) { next(error); }
  });
  api.post('/api/inventory/sync', async (_req, res, next) => {
    try { res.json(await suiteql('bulk-sync')); } catch (error) { next(error); }
  });
  httpServer = await new Promise(resolve => { const server = api.listen(0, '127.0.0.1', () => resolve(server)); });
  origin = `http://127.0.0.1:${httpServer.address().port}`;
});
after(async () => { httpServer.closeAllConnections(); await new Promise(resolve => httpServer.close(resolve)); await app.close(); });

for (const [name, path, expectedType] of [
  ['pickup', '/api/customer-pickup/orders/1012515/load', 'itemFulfillment'],
  ['return', '/api/returns/submit', 'returnAuthorization']
]) {
  test(`${name}: validation, POST and verification GET finish while older background work is held`, async () => {
    const entered = latch(), release = latch();
    const seen = [];
    app.state.handle = async ({ url, method, body }) => {
      if (body?.externalId === 'background-order') { entered.resolve(); await release.promise; return { data: {} }; }
      seen.push({ path: url.pathname, method, body });
      if (body?.q) { return { data: { items: name === 'pickup'
        ? [{ id: '1012515', tranid: 'SOB121250', status_text: 'Sales Order : Pending Fulfillment' }] : [] } }; }
      if (method === 'POST') { return { status: 201, headers: { location: `${origin}/record/v1/${expectedType}/4321` }, data: {} }; }
      return { data: { id: 4321, tranId: name === 'pickup' ? 'IF-TEST' : 'RA-TEST' } };
    };
    const background = createSalesOrderInNetSuite({ externalId: 'background-order' });
    let operation;
    try {
      await deadline(entered.promise, 'Background mutation did not start');
      operation = fetch(`${origin}${path}`, { method: 'POST' }).then(async response => {
        assert.equal(response.status, 200); return response.json();
      });
      assert.equal((await deadline(operation, `${name} still waits behind background work`)).id, 4321);
      assert.equal(seen.filter(row => row.method === 'POST' && !row.body.q).length, 1, 'Exactly one business write');
      assert.ok(seen[0].body.q, 'Source/recovery validation precedes the write');
      assert.equal(seen.at(-1).method, 'GET', 'Result verification retains Operator priority');
    } finally { release.resolve(); await Promise.allSettled([background, operation]); }
  });
}

test('production routes assign priority after Operator access/yard guards, including return submit and lookups', () => {
  const source = readFileSync('src/server.js', 'utf8');
  assert.match(source, /app\.use\("\/api\/operator", requireOperator, requireOperatorAccess, requireOperatorYardRequest, operatorNetSuitePriority\)/u);
  for (const prefix of ['customer-pickup', 'delivery', 'receiving', 'inventory', 'cycle-count']) {
    assert.ok(source.includes(`app.use("/api/${prefix}", requireOperator, requireOperatorAccess, requireOperatorYardRequest, operatorNetSuitePriority);`), prefix);
  }
  for (const prefix of ['count-sheets', 'inventory/damage']) {
    assert.ok(source.includes(`app.use("/api/${prefix}", requireOperator, requireOperatorAccess, operatorNetSuitePriority,`), prefix);
  }
  const routes = [...source.matchAll(/app\.(?:get|post|delete)\("(\/api\/returns\/[^"\n]+)", requireOperator, requireOperatorAccess, requireOperatorYardRequest, ([^\n]+)/gu)];
  assert.ok(routes.length >= 10);
  for (const [line, path, middleware] of routes) { assert.ok(middleware.startsWith('operatorNetSuitePriority,'), `${path}: ${line}`); }
});

test('bulk Operator sync keeps background priority and cannot take reserved customer slots', async () => {
  const entered = latch(), release = latch();
  const seen = [];
  app.state.handle = async ({ body }) => {
    if (body.q === 'bulk-background-held') { entered.resolve(); await release.promise; return { data: { items: [] } }; }
    seen.push((await query("SELECT priority FROM netsuite_request_queue WHERE state='running'")).rows.map(row => row.priority));
    return { data: { items: [{ tag: body.q }] } };
  };
  const held = suiteql('bulk-background-held'); let bulk;
  try {
    await entered.promise;
    bulk = fetch(`${origin}/api/inventory/sync?requestedBy=operator`, { method: 'POST', headers: { 'x-netsuite-priority': 'operator' } }).then(response => response.json());
    await sleep(100); assert.deepEqual(seen, [], 'Bulk work waits behind active background work');
    release.resolve(); await held;
    assert.equal((await deadline(bulk, 'Bulk sync must resume')).items[0].tag, 'bulk-sync');
    assert.deepEqual(seen, [[0]]);
  } finally { release.resolve(); await Promise.allSettled([held, bulk]); }
});
