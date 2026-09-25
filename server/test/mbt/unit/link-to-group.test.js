import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { parse } from 'espree';
import fc from 'fast-check';
import { aggregateGlobalGroup } from '../../../src/dispatch-delivery-group-repository.js';
import { rollupGroupedSalesOrderReconciliation } from '../../../src/sales-order-reconciliation.js';
import { reconcileDependencyManagedPickups } from '../../../src/scm-dependency-plan-reconciler.js';
import { dispatchRequiredPickupVisitLocations, validateDispatchPickupVisits } from '../../../src/dispatch-pickup-visits.js';
import { mutateSource } from '../../support/link-to-group-mutation-loader.mjs';

const source = mutateSource('public/dispatch.js', fs.readFileSync('public/dispatch.js', 'utf8'));
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true });
const functions = ast.body.filter(node => node.type === 'FunctionDeclaration');
const listeners = ast.body.filter(node => node.type === 'ExpressionStatement'
  && node.expression.callee?.object?.name === 'app'
  && node.expression.callee?.property?.name === 'addEventListener'
  && ['input', 'submit'].includes(node.expression.arguments?.[0]?.value));
let body = source.replace(/[^\n\r]/gu, ' ');
for (const node of [...functions, ...listeners]) {
  body = body.slice(0, node.range[0]) + source.slice(...node.range) + body.slice(node.range[1]);
}
function ui(extra = {}) {
  const context = vm.createContext({
    HUBS: {}, orders: [], orderCatalog: [], assignedOrderEvidenceById: new Map(),
    linkModalDrafts: new Map(), modalOrderId: 'GOM-6635-6636', modalType: 'to-link',
    orderDependencyRequestSequence: 0, orderDependencyAbortController: null,
    currentPlanDate: '2099-09-23', AbortController, URLSearchParams, ...extra
  });
  context.app ||= {};
  context.app.addEventListener = (event, callback) => { context[`${event}Listener`] = callback; };
  vm.runInContext(body, context, { filename: `${process.cwd()}/public/dispatch.js` });
  // Browser rendering is an external boundary; route/group functions are real.
  context.renderActiveLinkModalInPlace = () => {};
  return context;
}
const plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const children = ['SOM06635', 'SOM06636'].map((id, index) => ({
    id, type: 'SO', catalogHydrated: true, sourceYard: '150', pickupLocations: ['150'],
    address: 'Customer', items: [{ itemId: 9751 + index, quantity: 10, pieces: 10, itemType: 'InvtPart' }]
  }));
  return { id: 'GOM-6635-6636', type: 'SO', sourceYard: '150', pickupLocations: ['150', '2967'],
    childOrders: children.map(child => child.id), childOrderDetails: children,
    items: children.flatMap(child => child.items), directPickupManifest: [{
      dependencyId: '249', transferOrderRef: 'TOB01135', salesOrderRef: 'GOM-6635-6636', location: '2967',
      items: [{ itemId: 9751, quantity: 4, pieceQty: 4 }]
    }] };
}

test('typing a TO uppercases the value immediately while retaining the cursor and clearing stale matches', () => {
  let cursor;
  const input = { id: 'toLinkRef', value: 'toB01135', selectionStart: 2, selectionEnd: 4,
    closest: () => ({ querySelector: () => null }), setSelectionRange: (...values) => { cursor = values; } };
  const view = ui({ orderDependencyOptions: { matchingLines: [{ targetLineKey: 'old' }] } });
  view.inputListener({ target: input });
  assert.equal(input.value, 'TOB01135');
  assert.deepEqual(cursor, [2, 4]);
  assert.equal(view.getLinkModalDraft('to', view.modalOrderId).ref, 'TOB01135');
  assert.equal(view.orderDependencyOptions.matchingLines.length, 0);
});

test('Link TO uppercases the textbox, draft, and matching request', async () => {
  const input = { value: ' tob01135 ' };
  const requests = [];
  const view = ui({ document: { getElementById: id => id === 'toLinkRef' ? input : null },
    app: { querySelectorAll: () => [] }, fetch: async url => {
      requests.push(url);
      return { ok: true, json: async () => ({ matchingLines: [] }) };
    } });
  view.captureActiveLinkModalDraft();
  assert.equal(input.value, ' TOB01135 ');
  const draft = view.getLinkModalDraft('to', view.modalOrderId);
  assert.equal(draft.ref.trim(), 'TOB01135');
  await view.loadOrderDependencyOptions({ id: view.modalOrderId }, { transferOrderRef: ' tob01135 ' });
  assert.equal(new URL(requests[0], 'http://test').searchParams.get('transferOrderRef'), 'TOB01135');
  assert.equal(draft.ref, 'TOB01135');
});

test('submitting Link TO sends the uppercase reference with the selected allocation', async () => {
  const input = { value: ' tob01135 ' };
  const line = { dataset: { targetLineKey: 'GROUP::SOM06635::1' },
    querySelectorAll: () => [{ dataset: { toLinkQty: 'salesQty' }, value: '4' }] };
  const form = { dataset: { form: 'to-link' }, querySelector: () => null, querySelectorAll: () => [line] };
  const view = ui({ orders: [fixture()], document: { getElementById: id => id === 'toLinkRef' ? input : null },
    app: { querySelectorAll: () => [] }, dispatchSessionId: 'TEST',
    FormData: class { entries() { return []; } } });
  // Authorization, network, and rendering are external to the form's behavior.
  view.ensureDispatchPlanEditor = () => true;
  view.setModalFormStatus = () => {};
  view.render = () => {};
  let request;
  view.runAtomicDispatchDependencyMutation = async value => { request = value; return { applied: false }; };
  await view.submitListener({ target: { closest: () => form }, preventDefault() {} });
  assert.equal(request.payload.transferOrderRef, 'TOB01135');
  assert.deepEqual(plain(request.payload.allocations), [{ targetLineKey: line.dataset.targetLineKey, quantities: { salesQty: 4 } }]);
});

for (const rollup of [aggregateGlobalGroup, rollupGroupedSalesOrderReconciliation]) {
  test(`${rollup.name} keeps the group's remote TO pickup through child refresh and route save validation`, () => {
    const order = fixture();
    const refreshed = rollup(order, order.childOrderDetails);
    assert.deepEqual(refreshed.pickupLocations, ['150', '2967']);
    assert.deepEqual(refreshed.directPickupManifest, order.directPickupManifest);
    assert.deepEqual(dispatchRequiredPickupVisitLocations(refreshed), ['150', '2967']);
    const previousPlan = { orders: [refreshed], trucks: [{ id: 'T', loads: [{ id: 'L', stops: [
      { id: 'DROP', type: 'drop', orderId: order.id }
    ] }] }] };
    const result = reconcileDependencyManagedPickups({ plan: previousPlan, enrichedOrders: [refreshed], affectedTargetRefs: [order.id] });
    assert.deepEqual(validateDispatchPickupVisits(result), []);
    const stops = result.trucks[0].loads[0].stops;
    assert.ok(stops.some(stop => stop.type === 'pick' && stop.location === '2967'));
    assert.equal(stops.at(-1).type, 'drop');
  });
}

test('normalizing a group keeps each member TO manifest once, including after repeated normalization', () => {
  const order = fixture();
  const first = order.directPickupManifest[0];
  const second = { ...first, dependencyId: '250', transferOrderRef: 'TOB01136', location: '3445' };
  order.childOrderDetails[0].directPickupManifest = [first];
  order.childOrderDetails[1].directPickupManifest = [second];
  const view = ui();
  const normalized = view.normalizeOrder(order);
  assert.deepEqual(plain(normalized.directPickupManifest.map(entry => entry.transferOrderRef)), ['TOB01135', 'TOB01136']);
  assert.deepEqual(plain(normalized.pickupLocations), ['150', '2967', '3445']);
  assert.deepEqual(plain(view.normalizeOrder(normalized).directPickupManifest), plain(normalized.directPickupManifest));
});

test('unstarted direct-linked SOs may group, while progressed links remain blocked', () => {
  const view = ui();
  const dependency = { id: 249, mode: 'direct_to_customer', status: 'active', transferOrderRef: 'TOB01135',
    salesOrderRef: 'SOM06635', lines: [{ allocatedQuantity: 4, loadedQuantity: 0 }] };
  assert.equal(view.groupedOrderDependencyStructureBlockMessage([{ orderDependencies: [dependency] }]), '');
  dependency.lines[0].loadedQuantity = 1;
  assert.match(view.groupedOrderDependencyStructureBlockMessage([{ orderDependencies: [dependency] }]), /started|progress/iu);
});

test('grouping retargets explicit pickup membership without losing unrelated cargo', () => {
  const load = { id: 'L', stops: [
    { id: 'PICK', type: 'pick', orderId: 'SOM06635', orderRefs: ['SOM06635', 'SO-OTHER'], location: '2967' },
    { id: 'DROP', type: 'drop', orderId: 'SOM06635' }
  ] };
  const view = ui({ routeCache: {}, routeEstimates: {}, pendingOperatorAlertRefs: new Set() });
  view.applyGroupedOrderPlanning(fixture(), { load, truck: { plate: 'T' }, refs: new Set(['SOM06635', 'SOM06636']),
    assignments: [{ index: 1, stop: load.stops[1] }] });
  assert.deepEqual(plain(load.stops[0].orderRefs), ['GOM-6635-6636', 'SO-OTHER']);
  assert.equal(load.stops[1].orderId, 'GOM-6635-6636');
});

test('the grouping action carries links from both selected orders regardless of selection order', () => {
  for (const reverse of [false, true]) {
    const group = fixture();
    const members = group.childOrderDetails;
    for (const [index, member] of members.entries()) {
      const dependency = { id: 249 + index, mode: 'direct_to_customer', status: 'active', transferOrderRef: `TO-${index}`,
        salesOrderRef: member.id, lines: [{ allocatedQuantity: 4, loadedQuantity: 0 }] };
      member.orderDependencies = [dependency];
      member.directPickupManifest = [{ ...group.directPickupManifest[0], dependencyId: dependency.id, transferOrderRef: dependency.transferOrderRef }];
    }
    if (reverse) {members.reverse();}
    const view = ui({ orders: members, selectedOrderIds: new Set(members.map(member => member.id)),
      plannedAssignmentRefs: new Set(), currentPlan: { id: 'PLAN' }, trucks: [] });
    assert.equal(view.groupOrder(members[0].id), true);
    assert.equal(view.orders.length, 1);
    assert.equal(view.orders[0].orderDependencies.length, 2);
    assert.deepEqual(plain(view.orders[0].directPickupManifest.map(entry => entry.transferOrderRef).sort()), ['TO-0', 'TO-1']);
  }
});

test('generated manifest permutations conserve quantities without duplicate dependency entries', () => {
  const view = ui();
  fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 2, maxLength: 8 }), fc.boolean(),
    (quantities, reverse) => {
      const children = quantities.map((quantity, index) => ({ id: `SO-${index}`, type: 'SO', pickupLocations: ['150'],
        directPickupManifest: [{ dependencyId: index + 1, transferOrderRef: `TO-${index}`, location: '2967', items: [{ quantity }] }] }));
      if (reverse) {children.reverse();}
      const result = view.normalizeOrder({ id: 'GROUP', type: 'SO', childOrders: children.map(child => child.id),
        childOrderDetails: children, directPickupManifest: children[0].directPickupManifest });
      assert.equal(result.directPickupManifest.length, quantities.length);
      assert.equal(result.directPickupManifest.flatMap(entry => entry.items).reduce((sum, item) => sum + item.quantity, 0),
        quantities.reduce((sum, value) => sum + value, 0));
    }), { seed: 66356636, numRuns: 80 });
});
