import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'espree';
import fc from 'fast-check';

const file = new URL('../../../public/dispatch.js', import.meta.url);
const source = readFileSync(process.env.DISPATCH_REJECTION_SOURCE || file, 'utf8');
const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true }).body;
const names = [
  'canonicalDispatchOrderType', 'splitParentOrderId', 'dispatchOrderRefKey',
  'isAuthoritativelyRetiredOrderRef', 'setAuthoritativeOrderRetirement',
  'deleteDispatchOrderRefFromSet', 'isRetirableDispatchStructure',
  'queueGlobalOrderRetirement', 'queueGlobalOrderReactivation',
  'reconcileGlobalOrderLifecycleTransition', 'withoutAuthoritativelyRetiredOrders',
  'withoutAuthoritativelyRetiredStops', 'applyHistorySnapshot',
  'unpackHistorySnapshot', 'commitPlanMutation'
];
const split = { id: 'SOB120921-S1', type: 'SO', originalOrderId: 'SOB120921', pallets: 21 };
const sibling = { ...split, id: 'SOB120921-S2', pallets: 5 };
const group = { id: 'GOA-100-101', type: 'SO', childOrders: ['SOA100', 'SOA101'] };
const noop = () => {};

function harness(rejection, { extras = [split, sibling, group], retiring = [], reactivating = [] } = {}) {
  const ordinary = { id: 'TOB01134', type: 'TO' };
  const snapshot = {
    orders: [ordinary],
    trucks: [{ id: 'T5', loads: [{ id: 'load', truckPlate: 'original', stops: [] }] }]
  };
  const s = vm.createContext({
    console, Map, Set, String, Boolean, Array, JSON,
    orders: [ordinary, ...structuredClone(extras)], trucks: structuredClone(snapshot.trucks),
    authoritativeRetiredOrderRefs: new Set(retiring.map(ref => ref.toUpperCase())),
    pendingGlobalOrderRetireRefs: new Set(retiring),
    pendingGlobalOrderReactivateRefs: new Set(reactivating),
    dispatchSessionPoolOrders: new Map(), plannedAssignmentRefs: new Set(), plannedAssignmentsByRef: new Map(),
    historyReady: true, historyCurrentSnapshot: JSON.stringify(snapshot),
    currentPlan: { id: '335', revision: 34 }, selectedOrderId: ordinary.id,
    selectedOrderIds: new Set(), selectedLoadId: 'load', loadPreviewOpen: false, activeOrderType: 'TO',
    modalType: '', modalOrderId: '', modalLoadId: '',
    poAllocationOptions: null, poAllocationLoading: false, poAllocationError: '',
    orderDependencyOptions: null, orderDependencyLoading: false, orderDependencyError: '', routeNotice: '',
    DISPATCH_ASSIGNMENT_MUTATION_ACTIONS: new Set(['load_truck_updated']),
    ensureDispatchPlanEditor: () => true, normalizeOrder: value => structuredClone(value),
    ensureDriverLaneOrder: noop, defaultDriverLaneOrder: () => [], clearActiveRouteEstimates: noop,
    autosaveDebug: noop, normalizePlanBeforeSave: noop, render: noop,
    physicalVisitsForLoad: () => rejection === 'stop_override' ? [{}] : [],
    physicalVisitOverrideState: () => ({ conflict: true }),
    replenishmentSequenceWarningsForStops: () => rejection === 'dependency' ? ['test rejection'] : [],
    localDispatchLoadAssignmentConflict: () => rejection === 'assignment' ? { message: 'test rejection' } : null,
    clearInvalidEndingTrips: noop,
    captureUndoPointIfNeeded: () => { throw new Error('Rejected edit must not be saved'); }
  });
  for (const name of names) {
    const node = declarations.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
    assert.ok(node, `Missing real function ${name}`);
    const prefix = source.slice(0, node.range[0]).replace(/[^\n]/g, ' ');
    vm.runInContext(prefix + source.slice(...node.range), s, { filename: file.pathname });
  }
  return { s, snapshot };
}

function reject(s) {
  assert.equal(s.commitPlanMutation('load_truck_updated', () => {
    s.trucks[0].loads[0].truckPlate = 'invalid';
  }), false);
  assert.equal(s.trucks[0].loads[0].truckPlate, 'original');
}

for (const reason of ['assignment', 'dependency', 'stop_override']) {
  test(`REJECT-${reason}: rollback cannot retire unrelated splits or groups`, () => {
    const { s } = harness(reason);
    reject(s);
    assert.deepEqual([...s.pendingGlobalOrderRetireRefs], []);
    assert.deepEqual([...s.pendingGlobalOrderReactivateRefs], []);
    assert.deepEqual([...s.authoritativeRetiredOrderRefs], []);
  });
  test(`REJECT-${reason}: existing pending lifecycle intents survive unchanged`, () => {
    const { s } = harness(reason, { retiring: ['SOA900-S1'], reactivating: ['SOA901-S1'] });
    reject(s);
    assert.deepEqual([...s.pendingGlobalOrderRetireRefs], ['SOA900-S1']);
    assert.deepEqual([...s.pendingGlobalOrderReactivateRefs], ['SOA901-S1']);
    assert.deepEqual([...s.authoritativeRetiredOrderRefs], ['SOA900-S1']);
  });
}

test('HISTORY: deliberate undo and redo retain structural lifecycle transitions', () => {
  for (const structure of [split, group]) {
    const { s, snapshot } = harness('assignment', { extras: [structure] });
    s.applyHistorySnapshot(snapshot);
    assert.deepEqual([...s.pendingGlobalOrderRetireRefs], [structure.id]);
    assert.ok(s.isAuthoritativelyRetiredOrderRef(structure.id));
    s.applyHistorySnapshot({ ...snapshot, orders: [...snapshot.orders, structure] });
    assert.deepEqual([...s.pendingGlobalOrderRetireRefs], []);
    assert.deepEqual([...s.pendingGlobalOrderReactivateRefs], [structure.id]);
    assert.ok(s.orders.some(order => order.id === structure.id));
    assert.equal(s.isAuthoritativelyRetiredOrderRef(structure.id), false);
  }
});

test('EMPTY-HISTORY: rejected edits preserve definitions when the old pool was empty', () => {
  for (const reason of ['assignment', 'dependency', 'stop_override']) {
    const { s, snapshot } = harness(reason);
    const emptySnapshot = { trucks: snapshot.trucks };
    s.historyCurrentSnapshot = JSON.stringify(emptySnapshot);
    reject(s);
    assert.deepEqual([...s.pendingGlobalOrderRetireRefs], []);
    assert.deepEqual([...s.pendingGlobalOrderReactivateRefs], []);
    s.orders = [split, sibling, group];
    s.applyHistorySnapshot(emptySnapshot);
    assert.deepEqual([...s.pendingGlobalOrderRetireRefs].sort(), [split.id, sibling.id, group.id].sort());
  }
});

test('PROPERTY: repeated rejected edits preserve arbitrary derived-order lifecycles', () => {
  fc.assert(fc.property(
    fc.constantFrom('assignment', 'dependency', 'stop_override'),
    fc.uniqueArray(fc.integer({ min: 1, max: 999999 }), { minLength: 1, maxLength: 12 }),
    fc.integer({ min: 1, max: 3 }),
    (reason, ids, repeats) => {
      const extras = ids.flatMap(id => [
        { id: `SOA${id}-S1`, originalOrderId: `SOA${id}`, type: 'SO' },
        { id: `goa-${id}-x`, type: 'sales_order', childOrders: [`SOA${id}`, 'SOAOTHER'] }
      ]);
      const { s, snapshot } = harness(reason, { extras });
      for (let i = 0; i < repeats; i++) {
        s.orders = [...snapshot.orders, ...structuredClone(extras)];
        reject(s);
        assert.deepEqual([...s.pendingGlobalOrderRetireRefs], []);
        assert.deepEqual([...s.pendingGlobalOrderReactivateRefs], []);
        assert.deepEqual([...s.authoritativeRetiredOrderRefs], []);
      }
      // A valid history change must still retire exactly the generated refs.
      s.orders = [...snapshot.orders, ...structuredClone(extras)];
      s.applyHistorySnapshot(snapshot);
      assert.deepEqual([...s.pendingGlobalOrderRetireRefs].sort(), extras.map(order => order.id).sort());
    }
  ), { seed: 120921, numRuns: 50 });
});
