import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import fc from 'fast-check';
import { closeDb } from '../../../src/db.js';
import { buildItemFulfillmentPayload } from '../../../src/delivery-repository.js';
import { buildOperatorNetSuitePostingDraft } from '../../../src/operator-netsuite-posting-domain.js';
import { createOperatorNetSuitePostingTargetResolver, createOperatorNetSuitePostingRealSourceResolver } from '../../../src/operator-netsuite-posting-targets.js';
import { fetchSalesOrderFulfillmentStateFromNetSuite } from '../../../src/netsuite.js';
import { normalizeOperatorKitSource } from '../../../src/operator-netsuite-posting-kits.js';
import { kitFixture } from '../../support/operator-kit-fixture.mjs';
import { transferPhysicalEvidence } from '../../support/to-physical-lines.mjs';

after(closeDb);
const line = (type, id, packed = 1) => ({ id, line_id: id, item_id: id + 1000, item_name: `Item ${id}`,
  item_type: type, netsuite_active: true, quantity: 2, unit: 'EA', location_id: 26,
  piece_qty: 2, packed_piece_qty: packed, to_pcs: 1 });
const order = lines => ({ netsuite_id: 1028598, tranid: 'SOM06789', order_type: 'sales_order',
  delivery_method: 'Pick-Up', outbound_location_id: 26, operator_status: 'packed', lines });
const rows = value => value.lines.map((l, index) => ({ source_line_key: l.line_id, netsuite_order_line: index + 1,
  item_id: l.item_id, item_type: l.item_type, quantity: l.quantity, location_id: 26, cached_completed_qty: 0 }));
function draft(resolution) {
  return buildOperatorNetSuitePostingDraft({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    actorOperatorId: 'test', functionKey: 'customer_pickup', transactionType: 'IF', photoRefs: [],
    policy: { gateKey: 'operator_netsuite_customer_pickup_if_150', revision: 1, effective: true,
      functionKey: 'customer_pickup', transactionType: 'IF', locationId: 26, yardCode: '150' },
    localOrderKeys: resolution.localOrderKeys, localOperation: resolution.localOperation, targets: resolution.targets });
}

test('noninventory IF rows are absent when selected and when deselected for SO and TO', () => {
  for (const orderType of ['sales_order', 'transfer_order']) {
    const inv = line('InvtPart', 1), ignored = line('NonInvtPart', 9), otherIgnored = line('NonInvtPart', 10, 0);
    const untouched = line('InvtPart', 8, 0), value = { ...order([inv, ignored, untouched, otherIgnored]), order_type: orderType };
    const before = structuredClone(value), offset = orderType === 'transfer_order' ? 1 : 0;
    const payload = buildItemFulfillmentPayload(value, [inv, ignored]);
    assert.deepEqual(payload.item.items.map(i => [i.orderLine, i.itemReceive, i.quantity]), [[1 + offset, true, 1], [8 + offset, false, undefined]]);
    assert.deepEqual(value, before);
  }
});

test('property: arbitrary noninventory items never alter inventory selections, deselections or inputs', () => {
  fc.assert(fc.property(fc.array(fc.record({ packed: fc.boolean(), quantity: fc.integer({ min: 1, max: 1000 }),
    name: fc.string({ maxLength: 40 }) }), { minLength: 1, maxLength: 12 }), fc.boolean(), (values, reverse) => {
    const lines = [line('InvtPart', 1, 2), line('InvtPart', 2, 0), ...values.map((v, i) => ({
      ...line('NonInvtPart', 20 + i, v.packed ? v.quantity : 0), item_name: v.name, quantity: v.quantity,
      isfulfillable: v.packed ? 'T' : 'F' }))];
    if (reverse) { lines.reverse(); }
    const value = order(lines), before = structuredClone(value);
    const payload = buildItemFulfillmentPayload(value, lines.filter(l => l.packed_piece_qty > 0));
    assert.deepEqual(payload.item.items.map(i => [i.orderLine, i.itemReceive, i.quantity]), [[1, true, 2], [2, false, undefined]]);
    assert.deepEqual(value, before);
  }), { seed: 20260930, numRuns: 150 });
});

test('stored source ignores a missing noninventory transform identity before validation', async () => {
  const value = order([line('InvtPart', 5055192), line('NonInvtPart', 5055216), line('InvtPart', 5055200, 0)]);
  const sourceRows = rows(value); sourceRows[1].netsuite_order_line = null;
  const source = createOperatorNetSuitePostingRealSourceResolver({ useStoredOrderLines: true, query: async () => ({ rows: sourceRows }) });
  const resolve = createOperatorNetSuitePostingTargetResolver({ getDeliveryOrder: async () => value, resolveRealSource: source });
  const resolution = await resolve({ functionKey: 'customer_pickup', orderId: value.netsuite_id });
  assert.deepEqual(resolution.targets[0].availableLines.map(l => l.orderLine), [1, 3]);
  assert.deepEqual(draft(resolution).steps[0].payload.item.items.map(i => [i.orderLine, i.itemReceive]), [[1, true], [3, false]]);
  assert.equal(value.lines.length, 3);
});

test('live source ignores ambiguous noninventory identities without hiding inventory mapping errors', async () => {
  const value = order([line('InvtPart', 1), line('NonInvtPart', 9)]);
  const live = { lines: [
    { sourceLineKey: '1', restOrderLine: 1, identityStatus: 'exact', itemType: 'InvtPart', quantity: 2, remainingQuantity: 2 },
    { sourceLineKey: '9', restOrderLine: null, identityStatus: 'ambiguous', itemType: 'NonInvtPart', quantity: 2 }
  ] };
  const source = createOperatorNetSuitePostingRealSourceResolver({ query: async () => ({ rows: rows(value) }), fetchLiveSource: async () => live });
  const result = await source(value, { functionKey: 'customer_pickup' });
  assert.deepEqual(result.availableLines.map(l => l.orderLine), [1]);
  live.lines[0].identityStatus = 'ambiguous';
  await assert.rejects(source(value, { functionKey: 'customer_pickup' }), { code: 'OPERATOR_NETSUITE_POSTING_LINE_MAPPING_UNRESOLVED' });
});

test('noninventory-only pickup completes locally and an unpacked order still fails', async () => {
  const value = order([line('NonInvtPart', 9)]); let reads = 0;
  const resolve = createOperatorNetSuitePostingTargetResolver({ getDeliveryOrder: async () => value,
    resolveRealSource: async () => { reads += 1; throw new Error('No source read or IF is needed'); } });
  const result = await resolve({ functionKey: 'customer_pickup', orderId: value.netsuite_id });
  assert.equal(result.localOnly, true); assert.deepEqual(result.targets, []); assert.equal(reads, 0);
  value.lines[0].packed_piece_qty = 0;
  await assert.rejects(resolve({ functionKey: 'customer_pickup', orderId: value.netsuite_id }), { code: 'OPERATOR_NETSUITE_POSTING_NO_LINES' });
});

test('noninventory receiving remains available for PO and TO', async () => {
  for (const type of ['purchase_order', 'transfer_order']) {
    const value = { ...order([line('NonInvtPart', 9)]), order_type: type };
    const sourceRows=rows(value);
    if(type==='transfer_order')sourceRows[0].raw=transferPhysicalEvidence({id:value.netsuite_id,itemId:1009,key:9,postingLine:1,stage:'receiving'});
    const source = createOperatorNetSuitePostingRealSourceResolver({ useStoredOrderLines: true, query: async () => ({ rows: sourceRows }) });
    const result = await source(value, { functionKey: 'receiving' });
    assert.deepEqual(result.availableLines.map(l => l.orderLine), [1]);
  }
});

test('a split TO does not require an outbound source mapping for an ignored resale line', async () => {
  const value = { ...order([line('InvtPart', 1), line('NonInvtPart', 9)]), netsuite_id: -100,
    order_type: 'transfer_order' };
  const source = createOperatorNetSuitePostingRealSourceResolver({ useStoredOrderLines: true,
    query: async sql => sql.includes('SELECT source_to_id') ? { rows: [{ source_id: 100, source_ref: 'TO100' }] } : {
      rows: [{ source_line_key: 1001, netsuite_order_line: 1, item_id: 1001, item_type: 'InvtPart', quantity: 2,
        local_line_id: 1, local_line_key: 1,
        raw:transferPhysicalEvidence({id:100,itemId:1001,key:1001,sourceLine:1,postingLine:2}) }, { source_line_key: 1009, netsuite_order_line: 9, item_id: 1009,
        item_type: 'NonInvtPart', quantity: 2, local_line_id: null, local_line_key: null }]
    } });
  const result = await source(value, { functionKey: 'delivery_prep' });
  assert.deepEqual(result.availableLines.map(l => l.orderLine), [2]);
});

test('automatic live fulfillment excludes noninventory rows before REST identity checks', async () => {
  const result = await fetchSalesOrderFulfillmentStateFromNetSuite(1028598, {
    query: async () => ({ items: [
      { id: 1028598, tranid: 'SOM06789', status: 'B', item_type: 'InvtPart', order_line: '5055192', rest_order_line: 1,
        item_id: 4756, item_name: 'Inventory', quantity: -62.76, fulfilled_quantity: 0, location_id: 26 },
      { id: 1028598, tranid: 'SOM06789', status: 'B', item_type: 'NonInvtPart', order_line: '5055216', rest_order_line: 9,
        item_id: 9920, item_name: 'Arbitrary resale', quantity: -1, fulfilled_quantity: 0, location_id: 26 }
    ] }), fetchItems: async () => [{ line: 1, item: { id: '4756' } }]
  });
  assert.deepEqual(result.lines.map(l => [l.orderLine, l.remainingQuantity]), [[1, 62.76]]);
});

test('kit fulfillment retains noninventory component evidence and excludes standalone resale rows', async () => {
  const f = kitFixture({ ratios: [1, 2] });
  f.evidence.sourceRows[2].itemtype = 'NonInvtPart';
  const standalone = { id: '10', uniquekey: '4974665', item: '9920', itemtype: 'NonInvtPart',
    quantity: '-1', quantityshiprecv: '0', location: '1' };
  f.evidence.sourceRows.push(standalone);
  f.evidence.sourceItems.push({ line: 10, lineUniqueKey: standalone.uniquekey, item: { id: standalone.item },
    quantity: 1, quantityFulfilled: 0, location: { id: '1' } });
  const value = { ...order(f.selected.map((l, i) => ({ ...line(i ? 'NonInvtPart' : 'InvtPart', Number(l.sourceLineKey)),
    item_id: l.itemId, quantity: l.quantity, packed_piece_qty: l.quantity, location_id: 1 }))), outbound_location_id: 1 };
  value.lines.push({ ...line('NonInvtPart', Number(standalone.uniquekey)), item_id: 9920, location_id: 1 });
  const source = createOperatorNetSuitePostingRealSourceResolver({ useStoredOrderLines: true,
    query: async () => ({ rows: f.evidence.sourceRows.map(row => ({ source_line_key: row.uniquekey,
      netsuite_order_line: row.id, item_id: row.item, item_type: row.itemtype, quantity: Math.abs(Number(row.quantity)), location_id: row.location })) }),
    fetchKitSource: async () => normalizeOperatorKitSource(f.evidence) });
  const resolve = createOperatorNetSuitePostingTargetResolver({ getDeliveryOrder: async () => value, resolveRealSource: source });
  const result = await resolve({ functionKey: 'customer_pickup', orderId: value.netsuite_id });
  assert.deepEqual(result.targets[0].selectedLines.map(l => [l.orderLine, l.quantity]), [[2, 1]]);
  assert.deepEqual(result.targets[0].availableLines.map(l => l.orderLine), [2]);
  assert.equal(result.targets[0].selectedLines[0].kit.physicalLines.length, 2);
});

test('operator display still considers ordinary noninventory resale lines visible', () => {
  const source = readFileSync('public/operator.js', 'utf8');
  const fn = source.slice(source.indexOf('function isPickableLine('), source.indexOf('\nfunction visibleLines('));
  const pickable = vm.runInNewContext(`const PICKABLE_ITEM_TYPES = new Set(['InvtPart','NonInvtPart']); ${fn}; isPickableLine`);
  assert.equal(pickable(line('NonInvtPart', 9920)), true);
});
