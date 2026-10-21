// User-authorized maintenance action, scoped to SPREQ-000043 and SOB122110.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const { query, withTransaction, closeDb } = await import(`${process.cwd()}/src/db.js`);
const { getSpecialStockCase, linkSpecialSalesOrder } = await import(`${process.cwd()}/src/special-stock-request-repository.js`);
const scope = { operatorId: null, authorizedStoreLocationIds: [1] };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function snapshot() {
  const tables = [
    ['request', 'SELECT * FROM sales_stock_requests WHERE id=127'],
    ['special', 'SELECT * FROM sales_special_stock_cases WHERE request_id=127'],
    ['lines', 'SELECT * FROM sales_special_stock_lines WHERE request_id=127 ORDER BY id'],
    ['draft', 'SELECT * FROM sales_special_stock_order_lines WHERE request_id=127 ORDER BY id'],
    ['order', 'SELECT * FROM sales_orders WHERE netsuite_id=1041475'],
    ['orderLines', 'SELECT * FROM sales_order_lines WHERE sales_order_id=1041475 ORDER BY line_id']
  ];
  const result = {};
  for (const [name, sql] of tables) result[name] = (await query(sql)).rows;
  return result;
}
function result(detail, before, applied) {
  assert.equal(detail.requestRef, 'SPREQ-000043');
  assert.equal(detail.salesOrderId, 1041475);
  assert.equal(detail.salesOrderRef, 'SOB122110');
  assert.equal(detail.salesOrderSource, 'manual_link');
  assert.equal(detail.netsuiteCustomerId, 12712);
  assert.equal(detail.customerId, 3435);
  assert.equal(detail.customerName, 'Beneworks Construction');
  assert.equal(detail.attention, false);
  return { applied, requestRef: detail.requestRef, revision: detail.revision,
    salesOrderId: detail.salesOrderId, salesOrderRef: detail.salesOrderRef,
    billedAccountId: detail.netsuiteCustomerId, billedAccountName: detail.netsuiteCustomerName,
    enquiryCustomerId: detail.customerId, enquiryCustomerName: detail.customerName,
    attention: detail.attention, originalLinesHash: digest(before.lines),
    canonicalOrderHash: digest(before.order), canonicalOrderLinesHash: digest(before.orderLines),
    materialQuantities: detail.lines.map(line => ({ id: line.id, quantity: line.quantity, uom: line.uom })),
    nativeSOQuantities: before.orderLines.filter(line => Number(line.item_id) === 2055)
      .map(line => ({ lineId: Number(line.line_id), quantity: Number(line.quantity), uom: line.unit })),
    originalEnquiryAndOrderPreserved: true, netSuiteWrites: 0 };
}
try {
  assert.equal(process.argv.at(-1), 'apply', 'Only the explicitly approved link action is supported');
  const outcome = await withTransaction(async () => {
    await query("SET LOCAL lock_timeout='5s'");
    await query('SELECT id FROM sales_stock_requests WHERE id=127 FOR UPDATE');
    await query('SELECT request_id FROM sales_special_stock_cases WHERE request_id=127 FOR UPDATE');
    await query('SELECT netsuite_id FROM sales_orders WHERE netsuite_id=1041475 FOR SHARE');
    const before = await snapshot();
    const detail = await getSpecialStockCase(127, { audience: 'sales', authorizedStoreLocationIds: [1] });
    assert.equal(detail.requestRef, 'SPREQ-000043');
    assert.equal(detail.customerId, 3435);
    assert.equal(detail.customerName, 'Beneworks Construction');
    assert.equal(before.order[0].tranid, 'SOB122110');
    assert.equal(Number(before.order[0].customer_id), 12712);
    assert.equal(Number(before.order[0].order_location_id), 1);
    assert.equal(before.order[0].netsuite_active, true);
    if (detail.salesOrderId === 1041475) return result(detail, before, false);
    assert.equal(detail.salesOrderId, null);
    assert.equal(detail.purchaseOrderId, null);
    assert.equal(detail.salesOrderOperationStatus, 'idle');
    assert.equal(detail.salesOrderLines.length, 0);
    assert.deepEqual(detail.lines.map(line => [line.id, line.quantity, line.uom]),
      [[76, 930.49, 'SQFT'], [77, 168.8, 'SQFT']]);
    const linked = await linkSpecialSalesOrder(127, {
      expectedRevision: detail.revision, salesOrderRef: 'SOB122110'
    }, scope);
    const after = await snapshot();
    for (const name of ['lines', 'draft', 'order', 'orderLines']) assert.deepEqual(after[name], before[name], `${name} changed`);
    const allowedRequest = new Set(['revision', 'status', 'updated_at']);
    const allowedSpecial = new Set(['sales_order_source', 'sales_order_netsuite_id', 'sales_order_ref',
      'sales_order_status', 'sales_order_approved', 'sales_order_operation_status', 'sales_order_operation_error',
      'attention', 'attention_reason', 'order_customer_netsuite_id', 'order_customer_name', 'updated_at']);
    for (const [name, allowed] of [['request', allowedRequest], ['special', allowedSpecial]]) {
      for (const [field, value] of Object.entries(before[name][0])) {
        if (!allowed.has(field)) assert.deepEqual(after[name][0][field], value, `${name}.${field} changed`);
      }
    }
    assert.equal(linked.revision, detail.revision + 1);
    assert.equal(linked.events.filter(event => event.eventType === 'special_sales_order_linked').length, 1);
    return result(linked, before, true);
  });
  console.log(JSON.stringify(outcome));
} finally { await closeDb(); }
