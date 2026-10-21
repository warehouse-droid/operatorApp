import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parse } from 'espree';
import fc from 'fast-check';

const source = readFileSync(new URL('../../../public/dispatch.js', import.meta.url), 'utf8');
const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true }).body;
function fixture({ quantities = [36, 2232], event = 'unrelated', failure = false, incomplete = false, downgrade = false, repeat = false } = {}) {
  const full = quantities.map((quantity, index) => ({ id: `SO-${index}-S5`, type: 'SO', catalogHydrated: true,
    items: [{ lineId: index, quantity }], itemCount: 1 }));
  const requests = [];
  const timers = [];
  const context = vm.createContext({
    Map, Set, Promise, String, Array, JSON, console,
    orders: structuredClone(full).map((order, i) => ({ ...order, catalogHydrated: i !== 0 })),
    orderCatalog: [], selectedIds: full.map(order => order.id),
    dispatchGroupHydrationPromise: null, dispatchGroupHydrationRefs: new Set(),
    dispatchGroupHydrationInvalidated: false, dispatchGroupRefreshPending: false,
    dispatchOrderRefreshEpoch: 0, dispatchOrderReadSequence: 0, dispatchOrderAppliedReads: new Map(),
    dispatchOrderReadRequests: new Map(), dispatchOrderSearchCache: new Map(),
    localPlanGeneration: 0, currentPlan: { id: '364' }, currentPlanDate: '2026-10-20',
    orderPoolRefreshReason: '', orderPoolRefreshTimer: null, orderPoolRefreshInFlight: false,
    pendingDispatchOrderRefreshRefs: new Set(), pendingDispatchRequiredRefreshRefs: new Set(),
    window: { clearTimeout() {}, setTimeout(fn) { timers.push(fn); return timers.length; } },
    dispatchOrderRefKey: value => String(value || '').toUpperCase(),
    renderDispatchOrderPoolPatch() {}, isAuthoritativelyRetiredOrderRef: () => false,
    dispatchErrorMessage: async () => 'Details unavailable',
    fetch: async url => {
      const ref = decodeURIComponent(new URL(url, 'http://test').pathname.split('/').at(-1));
      requests.push(ref);
      await new Promise(resolve => setImmediate(resolve));
      if (requests.length === 1 || repeat) {
        const payload = event === 'unknown' ? {} : { orderId: event === 'related' ? ref : 'SO-OTHER' };
        context.queueDispatchOrderPoolRefresh('update', payload);
        if (downgrade) context.orders[1].catalogHydrated = false;
      }
      return { ok: !failure, json: async () => ({ order: { ...full.find(order => order.id === ref), catalogHydrated: !incomplete } }) };
    }
  });
  context.selectedOrders = () => context.selectedIds.map(id => context.orders.find(order => order.id === id));
  context.orderById = id => context.orders.find(order => order.id === id);
  context.mergeDispatchOrderSearchFeed = feed => { context.orders = context.orders.map(order => feed.find(value => value.id === order.id) || order); };
  for (const name of ['dispatchOrderReadToken', 'dispatchOrderReadIsCurrent', 'applyTargetedDispatchOrderUpdate',
    'hydrateDispatchGroupSelection', 'dispatchGroupOrderNeedsHydration', 'canonicalDispatchOrderType',
    'isAggregateDispatchCoGroup', 'queueDispatchOrderPoolRefresh', 'dispatchRelatedRefreshRefs']) {
    const node = declarations.find(entry => entry.type === 'FunctionDeclaration' && entry.id.name === name);
    assert.ok(node);
    vm.runInContext(source.slice(0, node.range[0]).replace(/[^\n]/g, ' ') + source.slice(...node.range), context,
      { filename: 'public/dispatch.js' });
  }
  return { context, requests, full, timers };
}

test('property: grouping preserves quantities through unrelated, related, and unspecified refresh events', async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 100000 }), { minLength: 2, maxLength: 6 }),
    fc.constantFrom('related', 'unrelated', 'unknown'), async (quantities, event) => {
      const f = fixture({ quantities, event });
      const result = await f.context.hydrateDispatchGroupSelection();
      assert.deepEqual(Array.from(result, order => order.items[0].quantity), quantities);
      assert.ok(result.every(order => order.catalogHydrated));
      assert.equal(f.context.dispatchGroupHydrationPromise, null);
      assert.ok(f.timers.length > 0, 'Deferred background work must resume');
      assert.equal(f.requests.length, event === 'unrelated' ? 1 : quantities.length + 1);
    }), { seed: 20261020, numRuns: 40 });
});

test('an order becoming incomplete during another detail read is hydrated before grouping', async () => {
  const f = fixture({ downgrade: true });
  const result = await f.context.hydrateDispatchGroupSelection();
  assert.ok(result.every(order => order.catalogHydrated));
  assert.ok(f.requests.includes('SO-1-S5'));
});

test('repeated selected-order updates are bounded and incomplete or failed details cannot be grouped', async () => {
  for (const options of [{ failure: true }, { incomplete: true }, { event: 'related', repeat: true }]) {
    const f = fixture(options);
    await assert.rejects(f.context.hydrateDispatchGroupSelection(), /unavailable|complete|changed/i);
    assert.equal(f.context.dispatchGroupHydrationPromise, null);
    assert.ok(f.requests.length <= 5);
  }
});

test('background detail reads wait for grouping and duplicate grouping actions share the same reads', async () => {
  const f = fixture();
  const first = f.context.hydrateDispatchGroupSelection();
  const duplicate = f.context.hydrateDispatchGroupSelection();
  const background = f.context.applyTargetedDispatchOrderUpdate('SO-1-S5');
  assert.deepEqual(f.requests, ['SO-0-S5']);
  const [a, b] = await Promise.all([first, duplicate]);
  assert.equal(a, b);
  await background;
  assert.deepEqual(f.requests, ['SO-0-S5', 'SO-1-S5']);
});
