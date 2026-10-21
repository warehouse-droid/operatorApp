import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fc from 'fast-check';
import { closeDb } from '../../../src/db.js';
import { createOperatorNetSuitePostingTargetResolver } from '../../../src/operator-netsuite-posting-targets.js';
import { buildOperatorNetSuitePostingDraft } from '../../../src/operator-netsuite-posting-domain.js';
import { setOutboundLocationDirectory } from '../../../src/outbound-location-domain.js';

after(closeDb);
const yards = [1, 28, 15, 26];
const codes = { 1: '3445', 28: '2967', 15: '12441', 26: '150' };

async function pickup(selected, locations = [1, 28], counts = [2, 6], children = false) {
  setOutboundLocationDirectory([...yards.map(id => ({ id })), ...locations.map((parent, i) => ({ id: 1000 + i, parent }))]);
  const lines = locations.map((yard, i) => ({ id: 531490 + i, line_id: 5114591 + i, netsuite_order_line: i + 1,
    item_id: 4756 + i, item_type: 'InvtPart', unit: 'SQFT', netsuite_active: true, confirmed: true,
    location_id: children ? 1000 + i : yard, quantity: 100, to_lyr: 1, packed_layer_qty: counts[i] }));
  const order = { netsuite_id: 1053286, tranid: 'SOA10099', order_type: 'sales_order', delivery_method: 'Pick-Up',
    outbound_location_id: children ? 1000 : locations[0], lines };
  const resolve = createOperatorNetSuitePostingTargetResolver({ getDeliveryOrder: async () => order,
    getReceivableReceivingOrder: async () => null, resolveRealSource: async () => ({ sourceOrderKind: 'SO',
      sourceNetSuiteId: order.netsuite_id, sourceOrderRef: order.tranid, postingStrategy: 'stored_order_line_v1',
      availableLines: lines.map(line => ({ orderLine: line.netsuite_order_line, sourceLineKey: String(line.line_id),
        itemId: line.item_id, salesUom: 'SQFT', location: line.location_id, orderedQuantity: 100,
        completedQuantity: 0, remainingQuantity: 100 })) }) });
  const original = structuredClone(order);
  const result = await resolve({ functionKey: 'customer_pickup', orderId: order.netsuite_id, clientLocationId: selected });
  assert.deepEqual(order, original, 'Scoping must not rewrite the stored header, inventory locations, or other draft');
  return result;
}

for (const [yard, own, other] of [[1, 1, 2], [28, 2, 1]]) {
  test(`E11 SOA10099 ${codes[yard]} selects only its own line and deselects the other yard`, async () => {
    const result = await pickup(yard);
    assert.equal(result.canonicalLocationId, yard);
    assert.equal(result.targets[0].selectedLines.length, 1);
    assert.equal(result.targets[0].selectedLines[0].orderLine, own);
    const draft = buildOperatorNetSuitePostingDraft({ ...result, requestId: '9c2ed77c-f421-416a-a9dd-67dc4b100990',
      actorOperatorId: 'pickup-yard-test', photoRefs: [], policy: { effective: true, revision: 1,
        functionKey: 'customer_pickup', transactionType: 'IF', locationId: yard, yardCode: codes[yard], gateKey: 'test' } });
    const items = draft.steps[0].payload.item.items;
    assert.equal(items.find(line => line.orderLine === own).custcol_lyr, yard === 1 ? 2 : 6);
    assert.equal(items.find(line => line.orderLine === own).quantity, yard === 1 ? 2 : 6);
    assert.equal(items.find(line => line.orderLine === other).itemReceive, false);
    assert.equal(items.find(line => line.orderLine === other).quantity, undefined);
  });
}

test('E9 child inventory locations scope to their parent but retain the inventory location in IF', async () => {
  const result = await pickup(28, [1, 28], [2, 6], true);
  assert.equal(result.canonicalLocationId, 28);
  assert.equal(result.targets[0].selectedLines[0].location, 1001);
});

test('E9 a yard with no current line cannot post this pickup', async () => {
  await assert.rejects(pickup(15), error => error.status === 403 || error.code === 'OPERATOR_NETSUITE_POSTING_LOCATION_MISMATCH');
});

test('E11 legacy single-yard child-location pickup infers the parent without a submitted yard', async () => {
  const result = await pickup(undefined, [1], [2], true);
  assert.equal(result.canonicalLocationId, 1);
  assert.equal(result.targets[0].selectedLines[0].location, 1000);
});

test('E9 an unsupported active inventory location fails closed', async () => {
  await assert.rejects(pickup(1, [1, 195]), { status: 409, code: 'OUTBOUND_LOCATION_UNSUPPORTED' });
});

test('E9 pure scope rejects a supported yard with no owned lines', async () => {
  const { scopeCustomerPickupOrderYard } = await import('../../../src/customer-pickup-yard-scope.js');
  setOutboundLocationDirectory(yards.map(id => ({ id })));
  assert.throws(() => scopeCustomerPickupOrderYard({ outbound_location_id: 28,
    lines: [{ item_type: 'InvtPart', location_id: 28 }] }, 1), { status: 403, code: 'OPERATOR_YARD_FORBIDDEN' });
});

test('property: pickup selects precisely the requested yard across parent and child locations', async () => {
  await fc.assert(fc.asyncProperty(fc.shuffledSubarray(yards, { minLength: 2, maxLength: 4 }),
    fc.integer({ min: 1, max: 20 }), fc.boolean(), async (locations, layers, children) => {
      for (const selected of locations) {
        const result = await pickup(selected, locations, locations.map(() => layers), children);
        assert.equal(result.canonicalLocationId, selected);
        const index = locations.indexOf(selected);
        assert.deepEqual(result.targets[0].selectedLines.map(line => [line.orderLine, line.quantity, line.location]),
          [[index + 1, layers, children ? 1000 + index : selected]]);
      }
    }), { seed: 10099, numRuns: 60 });
});
