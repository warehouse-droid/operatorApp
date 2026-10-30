import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../../../src/config.js';
import { createIfirPostingClient } from '../../../src/netsuite-ifir-posting-client.js';
import { createOperatorNetSuitePostingRealSourceResolver } from '../../../src/operator-netsuite-posting-targets.js';
import { createOperatorNetSuitePostingAdapter } from '../../../src/operator-netsuite-posting-netsuite-adapter.js';
import { buildOperatorNetSuitePostingDraft } from '../../../src/operator-netsuite-posting-domain.js';
import { ifirFixture } from '../../support/ifir-restlet-fixture.mjs';
import { getIfirQuantityPolicyEnabled } from '../../../src/netsuite-ifir-posting-policy.js';
import { postIfirViaNetSuiteRestlet } from '../../../src/netsuite.js';

function setup(enabled = false) {
  const f = ifirFixture();
  Object.assign(f.request, { sourceOrderKind: 'SO', transactionType: 'IF' });
  Object.assign(f.state.source, { type: 'salesorder' });
  Object.assign(f.state.source.items[0], { quantity: 100, units: 'SQFT', unitstext: 'SQFT' });
  f.state.transformChange = data => { data.items[0].quantityremaining = 70.62; };
  const step = f.step();
  step.payload.item.items[0].quantity = 70.6200001;
  Object.assign(step.lineSnapshot[0], { quantity: 70.6200001, salesUom: 'SQFT' });
  const sent = [], settings = { enabled: true, quantityPolicyEnabled: enabled,
    accountId: 'TEST', url: 'https://test.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=507&deploy=1' };
  let changeResponse = x => x;
  const post = createIfirPostingClient({ settings: () => settings, getToken: async () => 'test-only',
    mutate: work => work(), request: async (_url, input) => {
      const request = JSON.parse(input.body); sent.push(request);
      return { response: { ok: true, status: 200 }, text: JSON.stringify(changeResponse(f.post(request))) };
    } });
  return { f, step, sent, settings, post, response: fn => { changeResponse = fn; } };
}

test('new quantity rollout defaults off and current requests retain their original shape', async () => {
  assert.equal(config.netsuite.ifirPostingQuantityPolicyEnabled, false);
  const f = setup();
  const result = await f.post(f.step);
  assert.equal(result.record.item.items[0].quantity, 70.6200001);
  assert.equal('quantityPolicy' in f.sent[0], false);
});

test('production RESTlet entrypoint remains inert under the default isolated deployment settings', async () => {
  assert.equal(config.netsuite.ifirPostingEnabled, false);
  assert.equal(config.netsuite.ifirPostingQuantityPolicyEnabled, false);
  const f = setup();
  assert.equal(await postIfirViaNetSuiteRestlet(f.step), null);
  assert.equal(f.f.state.saves.length, 0);
});

test('quantity deferral requires both the separate opt-in and the existing deployment and Admin gates', async () => {
  const settings = { ifirPostingEnabled: true, directAccessEnabled: true, ifirPostingRestletUrl: 'configured' };
  let reads = 0, enabled = true;
  const queryFn = async () => { reads++; return { rows: [{ enabled }] }; };
  assert.equal(await getIfirQuantityPolicyEnabled({ settings, queryFn }), false);
  assert.equal(reads, 0);
  settings.ifirPostingQuantityPolicyEnabled = true;
  assert.equal(await getIfirQuantityPolicyEnabled({ settings, queryFn }), true);
  enabled = false;
  assert.equal(await getIfirQuantityPolicyEnabled({ settings, queryFn }), false);
  settings.ifirPostingEnabled = false;
  assert.equal(await getIfirQuantityPolicyEnabled({ settings, queryFn }), false);
  assert.equal(reads, 2);
});

test('explicit rollout sends the policy and accepts actual corrected fields', async () => {
  const f = setup(true), result = await f.post(f.step);
  assert.equal(f.sent[0].quantityPolicy, 'sqft_remaining_v1');
  assert.equal(f.sent[0].payload.item.items[0].quantity, 70.6200001);
  assert.equal(result.record.item.items[0].quantity, 70.62);
  assert.equal(result.tranId, 'IF000456');
  assert.equal(f.sent.length, 1);
});

test('missing policy acknowledgement and out-of-tolerance workflow changes require reconciliation', async () => {
  const f = setup(true);
  f.response(data => { delete data.quantityPolicy; return data; });
  await assert.rejects(f.post(f.step), error => error.ambiguous === true);
  assert.equal(f.sent.length, 1);
  const g = setup(true);
  g.f.state.afterSave = saved => { saved.items[0].quantity = 69; };
  await assert.rejects(g.post(g.step), error => error.ambiguous === true);
  assert.equal(g.f.state.saves.length, 1);
});

test('policy disabled after admission routes a deferred command to native handling without a legacy RESTlet POST', async () => {
  const f = setup(false); f.step.lineSnapshot[0].quantityCheckDeferred = true;
  assert.equal(await f.post(f.step), null);
  assert.equal(f.sent.length, 0);
});

async function resolve(defer) {
  let reads = 0;
  const resolver = createOperatorNetSuitePostingRealSourceResolver({ useStoredOrderLines: true,
    deferSqftQuantityCheck: async () => defer,
    query: async () => ({ rows: [{ source_line_key: '501', netsuite_order_line: 1, item_id: 501,
      item_type: 'InvtPart', quantity: 100, unit: 'SQFT', location_id: 15, cached_completed_qty: 100 }] }),
    fetchLiveSource: async () => { reads += 1; return { lines: [{ restOrderLine: 1, sourceLineKey: '501',
      itemId: 501, location: 15, unit: 'SQFT', identityStatus: 'exact', quantity: 100,
      completedQuantity: 29.38, remainingQuantity: 70.62 }] }; } });
  const target = await resolver({ order_type: 'sales_order', netsuite_id: 901, tranid: 'SO-TEST' },
    { functionKey: 'customer_pickup' });
  return { target, reads };
}

test('explicit deferral removes redundant source read and cached quantities, preserving the durable fallback marker', async () => {
  const { target, reads } = await resolve(true);
  assert.equal(reads, 0);
  assert.equal(target.availableLines[0].remainingQuantity, null);
  assert.equal(target.availableLines[0].orderedQuantity, null);
  assert.equal(target.availableLines[0].quantityCheckDeferred, true);
  const draft = buildOperatorNetSuitePostingDraft({ requestId: '12345678-1234-4234-8234-123456789abc',
    actorOperatorId: 'test', functionKey: 'customer_pickup', transactionType: 'IF', localOrderKeys: ['SO:901'],
    photoRefs: [], policy: { effective: true, gateKey: 'test', revision: 1, functionKey: 'customer_pickup',
      transactionType: 'IF', locationId: 15, yardCode: 'test' },
    localOperation: { kind: 'customer_pickup_load', orderType: 'sales_order', orderId: '901' },
    targets: [{ ...target, selectedLines: [{ orderLine: 1, quantity: 70.6201, salesUom: 'SQFT',
      sourceLineKey: '501', itemId: 501, location: 15, localOrderKey: 'SO:901', localLineId: '1' }] }] });
  assert.equal(draft.steps[0].payload.item.items[0].quantity, 70.6201);
  assert.equal(draft.steps[0].lineSnapshot[0].quantityCheckDeferred, true);
  const legacy = await resolve(false);
  assert.equal(legacy.reads, 1);
  assert.equal(legacy.target.availableLines[0].remainingQuantity, 70.62);
});

test('native fallback after gate changes rechecks remaining quantity and unit before saving', async () => {
  const f = setup(false), native = [], source = { id: 901, lines: [{ orderLine: 1, itemId: 501,
    sourceLineKey: '501', location: 15, unit: 'SQFT', remainingQuantity: 70.62 }] };
  f.step.lineSnapshot[0].quantityCheckDeferred = true;
  const adapter = createOperatorNetSuitePostingAdapter({ postIfirRestlet: f.post,
    fetchSalesOrderFulfillmentSource: async () => source,
    transformSalesOrderToItemFulfillment: async (_id, payload) => { native.push(payload); return {}; },
    findTransactionByExternalId: async () => null,
    transformTransferOrderToItemFulfillment: async () => {}, transformPurchaseOrderToItemReceipt: async () => {},
    transformTransferOrderToItemReceipt: async () => {}, fetchItemFulfillment: async () => {}, fetchItemReceipt: async () => {} });
  await adapter.transform(f.step);
  assert.equal(native[0].item.items[0].quantity, 70.62);
  assert.equal(f.step.payload.item.items[0].quantity, 70.6200001);
  assert.equal(f.sent.length, 0);
  for (const change of [() => { source.lines[0].unit = 'EACH'; },
    () => { source.lines[0].unit = 'SQFT'; source.lines[0].remainingQuantity = 60; }]) {
    change(); await assert.rejects(adapter.transform(f.step), error => error.postingNotAttempted === true);
  }
  assert.equal(native.length, 1);
});
