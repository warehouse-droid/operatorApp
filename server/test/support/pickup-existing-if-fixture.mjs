export function pickupEvidence({ quantity = 109, confirmed = quantity, loaded = 0, parts = [quantity] } = {}) {
  return {
    sourceNetSuiteId: 963502, sourceOrderRef: 'SOA07444',
    order: { netsuite_id: 963502, tranid: 'SOA07444', order_type: 'sales_order', delivery_method: 'Pick-Up', outbound_location_id: 1,
      lines: [{ id: 344018, line_id: 4828215, item_id: 2875, item_type: 'InvtPart', location_id: 1, quantity, unit: 'SQFT',
        netsuite_active: true, loaded_qty: loaded, packed_sales_qty: confirmed, netsuite_order_line: null }] },
    selectedItems: [{ orderLine: 4828215, quantity: confirmed, location: 1, itemReceive: true }],
    sourceItems: [{ line: 1, lineUniqueKey: '4828215', item: { id: '2875' }, itemType: { id: 'InvtPart' },
      location: { id: '1' }, quantity, units: '494' }],
    links: parts.map((part, index) => ({ sourceOrderId: 963502, sourceRecordType: 'SalesOrd', sourceOrderRef: 'SOA07444',
      sourceOrderLine: 1, sourceLineKey: '4828215', transactionId: 977092 + index, transactionType: 'ItemShip',
      transactionRef: `IF${151113 + index}`, statusText: 'Item Fulfillment : Shipped', transactionLine: 0,
      itemId: 2875, quantity: part, unit: 'SQFT', locationId: 1 })),
    records: parts.map((part, index) => ({ id: String(977092 + index), tranId: `IF${151113 + index}`,
      createdFrom: { id: '963502' }, item: { items: [{ orderLine: 1, line: 0, itemReceive: true, item: { id: '2875' },
        itemType: 'InvtPart', location: { id: '1' }, quantity: part, units: '494', unitsDisplay: 'SQFT' }] } }))
  };
}

export function pickupCommand() {
  return { id: '46d48bf4-e0fb-4608-8acb-6e46e7c5c091', requestId: '46d48bf4-e0fb-4608-8acb-6e46e7c5c091', actorOperatorId: 'operator',
    functionKey: 'customer_pickup', transactionType: 'IF', photoRefs: [], steps: [],
    inputSnapshot: { postingStrategy: 'verified_pickup_if_v1', localOperation: { kind: 'customer_pickup_load', orderId: '963502' },
      lineReconciliation: { lines: [{ sourceOrderKind: 'SO', sourceNetSuiteId: 963502, sourceOrderRef: 'SOA07444',
        orderLine: 1, location: 1, requestedQuantity: 109, postedQuantity: 0, reconciledQuantity: 109, authoritative: true,
        linkedTransactions: [{ id: 977092, ref: 'IF151113', type: 'IF', quantity: 109 }] }] } } };
}
