import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { parse } from 'espree';
import { applyDispatchPlanMutation } from '../../../src/dispatch-planner-performance.js';
import { mutants } from '../../support/link-to-fix-mutation-loader.mjs';

const original = readFileSync('public/dispatch.js', 'utf8');
const mutant = mutants[process.env.LINK_TO_MUTANT];
const source = mutant?.[0] === 'public/dispatch.js' ? original.replace(mutant[1], mutant[2]) : original;
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true });
function findSubmit(node) {
  if (node?.type === 'IfStatement' && source.slice(...node.test.range) === 'form.dataset.form === "edit-order-details"') { return node; }
  if (!node || typeof node !== 'object') { return null; }
  return Object.values(node).flat().map(value => typeof value === 'object' ? findSubmit(value) : null).find(Boolean);
}

test('G4 group Split commands reject a group as source without changing the plan', () => {
  const plan = { orders: [{ id: 'GOM-6531-6537', type: 'SO', childOrders: ['SOM06531', 'SOM06537'] }], trucks: [] };
  const before = structuredClone(plan);
  assert.throws(() => applyDispatchPlanMutation({ plan, command: { commandType: 'split_order',
    payload: { sourceOrderRef: 'GOM-6531-6537' } } }), error => error.code === 'DISPATCH_GROUP_SPLIT_UNSUPPORTED');
  assert.deepEqual(plan, before);
});

test('G4 grouped Consolidate Pick cannot turn only the first member item into a transfer draft', () => {
  const order = { id: 'GOM-6531-6537', type: 'SO', childOrders: ['SOM06531', 'SOM06537'],
    items: [{ itemId: 10 }, { itemId: 20 }], pickupLocations: ['2967'], weight: 10, salesQty: 10 };
  const context = vm.createContext({ orderById: () => order, orders: [order], routeNotice: '',
    shortageQty: () => 10, consolidateYards: () => [{ yard: '150' }],
    HUBS: {}, dispatchLocationHierarchyRoot: value => value, queueGlobalOrderReactivation: () => {} });
  const node = ast.body.find(entry => entry.type === 'FunctionDeclaration' && entry.id.name === 'consolidatePick');
  vm.runInContext(source.slice(...node.range), context);
  vm.runInContext('consolidatePick("GOM-6531-6537", "150")', context);
  assert.equal(context.orders.length, 1);
  assert.equal(order.consolidation, undefined);
  assert.match(context.routeNotice, /ungroup.*child/iu);
});
const branch = source.slice(...findSubmit(ast).range);
const local = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'isLocalDispatchOrder');

test('G3 Dispatch navigation uses the current PO address after override and clearing', () => {
  const order = { type: 'PO', id: 'GPO-1', poRouteProjection: { version: 1, dropoffs: [
    { key: 'location:26', destinationYard: '150', address: '700 New Delivery Road' }] } };
  const stop = { dropoffKey: 'location:26', dropLocation: '150', dropAddress: 'Old stored address' };
  const context = vm.createContext({ order, stop, HUBS: {}, dispatchLocationHierarchyRoot: value => value });
  for (const name of ['poRouteProjectionForOrder', 'routeDropoffsForOrder', 'dropoffForStop', 'dropLocationForStop', 'dropAddressForStop']) {
    const node = ast.body.find(entry => entry.type === 'FunctionDeclaration' && entry.id.name === name);
    vm.runInContext(source.slice(...node.range), context);
  }
  assert.equal(vm.runInContext('dropAddressForStop(stop,order)', context), '700 New Delivery Road');
  order.poRouteProjection.dropoffs[0].address = '150 Clark Blvd';
  assert.equal(vm.runInContext('dropAddressForStop(stop,order)', context), '150 Clark Blvd');
});

for (const type of ['SO', 'PO', 'TO']) {
  test(`G1 ${type} group address submission persists canonical children before updating the UI`, async () => {
    const order = { id: 'GOM-6531-6537', type, sourceTable: type === 'PO' ? 'purchase_orders' : '',
      childOrders: ['CHILD-A', 'CHILD-B'], childOrderDetails: [{ id: 'CHILD-A', address: 'Old' }, { id: 'CHILD-B', address: 'Old' }] };
    const updated = { ...order, address: 'New address', childOrderDetails: order.childOrderDetails.map(child => ({ ...child, address: 'New address' })) };
    const calls = [];
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const context = vm.createContext({ order, modalOrderId: order.id, modalType: 'edit-order',
      form: { dataset: { form: 'edit-order-details' }, querySelector: () => ({}) },
      data: { address: 'New address', pickupAddress: '', windowStart: '', windowEnd: '', expectedDeliveryDate: '' },
      orderById: () => order, modalTimeValue: value => value, timeValidationMessage: () => '',
      supportsTransitCoForOrder: () => false, setEditFormStatus: (_form, message, kind) => { if (kind === 'error') { finish(message); } },
      transitSourceOrderType: () => type, splitParentOrderId: () => '', dispatchSessionId: 'test',
      saveCurrentPlanNow: async () => { calls.push('save-plan'); }, summarizeOrder: value => value,
      dispatchLeaseRequestPayload: value => value, fetch: async (url, request) => {
        calls.push({ url, body: JSON.parse(request.body) });
        return { ok: true, json: async () => ({ updated: { dispatch_address: 'New address', order: updated } }) };
      }, mergeTargetedDispatchMutationOrders: () => {}, clearActiveRouteEstimates: () => {},
      commitPlanMutation: () => finish('saved') });
    vm.runInContext(source.slice(...local.range), context);
    await vm.runInContext(`(async function(form,data) { ${branch} })(form,data)`, context);
    assert.equal(await done, 'saved');
    assert.equal(calls[0], 'save-plan');
    assert.match(calls[1].url, /\/GOM-6531-6537\/details/u);
    assert.equal(calls[1].body.address, 'New address');
    assert.ok(order.childOrderDetails.every(child => child.address === 'New address'));
  });
}
