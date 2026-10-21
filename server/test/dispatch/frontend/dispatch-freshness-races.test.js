import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parse } from 'espree';
import fc from 'fast-check';
import { compactDispatchOrderCard } from '../../../src/dispatch-planner-optimization.js';

const source = readFileSync(new URL('../../../public/dispatch.js', import.meta.url), 'utf8');
const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true }).body;
function subject(names, extra = {}) {
  const context = vm.createContext({ Map, Set, Promise, String, Array, console,
    dispatchGroupHydrationPromise: null, dispatchOrderRefreshEpoch: 0, dispatchOrderReadSequence: 0, dispatchOrderAppliedReads: new Map(),
    localPlanGeneration: 0, currentPlan: { id: '1' }, currentPlanDate: '2026-10-19',
    dispatchOrderReadRequests: new Map(), orders: [], orderCatalog: [],
    dispatchOrderRefKey: value => String(value || '').trim().toUpperCase(),
    renderDispatchOrderPoolPatch: () => {}, isAuthoritativelyRetiredOrderRef: () => false,
    ...extra });
  for (const name of names) {
    const node = declarations.find(candidate => candidate.type === 'FunctionDeclaration' && candidate.id.name === name);
    assert.ok(node, name);
    const prefix = source.slice(0, node.range[0]).replace(/[^\n]/g, ' ');
    vm.runInContext(prefix + source.slice(...node.range), context, { filename: 'dispatch-freshness-vm:public/dispatch.js' });
  }
  return context;
}

test('freshness properties: unchanged detail versions preserve complete cargo; changed versions require hydration', () => {
  const ui = subject(['preserveDispatchPlanningFields']);
  fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 9, maxLength: 40 }), quantities => {
    for (const type of ['SO', 'PO', 'TO', 'CO']) {
    const order = { id: `${type}-PROPERTY`, type, ...(type === 'CO' ? { sourceTable: 'local_co_orders', sourceOrderId: 'SO-SOURCE' } : {}),
      items: quantities.map((quantity, i) => ({ lineId: i, quantity })) };
    const compact = compactDispatchOrderCard(order);
    assert.equal(typeof compact.catalogDetailSignature, 'string');
    const full = { ...order, catalogHydrated: true, catalogDetailSignature: compact.catalogDetailSignature };
    const retained = ui.preserveDispatchPlanningFields(full, compact);
    assert.deepEqual(retained.items, full.items);
    assert.equal(retained.catalogHydrated, true);
    const changed = compactDispatchOrderCard({ ...order, items: [...order.items, { lineId: 999, quantity: 1 }] });
    assert.notEqual(changed.catalogDetailSignature, compact.catalogDetailSignature);
    assert.equal(ui.preserveDispatchPlanningFields(full, changed).catalogHydrated, false);
    }
  }), { seed: 20261019, numRuns: 250 });
});

test('freshness properties: arbitrary response ordering only applies the latest detail request', async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.integer(), { minLength: 2, maxLength: 20 }), fc.boolean(), async (priorities, mutate) => {
    const waiting = [], applied = [];
    const ui = subject(['dispatchOrderReadToken', 'dispatchOrderReadIsCurrent', 'applyTargetedDispatchOrderUpdate'], {
      fetch: () => new Promise(resolve => waiting.push(resolve)), orderById: () => ({ id: 'SO-RACE', version: 'local' }),
      mergeDispatchOrderSearchFeed: values => applied.push(values[0].version)
    });
    const requests = priorities.map(() => ui.applyTargetedDispatchOrderUpdate('SO-RACE'));
    if (mutate) ui.localPlanGeneration++;
    const indexes = priorities.map((priority, i) => ({ priority, i })).sort((a, b) => a.priority - b.priority);
    for (const { i } of indexes) {
      waiting[i]({ ok: true, json: async () => ({ order: { id: 'SO-RACE', version: i } }) });
      await requests[i];
    }
    assert.deepEqual(applied, mutate ? [] : [priorities.length - 1]);
    assert.equal(ui.dispatchOrderReadRequests.size, 0);
  }), { seed: 654902, numRuns: 250 });
});

test('freshness: navigation and mutation epochs reject old responses, including a return to the same date', async () => {
  for (const change of [ui => { ui.currentPlan = { id: '2' }; }, ui => { ui.currentPlanDate = '2026-10-20'; }, ui => { ui.dispatchOrderRefreshEpoch++; }]) {
    let finish, applied = 0;
    const ui = subject(['dispatchOrderReadToken', 'dispatchOrderReadIsCurrent', 'applyTargetedDispatchOrderUpdate'], {
      fetch: () => new Promise(resolve => { finish = resolve; }), orderById: () => null,
      mergeDispatchOrderSearchFeed: () => { applied++; }
    });
    const promise = ui.applyTargetedDispatchOrderUpdate('SO-NAV'); change(ui);
    finish({ ok: true, json: async () => ({ order: { id: 'SO-NAV' } }) }); await promise;
    assert.equal(applied, 0);
  }
});

test('freshness: related reference closure includes nested groups, splits, CO and link sources but omits retired identities', () => {
  const ui = subject(['dispatchRelatedRefreshRefs'], {
    orders: [
      { id: 'SO-ONE-S2', originalOrderId: 'SO-ONE' },
      { id: 'GOA-ONE', childOrders: ['SO-ONE-S2'] },
      { id: 'GOA-TWO', childOrders: ['GOA-ONE'] },
      { id: 'CO-GOA-TWO', sourceOrderId: 'GOA-TWO' },
      { id: 'RETIRED', originalOrderId: 'SO-ONE' }
    ], isAuthoritativelyRetiredOrderRef: ref => ref === 'RETIRED'
  });
  assert.deepEqual([...ui.dispatchRelatedRefreshRefs({ orderId: 'so-one' })].sort(), ['CO-GOA-TWO', 'GOA-ONE', 'GOA-TWO', 'SO-ONE', 'SO-ONE-S2'].sort());
});

test('freshness: targeted event work has at most four simultaneous requests and reports failures', async () => {
  let running = 0, peak = 0;
  const ui = subject(['refreshDispatchOrderRefs'], {
    applyTargetedDispatchOrderUpdate: async ref => {
      running++; peak = Math.max(peak, running); await new Promise(resolve => setImmediate(resolve)); running--;
      if (ref === 'FAIL') throw new Error('offline');
    }
  });
  await assert.rejects(ui.refreshDispatchOrderRefs(['FAIL', ...Array.from({ length: 40 }, (_, i) => `SO-${i}`)]), /FAIL: offline/);
  assert.equal(peak, 4); assert.equal(running, 0);
});

test('freshness: malformed event arrays do not fan out into character-by-character requests', () => {
  const ui = subject(['dispatchRelatedRefreshRefs']);
  assert.deepEqual([...ui.dispatchRelatedRefreshRefs({ orderId: 'SO-ONE', orderRefs: 'INVALID', reactivatedGlobalOrderRefs: {} })], ['SO-ONE']);
});
