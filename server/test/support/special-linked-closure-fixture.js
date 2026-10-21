/* global structuredClone */
import assert from 'node:assert/strict';

export const linkedOrders = () => [
  { id: 8877701, kind: 'sales_order', discountCount: 0, lines: [{ remoteLineId: 701, itemId: 2055, quantity: 50, description: 'Original', unitId: 865 }] },
  { id: 8877702, kind: 'purchase_order', discountCount: 0, lines: [{ remoteLineId: 702, itemId: 2055, quantity: 50, description: 'Original', unitId: 865 }] }
];

export function linkedClosureBoundary(quantity = 8) {
  const remote = new Map(linkedOrders().map(order => [order.id, [
    { line: 7, key: order.id * 10 + 7, itemId: 900, quantity, unitId: 246, rate: 19, description: 'Edited in NetSuite', closed: false },
    { line: 9, key: order.id * 10 + 9, itemId: 1784, quantity: 2, unitId: 865, rate: 40, description: 'Added pallet', closed: false },
    { line: 11, key: order.id * 10 + 11, itemId: 10716, quantity: null, unitId: null, rate: -5, description: '', closed: false }
  ]]));
  const writes = [];
  let loseResponse = false;
  return {
    remote, writes,
    set loseResponse(value) { loseResponse = value; },
    queryAll: async sql => {
      const id = Number(/tl.transaction = (\d+)/.exec(sql)[1]);
      assert.ok(remote.has(id), 'Only linked orders may be read');
      return remote.get(id).map(line => ({ uniquekey: line.key, rest_line_id: line.line, item: line.itemId,
        execution_quantity: 0, billed_quantity: 0, line_closed: line.closed ? 'T' : 'F',
        status_text: remote.get(id).every(row => row.closed) ? 'Closed' : id === 8877701 ? 'Pending Fulfillment' : 'Pending Receipt',
        base_quantity: line.quantity, unit_id: line.unitId, line_rate: line.rate, description: line.description }));
    },
    rest: async (path, options = {}) => {
      const id = Number(/\/(\d+)/.exec(path)[1]);
      assert.ok(remote.has(id), 'Only linked orders may be read or written');
      const lines = remote.get(id);
      if (options.method === 'PATCH') {
        assert.deepEqual(Object.keys(options.body), ['item']);
        assert.deepEqual(Object.keys(options.body.item), ['items']);
        writes.push({ id, body: structuredClone(options.body) });
        for (const patch of options.body.item.items) {
          assert.deepEqual(Object.keys(patch).sort(), ['isClosed', 'line']);
          assert.equal(patch.isClosed, true);
          const line = lines.find(row => row.line === patch.line);
          assert.ok(line && !line.closed && line.itemId !== 10716);
          line.closed = true;
        }
        if (lines.filter(line => line.itemId !== 10716).every(line => line.closed)) {
          for (const line of lines) line.closed = true;
        }
        if (loseResponse) { loseResponse = false; throw Error('Lost close response'); }
      }
      return { data: { item: { items: lines.map(line => ({ line: line.line, item: { id: line.itemId },
        quantity: line.quantity, units: line.unitId, rate: line.rate, description: line.description, isClosed: line.closed })) } } };
    }
  };
}
