import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePickupExistingFulfillment, pickupExistingFulfillmentTransactions, EXISTING_PICKUP_IF_STRATEGY } from '../../../src/operator-pickup-existing-if-domain.js';
import { createPickupExistingFulfillmentReader } from '../../../src/operator-pickup-existing-if-source.js';
import { createOperatorNetSuitePostingFinalizer } from '../../../src/operator-netsuite-posting-finalizer.js';
import { createOperatorNetSuitePostingRealSourceResolver, createOperatorNetSuitePostingTargetResolver } from '../../../src/operator-netsuite-posting-targets.js';
import { buildOperatorNetSuitePostingDraft } from '../../../src/operator-netsuite-posting-domain.js';
import { pickupEvidence, pickupCommand } from '../../support/pickup-existing-if-fixture.mjs';

const rejected = { code: 'OPERATOR_PICKUP_EXISTING_IF_UNVERIFIED' };

test('existing IF: recover missing mapping by stable key and verify exact shipped quantity', () => {
  const result = resolvePickupExistingFulfillment(pickupEvidence());
  assert.equal(result.postingStrategy, EXISTING_PICKUP_IF_STRATEGY);
  assert.equal(result.availableLines.length, 1);
  assert.deepEqual(result.availableLines[0], { sourceLineKey: '4828215', sourceLineAliases: ['4828215'], orderLine: 1,
    itemId: 2875, location: 1, orderedQuantity: 109, completedQuantity: 109, remainingQuantity: 0,
    linkedTransactions: [{ id: 977092, ref: 'IF151113', type: 'IF', quantity: 109 }] });
});

test('existing IF: partial local pickup and multiple historical IFs preserve full evidence without double counting links', () => {
  const evidence = pickupEvidence({ quantity: 10, confirmed: 3, loaded: 2, parts: [4, 6] });
  evidence.links.push(structuredClone(evidence.links[0]));
  const result = resolvePickupExistingFulfillment(evidence);
  assert.equal(result.availableLines[0].completedQuantity, 10);
  assert.deepEqual(result.availableLines[0].linkedTransactions.map(row => row.ref), ['IF151113', 'IF151114']);
});

const corruptions = {
  'wrong source order': e => { e.records[0].createdFrom.id = '963503'; },
  'wrong IF ID': e => { e.records[0].id = '1'; },
  'wrong IF reference': e => { e.records[0].tranId = 'IF-OTHER'; },
  'wrong linked order': e => { e.links[0].sourceOrderId++; },
  'wrong linked reference': e => { e.links[0].sourceOrderRef = 'SO-OTHER'; },
  'wrong transaction kind': e => { e.links[0].transactionType = 'ItemRcpt'; },
  'wrong record type': e => { e.records[0].type = 'itemReceipt'; },
  'unshipped IF': e => { e.links[0].statusText = 'Item Fulfillment : Picked'; },
  'void IF': e => { e.records[0].voided = true; },
  'cancelled IF': e => { e.records[0].status = { refName: 'Cancelled' }; },
  'wrong stable source key': e => { e.sourceItems[0].lineUniqueKey = '1'; },
  'ambiguous stable source key': e => { e.sourceItems.push(structuredClone(e.sourceItems[0])); },
  'wrong source item': e => { e.sourceItems[0].item.id = '2876'; },
  'wrong IF item': e => { e.records[0].item.items[0].item.id = '2876'; },
  'wrong source location': e => { e.sourceItems[0].location.id = '28'; },
  'wrong linked location': e => { e.links[0].locationId = 28; },
  'wrong IF location': e => { e.records[0].item.items[0].location.id = '28'; },
  'wrong IF unit': e => { e.records[0].item.items[0].units = '495'; },
  'wrong local unit': e => { e.order.lines[0].unit = 'EACH'; },
  'wrong source orderLine': e => { e.links[0].sourceOrderLine = 2; },
  'wrong linked stable key': e => { e.links[0].sourceLineKey = '4828216'; },
  'wrong linked item': e => { e.links[0].itemId = 2876; },
  'wrong IF orderLine': e => { e.records[0].item.items[0].orderLine = 2; },
  'ambiguous IF lines': e => { e.records[0].item.items.push(structuredClone(e.records[0].item.items[0])); },
  'unselected IF line': e => { e.records[0].item.items[0].itemReceive = false; },
  'insufficient existing quantity': e => { e.records[0].item.items[0].quantity = 108; e.links[0].quantity = 108; },
  'disagreed linked quantity': e => { e.links[0].quantity = 108; },
  'conflicting duplicate links': e => { e.links.push({ ...e.links[0], quantity: 108 }); },
  'no linked IF': e => { e.links = []; e.records = []; },
  'missing IF record': e => { e.records = []; },
  'already locally loaded': e => { e.order.lines[0].loaded_qty = 109; },
  'unsupported kit': e => { e.sourceItems[0].itemType.id = 'Kit'; },
  'invalid source ID': e => { e.sourceNetSuiteId = 0; },
  'invalid selected quantity': e => { e.selectedItems[0].quantity = Infinity; }
};
for (const [name, corrupt] of Object.entries(corruptions)) {
  test(`existing IF rejects ${name}`, () => {
    const evidence = pickupEvidence(); corrupt(evidence);
    assert.throws(() => resolvePickupExistingFulfillment(evidence), rejected);
  });
}

test('existing IF: duplicate SKU on different stable lines cannot share fulfillment evidence', () => {
  const e = pickupEvidence();
  e.order.lines.push({ ...e.order.lines[0], id: 344019, line_id: 4828216 });
  e.selectedItems.push({ ...e.selectedItems[0], orderLine: 4828216 });
  e.sourceItems.push({ ...e.sourceItems[0], line: 2, lineUniqueKey: '4828216' });
  assert.throws(() => resolvePickupExistingFulfillment(e), rejected);
});

function reader(e, status = 'Sales Order : Billed', calls = []) {
  return createPickupExistingFulfillmentReader({
    fetchStatuses: async ids => { calls.push('status'); assert.deepEqual(ids, [963502]); return [{ id: '963502', tranid: 'SOA07444', status_text: status }]; },
    fetchSourceItems: async () => { calls.push('source'); return e.sourceItems; },
    fetchLinkedTransactions: async () => { calls.push('links'); return e.links; },
    fetchFulfillment: async id => { calls.push(`IF:${id}`); return e.records.find(r => Number(r.id) === id); }
  });
}

test('existing IF: normal open pickup performs one status read and keeps normal posting behavior', async () => {
  const calls = [], e = pickupEvidence();
  assert.equal(await reader(e, 'Sales Order : Pending Fulfillment', calls)(e), null);
  assert.deepEqual(calls, ['status']);
});

for (const status of ['Sales Order : Billed', 'Sales Order : Pending Billing']) {
  test(`existing IF: ${status} reads and verifies the existing record`, async () => {
    const calls = [], e = pickupEvidence(); const source = await reader(e, status, calls)(e);
    assert.equal(source.availableLines[0].remainingQuantity, 0);
    assert.deepEqual(calls, ['status', 'source', 'links', 'IF:977092']);
  });
}

test('existing IF: absent, mismatched, closed status and failed reads never fall back to creating an IF', async () => {
  for (const statuses of [[], [{ id: 963503, tranid: 'SOA07444' }], [{ id: 963502, tranid: 'SO-OTHER' }],
    [{ id: 963502, tranid: 'SOA07444', status_text: 'Sales Order : Closed' }]]) {
    const read = createPickupExistingFulfillmentReader({ fetchStatuses: async () => statuses });
    await assert.rejects(read(pickupEvidence()), rejected);
  }
  const read = createPickupExistingFulfillmentReader({ fetchStatuses: async () => { throw new Error('network unavailable'); } });
  await assert.rejects(read(pickupEvidence()), /network unavailable/u);
});

test('existing IF: actual target and draft bypass missing stored mapping and retain zero-step source claim', async () => {
  const e = pickupEvidence();
  const source = createOperatorNetSuitePostingRealSourceResolver({ query: async () => ({ rows: [{ source_line_key: '4828215', item_id: 2875, quantity: 109, netsuite_order_line: null }] }),
    useStoredOrderLines: true, fetchPickupSource: reader(e) });
  const targets = createOperatorNetSuitePostingTargetResolver({ getDeliveryOrder: async () => e.order,
    getReceivableReceivingOrder: async () => null, resolveRealSource: source });
  const resolution = await targets({ functionKey: 'customer_pickup', orderId: 963502, clientLocationId: 1 });
  const draft = buildOperatorNetSuitePostingDraft({ ...resolution, requestId: pickupCommand().requestId, actorOperatorId: 'operator', photoRefs: [],
    policy: { gateKey: 'operator_netsuite_customer_pickup_if_3445', revision: 1, effective: true, functionKey: 'customer_pickup', transactionType: 'IF', locationId: 1, yardCode: '3445' } });
  assert.equal(draft.steps.length, 0);
  assert.equal(draft.inputSnapshot.postingStrategy, EXISTING_PICKUP_IF_STRATEGY);
  assert.ok(draft.claims.includes('source:IF:SO:963502'));
  assert.equal(draft.lineReconciliation.lines[0].reconciledQuantity, 109);
});

test('existing IF: finalization persists and returns all existing IF references for the pickup screen', async () => {
  const command = pickupCommand(); let evidence;
  const finalize = createOperatorNetSuitePostingFinalizer({
    recordCustomerPickupLoad: async () => ({ id: 9, pickupStatus: 'loaded', remainingLines: 0 }),
    recordDeliveryLoad: async () => assert.fail('unexpected delivery'), recordReceivingReceipt: async () => assert.fail('unexpected receiving'),
    syncDirectDependencyOperatorProgress: async () => {}, syncOrderDependenciesForTransferOrder: async () => {},
    attachLoadEvidence: async (_result, value) => { evidence = value; }
  });
  const result = await finalize(command);
  assert.equal(evidence, command);
  assert.equal(result.operatorNetSuitePosting.transactions.length, 1);
  assert.equal(result.operatorNetSuitePosting.transactions[0].transactionRef, 'IF151113');
  assert.equal(result.operatorNetSuitePosting.transactions[0].reused, true);
  assert.equal(pickupExistingFulfillmentTransactions(command).length, 1);
});
