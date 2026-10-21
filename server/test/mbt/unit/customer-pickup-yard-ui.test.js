import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { parse } from 'espree';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const filename = 'public/operator.js', source = readFileSync(filename, 'utf8');
const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true });
const selected = new Set(['confirmLine', 'confirmPage', 'confirmDiscardCustomerPickupDraft',
  'startFulfillment', 'confirmFulfillment', 'operatorOrderDetailPath', 'loadDetail']);
let cursor = 0, functions = '';
for (const node of tree.body.filter(item => item.type === 'FunctionDeclaration' && selected.has(item.id.name))) {
  functions += source.slice(cursor, node.start).replace(/[^\n]/gu, ' ') + source.slice(node.start, node.end);
  cursor = node.end;
}
function harness(yard) {
  const calls = [], line = { id: 42 }, order = { netsuite_id: 10099, lines: [line] };
  const context = vm.createContext({ locationId: yard, selectedId: 10099, selectedOrder: order,
    pageConfirming: false, pickupConfirming: false, currentModule: 'customer-pickup', viewMode: 'pick',
    app: { querySelector: () => ({ querySelector: selector => ({ value: selector.includes('pieces') ? '3' : '0' }) }) },
    isCustomerPickupMode: () => true, isIndependentManualLine: () => false, hasCustomerPickupDraft: () => true,
    confirm: () => true, t: (_key, fallback) => fallback, showToast: () => {}, updatePageConfirmControls: () => {}, render: () => {},
    currentDetailPageLines: () => [line], exceptionText: () => '', confirmPayloadForLine: () => ({ pieces: 3 }),
    confirmPayloadHasQty: () => true, isActiveDraftPackedLine: () => false, acceptRefreshedDeliveryOrder: () => true,
    api: async (path, options) => { calls.push({ path, body: JSON.parse(options.body) }); return { ...order, order, confirmed: 1 }; } });
  vm.runInContext(functions, context, { filename: pathToFileURL(resolve(filename)).href });
  return { calls, context };
}

test('E12 ordinary delivery keeps the existing detail refresh endpoint', async () => {
  const h = loadHarness(1);
  h.context.currentModule = 'delivery';
  h.context.isCustomerPickupMode = () => false;
  await h.context.startFulfillment();
  assert.equal(h.calls[0].path, '/api/delivery/orders/10099');
  assert.equal(h.context.currentModule, 'delivery-fulfill');
});

test('E12 pickup detail fallback keeps the selected yard when refreshing confirmation state', async () => {
  const h = loadHarness(28);
  const result = await h.context.loadDetail(10099, { silentRender: true });
  assert.equal(h.calls[0].path, '/api/customer-pickup/orders/10099?locationId=28');
  assert.equal(result.lines.length, 1);
});

function loadHarness(yard) {
  const h = harness(yard), own = { id: 42 }, order = { netsuite_id: 10099, lines: [own],
    confirmationSummary: { total: 1, confirmed: 1, missing: [] } };
  Object.assign(h.context, {
    selectedOrder: order, fulfillmentOrder: order, fulfillmentSubmitting: false, fulfillmentLoadRequestId: 'yard-test',
    fulfillmentResult: null, fulfillmentStatusText: '', fulfillmentJobStage: '', fulfillmentValidation: null,
    fulfillmentReturnModule: '', fulfillmentPhotoDataUrls: [], fulfillmentActivePhotoSlot: 0, fulfillmentStartedAt: 0,
    fulfillmentNetSuitePolicy: null, fulfillmentNetSuitePolicyError: '',
    resumePreviousLoadJournal: async () => {}, confirmMissingLoadLines: async () => true,
    refreshCustomerPickupPhotoRequirement: async () => {}, loadPostingJournal: () => null, createOperatorUuid: () => 'yard-test',
    operatorNetSuitePostingIsLocalOnly: () => true, selectRearCamera: () => {},
    deliveryRefresh: { begin: () => 'detail-test', current: () => true }, selectedLineId: null,
    mergeDeliveryOrderIntoState: () => {}, visibleLines: value => value.lines,
    api: async path => { h.calls.push({ path }); return order; }
  });
  return h;
}

for (const yard of [1, 28]) {
  for (const action of ['confirmLine', 'confirmPage', 'confirmDiscardCustomerPickupDraft']) {
    test(`E12 ${action} sends the selected pickup yard ${yard}`, async () => {
      const h = harness(yard);
      await h.context[action](42);
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].body.locationId, yard);
    });
  }
}

for (const yard of [1, 28]) {
  test(`E12 entering pickup load at ${yard} refreshes through the pickup yard endpoint`, async () => {
    const h = loadHarness(yard);
    await h.context.startFulfillment();
    assert.equal(h.calls[0].path, `/api/customer-pickup/orders/10099?locationId=${yard}`);
    assert.equal(h.context.currentModule, 'customer-pickup-load');
  });
  test(`E12 final pickup confirmation at ${yard} uses the same yard endpoint`, async () => {
    const h = loadHarness(yard);
    h.context.currentModule = 'customer-pickup-load';
    h.context.api = async path => { h.calls.push({ path }); return { posting: { loadBlocked: true } }; };
    await h.context.confirmFulfillment();
    assert.equal(h.calls[0].path, `/api/customer-pickup/orders/10099?locationId=${yard}`);
  });
}

test('E12 HTML and service worker share the new operator asset cache version', () => {
  const html = readFileSync('public/operator.html', 'utf8');
  const worker = readFileSync('public/service-worker.js', 'utf8');
  const version = '20261010-pickup-packs-yard-v1';
  assert.ok(html.includes(`/operator.js?v=${version}`));
  assert.ok(worker.includes(`/operator.js?v=${version}`));
  assert.ok(worker.includes(`mbbs-yard-operator-${version}`));
  vm.runInNewContext(worker, { self: { addEventListener: () => {} } }, { filename: pathToFileURL(resolve('public/service-worker.js')).href });
});
