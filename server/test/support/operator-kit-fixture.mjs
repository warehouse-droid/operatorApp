import { buildOperatorNetSuitePostingDraft } from '../../src/operator-netsuite-posting-domain.js';

export function kitFixture({ ordered = 1, count = 1, ratios = [1], kitOffset = 0 } = {}) {
  const parentLine = 2 + kitOffset * 10;
  const parentKey = String(4974657 + kitOffset * 10);
  const parentItem = 10126 + kitOffset;
  const rawRow = (id, item, quantity, type, extra = {}) => ({ id: String(id), uniquekey: String(4974655 + id),
    item: String(item), quantity: String(-quantity), quantityshiprecv: '0', location: '1',
    itemtype: type, usebins: 'F', islotitem: 'F', isserialitem: 'F', ...extra });
  const parent = rawRow(parentLine, parentItem, ordered, 'Kit');
  const members = ratios.map((ratio, index) => rawRow(parentLine + index + 1, 599 + index,
    ordered * ratio, 'InvtPart', { kitmemberof: String(parentLine) }));
  const sourceItems = [{ line: parentLine, lineUniqueKey: parentKey, item: { id: String(parentItem) },
    quantity: ordered, quantityFulfilled: 0, location: { id: '1' }, isClosed: false }];
  const definition = { id: String(parentItem), isFulfillable: true,
    member: { items: ratios.map((quantity, index) => ({ item: { id: String(599 + index) }, quantity, dropShipMember: false })) } };
  const selected = members.map((row, index) => ({ sourceLineKey: row.uniquekey, itemId: Number(row.item),
    localOrderKey: 'customer_pickup:sales_order:997764', localLineId: String(458353 + index + kitOffset * 10),
    quantity: count * ratios[index], location: 1 }));
  return { evidence: { sourceItems, sourceRows: [parent, ...members], kitDefinitions: [definition] }, selected };
}

export function sobFixture() {
  const fixture = kitFixture();
  fixture.evidence.sourceItems.unshift({ line: 1, lineUniqueKey: '4974656', item: { id: '2141' },
    quantity: 95.6, quantityFulfilled: 0, location: { id: '1' } });
  fixture.evidence.sourceRows.unshift({ id: '1', uniquekey: '4974656', item: '2141', itemtype: 'InvtPart',
    quantity: '-95.6', quantityshiprecv: '0', location: '1', usebins: 'F', islotitem: 'F', isserialitem: 'F' });
  fixture.selected.unshift({ sourceLineKey: '4974656', itemId: 2141, quantity: 95.6, location: 1,
    localOrderKey: 'customer_pickup:sales_order:997764', localLineId: '458345' });
  return fixture;
}

export function kitDraft(source, selectedLines, overrides = {}) {
  return buildOperatorNetSuitePostingDraft({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    actorOperatorId: 'kit-test', functionKey: 'customer_pickup', transactionType: 'IF',
    localOrderKeys: ['customer_pickup:sales_order:997764'], photoRefs: [],
    localOperation: { kind: 'customer_pickup_load', orderType: 'sales_order', orderId: '997764' },
    policy: { gateKey: 'operator_netsuite_customer_pickup_if_3445', revision: 1, effective: true,
      functionKey: 'customer_pickup', transactionType: 'IF', locationId: 1, yardCode: '3445' },
    targets: [{ sourceOrderKind: 'SO', sourceNetSuiteId: 997764, sourceOrderRef: 'SOB120656',
      postingStrategy: 'stored_order_line_v1', ...source, selectedLines }], ...overrides });
}
