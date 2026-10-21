import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parse } from 'espree';
import { compactDispatchOrderCard } from '../../../src/dispatch-planner-optimization.js';

const source = readFileSync(new URL('../../../src/server.js', import.meta.url), 'utf8');
const nodes = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true }).body;
function subject(names, extra = {}) {
  const context = vm.createContext({ console, Map, Set, Promise, Date, compactDispatchOrderCard, ...extra });
  for (const name of names) {
    const node = nodes.map(candidate => candidate.declaration || candidate).find(candidate => candidate.type === 'FunctionDeclaration' && candidate.id.name === name);
    assert.ok(node, name);
    vm.runInContext(source.slice(0, node.range[0]).replace(/[^\n]/g, ' ') + source.slice(...node.range), context, { filename: 'dispatch-freshness-vm:src/server.js' });
  }
  return context;
}

function routeHandler(method, path, context) {
  const route = nodes.find(node => node.type === 'ExpressionStatement' && node.expression.callee?.object?.name === 'app'
    && node.expression.callee?.property?.name === method && node.expression.arguments[0]?.value === path);
  assert.ok(route, path);
  const node = route.expression.arguments.at(-1);
  const assignment = 'globalThis.handler = ';
  const prefix = source.slice(0, node.range[0] - assignment.length).replace(/[^\n]/g, ' ');
  vm.runInContext(prefix + assignment + source.slice(...node.range), context, { filename: 'dispatch-freshness-vm:src/server.js' });
  return context.handler;
}

test('freshness: committed mutation reads cannot join an older in-flight order feed', async () => {
  let cached = 0, fresh = 0;
  const ui = subject(['listDispatchOrdersForResponse', 'targetedDispatchMutationOrders'], {
    dispatchOrderResponseSingleFlight: { run: async () => { cached++; return [{ id: 'SO-ONE', customer: 'old' }]; } },
    loadDispatchOrdersForResponse: async () => { fresh++; return [{ id: 'SO-ONE', customer: 'new' }]; }
  });
  const orders = await ui.targetedDispatchMutationOrders(['SO-ONE'], { fresh: true });
  assert.equal(orders[0].customer, 'new'); assert.equal(cached, 0); assert.equal(fresh, 1);
  assert.equal(orders[0].catalogHydrated, true);
});

test('freshness: explicit fresh HTTP read bypasses catalog and refuses an unrelated retired-order replacement', async () => {
  let cached = 0, requested;
  const context = subject([], {
    dispatchPrivateNoStore: () => {}, dispatchOrderPoolRuntimePolicy: async () => ({ effective: true }),
    getDispatchOrderCatalogOrder: async () => { cached++; return { id: 'SO-OLD' }; },
    targetedDispatchMutationOrders: async (refs, options) => { requested = options; return [{ id: 'SO-OTHER' }]; }
  });
  routeHandler('get', '/api/dispatch/v2/order-feed/:id', context);
  let status = 200, result;
  const res = { status: value => { status = value; return res; }, json: value => { result = value; } };
  await context.handler({ query: { fresh: 'true' }, params: { id: 'SO-OLD' } }, res, error => { throw error; });
  assert.equal(cached, 0); assert.equal(requested?.fresh, true);
  assert.equal(status, 404); assert.equal(result.code, 'DISPATCH_ORDER_NOT_FOUND');
});

test('freshness: targeted mutation responses acknowledge complete current order details', async () => {
  let bypassed = 0;
  const context = subject(['listDispatchOrdersForResponse', 'targetedDispatchMutationOrders', 'dispatchMutationOrderResponse'], {
    dispatchPrivateNoStore: () => {},
    dispatchOrderResponseSingleFlight: { run: async () => [{ id: 'SO-ONE', customer: 'old' }] },
    loadDispatchOrdersForResponse: async () => { bypassed++; return [{ id: 'SO-ONE', customer: 'committed' }]; }
  });
  const result = await context.dispatchMutationOrderResponse({ query: { response: 'targeted' }, res: {} }, ['SO-ONE']);
  assert.equal(result.orders[0].customer, 'committed');
  assert.equal(result.orders[0].catalogHydrated, true);
  assert.equal(result.orders[0].catalogDetailSignature, compactDispatchOrderCard({ id: 'SO-ONE', customer: 'committed' }).catalogDetailSignature);
  assert.equal(bypassed, 1);
});

test('freshness: detail responses preserve exact and numeric identities with a matching content signature', async () => {
  const order = { id: 'SO-ONE', netsuiteId: '123', items: [{ quantity: 7 }] };
  const context = subject([], {
    dispatchPrivateNoStore: () => {}, dispatchOrderPoolRuntimePolicy: async () => ({ effective: true }),
    getDispatchOrderCatalogOrder: async () => order,
    targetedDispatchMutationOrders: async () => [{ id: 'SO-OTHER' }, order]
  });
  const handler = routeHandler('get', '/api/dispatch/v2/order-feed/:id', context);
  for (const [id, fresh] of [['so-one', 'true'], ['123', 'true'], ['SO-ONE', undefined]]) {
    let result;
    await handler({ query: { fresh }, params: { id } }, { json: value => { result = value; } }, error => { throw error; });
    assert.equal(result.order.id, 'SO-ONE');
    assert.equal(result.order.catalogHydrated, true);
    assert.equal(result.order.catalogDetailSignature, compactDispatchOrderCard(order).catalogDetailSignature);
  }
});

test('freshness: further split publishes replacement identities for other open dispatch tabs', async () => {
  const events = [];
  const result = { orders: [{ id: 'SO-ONE-S3' }, { id: 'SO-ONE-S4' }], retiredGlobalOrderRefs: ['SO-ONE-S2'], planDigest: 'acknowledged' };
  const context = subject([], {
    requireDispatchPlanEditLease: async () => {}, resplitUnfinishedSalesOrder: async () => result,
    emitAppEvent: (type, payload) => events.push({ type, payload })
  });
  const handler = routeHandler('post', '/api/dispatch/split-orders/resplit', context);
  let response;
  await handler({ body: { orderRef: 'SO-ONE-S2', audit: { sessionId: 'origin' } } }, { json: value => { response = value; } }, error => { throw error; });
  assert.equal(response, result);
  assert.deepEqual([...events[0].payload.orderRefs], ['SO-ONE-S3', 'SO-ONE-S4']);
  assert.equal(events[0].payload.refreshOrderPool, true);
  assert.equal(events[0].payload.sourceSessionId, 'origin');
});

test('freshness: catalog completion publishes only after commit and never requeues itself', async () => {
  const events = [], order = [];
  const context = subject(['dispatchOrderCatalogTick', 'emitAppEvent'], {
    config: { dispatch: { plannerOrderPoolMode: 'on' } }, dispatchOrderCatalogTickRunning: false,
    catalogRefreshExecutor: { run: task => task() }, backfillDispatchPlanProjections: async () => {},
    claimDispatchOrderCatalogRefreshes: async () => [{ id: 1, orderRef: 'SO-ONE' }],
    targetedDispatchMutationOrders: async () => [{ id: 'SO-ONE' }],
    upsertDispatchOrderCatalog: async () => order.push('persist'),
    completeDispatchOrderCatalogRefresh: async () => order.push('complete'),
    failDispatchOrderCatalogRefresh: async () => assert.fail('refresh should complete'),
    afterTransactionCommit: task => { order.push('publish'); task(); }, eventSeq: 0,
    eventClients: new Set([{ detailed: true, res: { write: body => events.push(JSON.parse(body.match(/data: (.+)\n/u)[1])) } }]),
    enqueueDispatchOrderCatalogRefresh: () => assert.fail('self-enqueue'),
    enqueueScmPurchaseOrderCatalogRefresh: () => assert.fail('self-enqueue')
  });
  const result = await context.dispatchOrderCatalogTick();
  assert.equal(result.completed, 1); assert.deepEqual(order, ['persist', 'complete', 'publish']);
  assert.equal(events[0].type, 'dispatch.orders.updated');
  assert.equal(events[0].payload.catalogAlreadyQueued, true);
  assert.equal(events[0].payload.orderRef, 'SO-ONE');
});
