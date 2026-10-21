import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshSqftPostingAvailability, createOperatorNetSuitePostingRealSourceResolver } from '../../../src/operator-netsuite-posting-targets.js';
import { buildOperatorNetSuitePostingDraft } from '../../../src/operator-netsuite-posting-domain.js';
import { refreshPoReceiptAvailability } from '../../../src/operator-po-receipt-availability.js';
import { localReceiptNetSuiteQuantities, verifiedLocalNetSuiteSalesQuantities, netSuitePostingQuantitiesMatch } from '../../../src/operator-netsuite-posting-quantity.js';
import { fetchSalesOrderFulfillmentStateFromNetSuite } from '../../../src/netsuite.js';
import { compareSalesOrderFulfillmentSnapshot, resolveSalesOrderFulfillmentLines } from '../../../src/sales-order-auto-fulfillment-domain.js';
import { buildTransferPostingDraft, assertTransferPostingSourceCurrent } from '../../../src/transfer-order-posting-domain.js';
import { buildDirectPoReceiptDraft, assertDirectPoReceiptStepCurrent } from '../../../src/direct-po-auto-receipt-domain.js';

function sourceEvidence() {
  return { available: [{ orderLine: 2, sourceLineKey: '501', itemId: 4767, location: 28,
    salesUom: 'SQFT', orderedQuantity: 61, completedQuantity: 0, remainingQuantity: 61 }],
  live: { lines: [{ restOrderLine: 2, sourceLineKey: '501', sourceLineAliases: ['501'], itemId: 4767,
    identityStatus: 'exact', unit: 'SQFT', location: 28, quantity: 60.76, completedQuantity: 0, remainingQuantity: 60.76 }] } };
}

test('R8 fresh SO quantity replaces cached availability only through exact identity and unit evidence', () => {
  const { available, live } = sourceEvidence();
  const result = refreshSqftPostingAvailability(available, live);
  assert.equal(result[0].orderedQuantity, 60.76);
  assert.equal(result[0].remainingQuantity, 60.76);
  assert.equal(available[0].remainingQuantity, 61);
  const other = [{ ...available[0], salesUom: 'EACH' }];
  assert.equal(refreshSqftPostingAvailability(other, { lines: [] })[0], other[0]);
});

test('R8 the stored SO resolver reads fresh SQFT quantities before admitting a posting', async () => {
  const { live } = sourceEvidence();
  const reads = [];
  const resolver = createOperatorNetSuitePostingRealSourceResolver({ useStoredOrderLines: true,
    query: async (sql, params) => {
      assert.match(sql, /line\.unit/u);
      assert.deepEqual(params, [123]);
      return { rows: [{ source_line_key: '501', netsuite_order_line: 2, item_id: 4767,
        item_type: 'InvtPart', quantity: 61, unit: 'SQFT', location_id: 28, cached_completed_qty: 0, raw: {} }] };
    }, fetchLiveSource: async input => { reads.push(input); return live; } });
  const result = await resolver({ order_type: 'sales_order', netsuite_id: 123, tranid: 'SO-ROUNDING' }, { functionKey: 'customer_pickup' });
  assert.equal(result.availableLines[0].remainingQuantity, 60.76);
  assert.equal(result.availableLines[0].salesUom, 'SQFT');
  assert.deepEqual(reads, [{ sourceOrderKind: 'SO', sourceNetSuiteId: 123, functionKey: 'customer_pickup' }]);
});

function unitConflictInput() {
  return { requestId: '12345678-1234-4234-8234-123456789abc', actorOperatorId: 'rounding-test',
    functionKey: 'customer_pickup', transactionType: 'IF', photoRefs: [], localOrderKeys: ['rounding:SO'],
    policy: { effective: true, gateKey: 'rounding-test', revision: 1, functionKey: 'customer_pickup',
      transactionType: 'IF', locationId: 28, yardCode: '2967' },
    localOperation: { kind: 'customer_pickup_load', orderId: '123', orderType: 'sales_order' },
    targets: [{ sourceOrderKind: 'SO', sourceNetSuiteId: 123, sourceOrderRef: 'SO-ROUNDING',
      selectedLines: [{ orderLine: 2, quantity: 60.7602, salesUom: 'SQFT', sourceLineKey: '501',
        localOrderKey: 'rounding:SO', localLineId: '9', itemId: 4767, location: 28 }],
      availableLines: [{ orderLine: 2, quantity: 60.76, remainingQuantity: 60.76, orderedQuantity: 60.76,
        completedQuantity: 0, sourceLineKey: '501', salesUom: 'SQFT', location: 28 }] }] };
}

test('R4 source rows with conflicting units cannot form one posting line', () => {
  const input = unitConflictInput();
  input.targets[0].availableLines.push({ ...input.targets[0].availableLines[0], salesUom: 'EACH' });
  assert.throws(() => buildOperatorNetSuitePostingDraft(input), /source line.*conflicting sales units/u);
});

test('R4 selected sales units must match the authoritative source', () => {
  const input = unitConflictInput();
  input.targets[0].selectedLines[0].salesUom = 'EACH';
  assert.throws(() => buildOperatorNetSuitePostingDraft(input), /selected sales unit/u);
});

test('R4 selections with conflicting units cannot share one source line', () => {
  const input = unitConflictInput();
  delete input.targets[0].availableLines[0].salesUom;
  input.targets[0].selectedLines.push({ ...input.targets[0].selectedLines[0], salesUom: 'EACH', localLineId: '10' });
  assert.throws(() => buildOperatorNetSuitePostingDraft(input), /selected line.*conflicting sales units/u);
});

test('R4 fresh SQFT quantities cannot be borrowed from another source line, item, unit or yard', () => {
  for (const alteration of [row => { row.itemId = 999; }, row => { row.unit = 'EACH'; },
    row => { row.location = 1; }, row => { row.restOrderLine = 3; }, row => { row.sourceLineAliases = []; row.sourceLineKey = '999'; },
    row => { row.identityStatus = 'ambiguous'; }]) {
    const { available, live } = sourceEvidence();
    alteration(live.lines[0]);
    assert.throws(() => refreshSqftPostingAvailability(available, live));
  }
  const { available, live } = sourceEvidence();
  live.lines.push(structuredClone(live.lines[0]));
  assert.throws(() => refreshSqftPostingAvailability(available, live));
  assert.throws(() => refreshSqftPostingAvailability(available, { lines: [] }));
});

test('R8 PO availability retains fresh native quantities and explicit SQFT evidence', () => {
  const { available } = sourceEvidence();
  available[0].itemId = 4767;
  const result = refreshPoReceiptAvailability(available, [{ line: 2, item: { id: '4767' },
    quantity: 60.76, quantityReceived: 0, unitsDisplay: 'SQFT', itemType: 'InvtPart' }]);
  assert.equal(result[0].remainingQuantity, 60.76);
  assert.equal(result[0].salesUom, 'SQFT');
});

function localReceipt() {
  return { payload: { item: { items: [{ orderLine: 501, quantity: 60.7598, itemReceive: true }] } },
    reconciliation: [{ orderLine: 2, sourceLineKey: '501', sourceLineAliases: ['501'],
      localLines: [{ sourceLineKey: '501', localLineId: '9', quantity: 60.7598 }] }],
    adjustments: [{ orderLine: 2, requestedQuantity: 60.7598, netSuiteQuantity: 60.76, salesUom: 'SQFT' }] };
}

test('R9 absent receipt payload remains absent', () => {
  assert.equal(localReceiptNetSuiteQuantities(null, [], []), null);
});

test('R9 accepted receipt quantity preserves the immutable original payload', () => {
  const e = localReceipt();
  const result = localReceiptNetSuiteQuantities(e.payload, e.reconciliation, e.adjustments);
  assert.equal(result.item.items[0].quantity, 60.76);
  assert.equal(e.payload.item.items[0].quantity, 60.7598);
  assert.equal(localReceiptNetSuiteQuantities(e.payload, [], []), e.payload);
});

test('R4 receipt rounding with missing, duplicate or incompatible local identities stays held', () => {
  const changes = [e => { e.reconciliation = []; }, e => { e.reconciliation.push(structuredClone(e.reconciliation[0])); },
    e => { e.reconciliation[0].localLines.push({ sourceLineKey: '502', localLineId: '10' }); },
    e => { e.payload.item.items[0].orderLine = 999; }, e => { e.payload.item.items.push(structuredClone(e.payload.item.items[0])); },
    e => { e.adjustments[0].salesUom = 'EACH'; }, e => { e.adjustments[0].netSuiteQuantity = 60.77; }];
  for (const change of changes) {
    const e = localReceipt(); change(e);
    assert.throws(() => localReceiptNetSuiteQuantities(e.payload, e.reconciliation, e.adjustments));
  }
});

test('R9 only posted proof with a unique local identity can override pickup completion quantity', () => {
  const e = localReceipt();
  const line = { ...e.reconciliation[0], sourceOrderKind: 'SO', sourceNetSuiteId: 123, salesUom: 'SQFT' };
  const step = { status: 'posted', sourceOrderKind: 'SO', sourceNetSuiteId: 123,
    payload: { item: { items: [{ orderLine: 2, quantity: 60.76 }] } }, response: {} };
  const command = { inputSnapshot: { lineReconciliation: { lines: [line] } }, steps: [step] };
  assert.deepEqual(verifiedLocalNetSuiteSalesQuantities(command), { 9: 60.76 });
  step.status = 'uncertain';
  assert.deepEqual(verifiedLocalNetSuiteSalesQuantities(command), {});
  step.status = 'posted'; line.localLines.push({ localLineId: '10', quantity: 1 });
  assert.deepEqual(verifiedLocalNetSuiteSalesQuantities(command), {});
  assert.deepEqual(verifiedLocalNetSuiteSalesQuantities({}), {});
  assert.equal(netSuitePostingQuantitiesMatch(NaN, 1, 'SQFT'), false);
});

test('R8 the NetSuite SO reader retains sales unit evidence for automatic fulfillment', async () => {
  const order = await fetchSalesOrderFulfillmentStateFromNetSuite(123, {
    query: async () => ({ items: [{ id: '123', tranid: 'SO-ROUNDING', status: 'B', order_line: '501',
      rest_order_line: '2', item_id: '4767', item_type: 'InvtPart', is_fulfillable: 'T', quantity: '-60.76',
      fulfilled_quantity: '0', location_id: '28', line_closed: 'F' }] }),
    fetchItems: async () => [{ orderLine: 2, item: { id: '4767' }, unitsDisplay: 'SQFT' }]
  });
  assert.equal(order.lines[0].unit, 'SQFT');
  assert.equal(order.lines[0].remainingQuantity, 60.76);
  const snapshot = [{ orderLine: 2, itemId: 4767, deliveredQuantity: 60.7602, location: 28 }];
  assert.equal(compareSalesOrderFulfillmentSnapshot({ snapshotLines: snapshot, liveOrder: order }).state, 'ready');
  assert.equal(resolveSalesOrderFulfillmentLines({ action: 'snapshot', snapshotLines: snapshot,
    liveLines: order.lines })[0].quantity, 60.76);
  snapshot[0].deliveredQuantity = 60.77;
  assert.equal(compareSalesOrderFulfillmentSnapshot({ snapshotLines: snapshot, liveOrder: order }).state, 'attention');
  assert.throws(() => resolveSalesOrderFulfillmentLines({ action: 'snapshot', snapshotLines: snapshot, liveLines: order.lines }));
});

for (const type of ['IF', 'IR']) {
  test(`R8 background TO ${type} respects NetSuite SQFT quantity before its live pre-post check`, () => {
    const policy = { effective: true, functionKey: type === 'IF' ? 'delivery_prep' : 'receiving', transactionType: type,
      gateKey: 'rounding-test', revision: 1, locationId: 28, yardCode: '2967' };
    const job = { id: '12345678-1234-4234-8234-123456789abc', local_to_id: 123, order_ref: 'TO-ROUNDING',
      transaction_type: type, operator_record_id: 1, operator_id: 'rounding-test',
      snapshot: { lines: [{ sourceLineKey: '501', lineId: 9, itemId: 4767, quantity: 60.7602, unit: 'SQFT' }] } };
    const source = { sourceOrderKind: 'TO', sourceNetSuiteId: 123, sourceOrderRef: 'TO-ROUNDING',
      availableLines: [{ orderLine: 2, sourceLineKey: '501', itemId: 4767, salesUom: 'SQFT',
        orderedQuantity: 60.76, completedQuantity: 0, remainingQuantity: 60.76, location: null }] };
    const event = { id: 1, order_kind: 'TO', order_ref: 'TO-ROUNDING', completion_evidence_type: 'driver_job',
      driver_status: 'complete', stop_type: 'dropoff', completed_at: '2026-10-10T00:00:00Z' };
    const draft = buildTransferPostingDraft(job, source, policy, event);
    assert.equal(draft.steps[0].payload.item.items[0].quantity, 60.76);
    assert.equal(draft.steps[0].lineSnapshot[0].quantity, 60.7602);
    assert.doesNotThrow(() => assertTransferPostingSourceCurrent(draft.steps[0], { ...source,
      lines: [{ restOrderLine: 2, stage: type === 'IF' ? 'outbound' : 'receiving', identityStatus: 'exact',
        itemId: 4767, remainingQuantity: 60.76 }] }));
    job.snapshot.lines[0].quantity = 60.77;
    assert.throws(() => buildTransferPostingDraft(job, source, policy, event));
  });
}

test('R8 direct PO IR also posts NetSuite quantity and finalizes with that same local quantity', () => {
  const input = { requestId: '12345678-1234-4234-8234-123456789abc',
    policy: { effective: true, functionKey: 'receiving', transactionType: 'IR',
      gateKey: 'operator_netsuite_receiving_ir_3445', revision: 1, locationId: 1, yardCode: '3445' },
    order: { netsuite_id: 123, tranid: 'PO-ROUNDING' },
    evidence: { completionEventId: 1, sourcePoId: 123, pickupJobIds: ['pickup'], deliveryJobId: 'dropoff' },
    lines: [{ id: 9, line_id: 501, item_id: 4767, item_type: 'InvtPart', quantity: 60.7602, location_id: 1, unit: 'SQFT' }],
    source: { sourceOrderKind: 'PO', sourceNetSuiteId: 123, sourceOrderRef: 'PO-ROUNDING', status: 'B',
      lines: [{ sourceLineKey: '501', restOrderLine: 2, itemId: 4767, identityStatus: 'exact', unit: 'SQFT',
        quantity: 60.76, orderedQuantity: 60.76, completedQuantity: 0, remainingQuantity: 60.76, location: 1 }] } };
  const draft = buildDirectPoReceiptDraft(input);
  assert.equal(draft.steps[0].payload.item.items[0].quantity, 60.76);
  assert.equal(draft.inputSnapshot.localPayload.item.items[0].quantity, 60.76);
  assert.doesNotThrow(() => assertDirectPoReceiptStepCurrent(draft.steps[0], { lines: [{ sourceLineKey: '501',
    restLineId: 2, itemId: 4767, quantity: 60.76, receivedQuantity: 0, locationId: 1 }] }));
});
