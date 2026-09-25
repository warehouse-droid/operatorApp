import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOutboundLocationHierarchy, outboundOrderYards } from '../../../src/outbound-location-domain.js';
import { splitItemFulfillmentPayload, isMixedLocationRejection, fulfillmentInventoryLocations } from '../../../src/item-fulfillment-parts-domain.js';
import { setOutboundLocationDirectory } from '../../../src/outbound-location-domain.js';
import { deliveryOrderWithinYards } from '../../../src/operator-yard-access.js';
import { createOperatorNetSuitePostingTargetResolver } from '../../../src/operator-netsuite-posting-targets.js';
import { fetchSalesOrderFulfillmentStateFromNetSuite } from '../../../src/netsuite.js';
import { compareSalesOrderFulfillmentSnapshot } from '../../../src/sales-order-auto-fulfillment-domain.js';
import { originalConsolidationOrders } from '../../../src/consolidation-load-domain.js';

const rows = [
  { id: 1, isinactive: 'F' }, { id: 28, isinactive: 'F' },
  { id: 14, parent: 1, name: '3445 Special', isinactive: 'F' },
  { id: 140, parent: 14, isinactive: 'F' },
  { id: 40, parent: 28, isinactive: 'F' },
  { id: 141, parent: 14, isinactive: 'T' },
  { id: 142, parent: 141, isinactive: 'F' },
  { id: 70, parent: 71 }, { id: 71, parent: 70 },
  { id: 49, name: '3445 - Mixed', isinactive: 'F' }
];
const payload = { externalId: 'MBBS-OPNS-example-S1', item: { items: [
  { orderLine: 1, quantity: 2, itemReceive: true, location: 1 },
  { orderLine: 3, quantity: 51.26, itemReceive: true, location: 14 },
  { orderLine: 5, quantity: 9, itemReceive: false, location: 14 }
] } };

test('C1 active child and nested child inherit only the actual parent yard', () => {
  const h = buildOutboundLocationHierarchy(rows);
  assert.equal(h.yardFor(14), 1); assert.equal(h.yardFor('140'), 1);
  assert.equal(h.yardFor(40), 28);
  assert.deepEqual(h.locationsFor(1), [1, 14, 140]);
});
test('C2 inactive, missing, cyclic and similar names cannot grant yard access', () => {
  const h = buildOutboundLocationHierarchy(rows);
  for (const id of [141, 142, 70, 71, 49, 999, null, '1 OR 1=1']) assert.equal(h.yardFor(id), null);
});
test('C3 every source line participates in outbound authorization', () => {
  const h = buildOutboundLocationHierarchy(rows);
  const order = { outbound_location_id: 1, lines: [{ location_id: 14 }, { location_id: 140 }] };
  assert.deepEqual(outboundOrderYards(order, h), [1]);
  assert.deepEqual(outboundOrderYards({ ...order, lines: [{ location_id: 14 }, { location_id: 40 }] }, h), [1, 28]);
  assert.throws(() => outboundOrderYards({ ...order, lines: [{ location_id: 999 }] }, h), /location/i);
});
test('C4 split parts preserve quantities, exact locations and explicit deselections', () => {
  const original = structuredClone(payload);
  const parts = splitItemFulfillmentPayload(payload);
  assert.deepEqual(parts.map(p => p.locationId), [1, 14]);
  assert.deepEqual(parts.map(p => p.externalId), ['MBBS-OPNS-example-S1-L1', 'MBBS-OPNS-example-S1-L14']);
  assert.deepEqual(parts.flatMap(p => p.payload.item.items.filter(i => i.itemReceive)), payload.item.items.filter(i => i.itemReceive));
  for (const part of parts) {
    assert.equal(part.payload.inventoryLocation.id, String(part.locationId));
    assert.equal(part.payload.item.items.length, 3);
    assert.deepEqual(fulfillmentInventoryLocations(part.payload), [part.locationId]);
    for (const item of part.payload.item.items.filter(item => !item.itemReceive)) {
      assert.equal(item.quantity, undefined, 'Deselected source lines cannot retain fulfillment quantity');
    }
  }
  assert.deepEqual(payload, original);
});
test('C5 location split requires an explicit final native validation rejection', () => {
  const rejected = { status: 400, netsuiteResponseReceived: true, netsuiteErrorDetails: [
    { 'o:errorCode': 'USER_ERROR', detail: 'All fulfilled items must have the same location.' }
  ] };
  assert.equal(isMixedLocationRejection(rejected), true);
  for (const error of [new Error('timeout'), { ...rejected, status: 500 }, { ...rejected, ambiguous: true },
    { ...rejected, netsuiteResponseReceived: false }, { status: 400, netsuiteResponseReceived: true },
    { ...rejected, netsuiteErrorDetails: [{ 'o:errorCode': 'USER_ERROR', detail: 'You do not have permission to use this location.' }] },
    { ...rejected, netsuiteErrorDetails: [{ 'o:errorCode': 'USER_ERROR', detail: 'Insufficient inventory at location 14.' }] }
  ]) assert.equal(isMixedLocationRejection(error), false);
});
test('C6 missing locations and duplicate REST lines cannot be split', () => {
  assert.throws(() => splitItemFulfillmentPayload({ ...payload, item: { items: [{ orderLine: 1, quantity: 2, itemReceive: true }] } }), /location/i);
  assert.throws(() => splitItemFulfillmentPayload({ ...payload, item: { items: [payload.item.items[0], payload.item.items[0]] } }), /line/i);
});

test('C7 outbound access includes a child but still excludes a different yard', () => {
  setOutboundLocationDirectory(rows);
  assert.equal(deliveryOrderWithinYards({ outbound_location_id: 14 }, [1]), true);
  assert.equal(deliveryOrderWithinYards({ outbound_location_id: 14 }, [28]), false);
  assert.equal(deliveryOrderWithinYards({ outbound_location_id: 1, lines: [{ location_id: 40 }] }, [1]), false);
});
test('C8 pickup admission keeps parent policy and child stock location', async () => {
  setOutboundLocationDirectory(rows);
  const order = { netsuite_id: 996102, tranid: 'SOB120598', order_type: 'sales_order', delivery_method: 'Pick-Up',
    outbound_location_id: 14, lines: [{ id: 9, line_id: 4970885, item_id: 8497, item_type: 'InvtPart',
      netsuite_active: true, quantity: 51.26, packed_sales_qty: 51.26, unit: 'SQFT', location_id: 14 }] };
  const resolve = createOperatorNetSuitePostingTargetResolver({ getDeliveryOrder: async () => order,
    getReceivableReceivingOrder: async () => null,
    resolveRealSource: async () => ({ sourceOrderKind: 'SO', sourceNetSuiteId: 996102, sourceOrderRef: 'SOB120598',
      availableLines: [{ orderLine: 1, sourceLineKey: '4970885', location: 14 }] }) });
  const result = await resolve({ functionKey: 'customer_pickup', orderId: 996102, clientLocationId: 1 });
  assert.equal(result.canonicalLocationId, 1);
  assert.equal(result.targets[0].selectedLines[0].location, 14);
  assert.equal(result.targets[0].selectedLines[0].orderLine, 1);
  await assert.rejects(resolve({ functionKey: 'customer_pickup', orderId: 996102, clientLocationId: 28 }), /yard/i);
});

test('C9 driver live state maps stable source key to REST line 1', async () => {
  const result = await fetchSalesOrderFulfillmentStateFromNetSuite(996102, {
    query: async () => ({ items: [{ id: '996102', tranid: 'SOB120598', status: 'B', order_line: '4970885',
      rest_order_line: '1', item_id: '8497', item_name: 'CL-OAK-RIS-MB', item_type: 'InvtPart',
      quantity: '-51.26', fulfilled_quantity: '0', location_id: '14', line_closed: 'F' }] }),
    fetchItems: async () => [{ line: 1, item: { id: '8497' }, location: { id: '14' } }]
  });
  assert.equal(result.lines[0].orderLine, 1);
  assert.equal(result.lines[0].sourceLineKey, '4970885');
  assert.equal(result.lines[0].remainingQuantity, 51.26);
});
test('C10 driver completion stops if the source inventory location changed', () => {
  const result = compareSalesOrderFulfillmentSnapshot({ snapshotLines: [
    { orderLine: 1, itemId: 8497, deliveredQuantity: 2, location: 14 }
  ], liveOrder: { closed: false, lines: [
    { orderLine: 1, itemId: 8497, quantity: 2, remainingQuantity: 2, fulfilledQuantity: 0, location: 1 }
  ] } });
  assert.equal(result.state, 'attention');
  assert.ok(result.issues.some(issue => issue.code === 'LIVE_LOCATION_CHANGED'));
});

test('C11 consolidation admits child inventory and rejects a foreign inventory line', () => {
  setOutboundLocationDirectory(rows);
  const order = { netsuite_id: 996102, outbound_location_id: 14, lines: [{ location_id: 14 }] };
  assert.deepEqual(originalConsolidationOrders([order], 1, true), [order]);
  const foreign = { ...order, lines: [{ location_id: 40 }] };
  assert.throws(() => originalConsolidationOrders([foreign], 1, true), /yard/i);
  assert.deepEqual(originalConsolidationOrders([foreign], 1, false), []);
});
