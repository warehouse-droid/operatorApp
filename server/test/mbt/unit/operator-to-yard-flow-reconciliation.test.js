import assert from 'node:assert/strict';
import test from 'node:test';
import { planLocalYardState, receivingRowsForMissingLines, verifiedHistoricalCompletion } from '../../../tools/operator-to-yard-flow-reconciliation-plan.mjs';

const line = { id: '1', line_id: '100', line_stage: 'outbound', item_id: '2299', item_type: 'InvtPart', quantity: '5', unit: 'PC', loaded_qty: '5', loaded_uom: 'PC', netsuite_active: true };
const base = () => ({ order: { outbound_operator_status: 'loaded', local_yard_order_status: 'Loaded', receiving_status: 'received' }, lines: [{ ...line }], loads: [], receipts: [], jobs: [] });
test('remote completed flags cannot provide physical load or receipt for an operational TO', () => {
  const plan = planLocalYardState(base());
  assert.deepEqual(plan.changes, [{ id: '1', loaded_qty: 0, loaded_uom: null }]);
  assert.deepEqual(plan.header, { outbound_operator_status: 'open', local_yard_order_status: 'Open', receiving_status: 'not_received' });
});
test('cumulative partial load snapshots are maximized rather than added', () => {
  const input = base(); input.loads = [2, 3].map((quantity, id) => ({ id, load_type: 'transfer_order_load', line_snapshot: [{ lineId: 100, itemId: 2299, loadedQty: quantity, loadedUom: 'PC' }] }));
  const plan = planLocalYardState(input);
  assert.equal(plan.changes[0].loaded_qty, 3); assert.equal(plan.header.outbound_operator_status, 'partial_loaded');
});
test('ambiguous or disappeared physical item identity holds repair for review', () => {
  const input = base(); input.loads = [{ id: 1, load_type: 'transfer_order_load', line_snapshot: [{ lineId: 100, itemId: 2300, loadedQty: 5 }] }];
  const plan = planLocalYardState(input); assert.equal(plan.kind, 'review'); assert.deepEqual(plan.changes, []); assert.equal(plan.header, null);
});
test('historical, closed and direct transfers preserve their existing terminal contract', () => {
  for (const key of ['historical', 'closed', 'direct']) { const plan = planLocalYardState({ ...base(), [key]: true }); assert.deepEqual(plan.changes, []); assert.equal(plan.header, null); }
});
test('active packing and preparation survive physical milestone repair', () => {
  const packed = base(); packed.lines[0].packed_piece_qty = 2; assert.equal(planLocalYardState(packed).header.outbound_operator_status, 'packed');
  packed.order.outbound_operator_status = 'preparing'; packed.order.preparing_operator_id = 'op'; assert.equal(planLocalYardState(packed).header.outbound_operator_status, 'preparing');
});
test('only durable successful local receipts set local receipt progress', () => {
  const input = base(); input.lines.push({ ...line, id: 2, line_id: 101, line_stage: 'receiving' });
  input.receipts = [{ id: 3, receipt_status: 'received', payload: { item: { items: [{ orderLine: 101, quantity: 5 }] } } }];
  assert.equal(planLocalYardState(input).header.receiving_status, 'received');
  input.receipts[0].receipt_status = 'submitted'; assert.equal(planLocalYardState(input).header.receiving_status, 'not_received');
});
test('split destination rows retain the child quantity and require unique paired source identity', () => {
  const source = { destinationLocationId: 28, lines: [{ stage: 'outbound', identityStatus: 'exact', logicalLineIdentity: 'pair', sourceLineKey: '100', itemId: 2299 },
    { stage: 'receiving', identityStatus: 'exact', logicalLineIdentity: 'pair', sourceLineKey: '101', itemId: 2299, unit: 'PC', quantity: 50, netsuite_order_line: 2 }] };
  const plan = receivingRowsForMissingLines([line], source); assert.equal(plan.rows.length, 1); assert.equal(plan.rows[0].quantity, 5); assert.equal(plan.rows[0].line_id, '101');
  source.lines.push({ ...source.lines[1], sourceLineKey: '102' }); const bad = receivingRowsForMissingLines([line], source); assert.equal(bad.rows.length, 0); assert.ok(bad.issues.length);
});
test('historical completion requires both verified IF and IR coverage; mirrored link rows do not double quantity', () => {
  const input = base(); const source = { status: 'G', lines: [{ stage: 'outbound', identityStatus: 'exact', sourceLineKey: '100', itemId: 2299, quantity: 5 }] };
  const link = (type, quantity) => ({ transactionType: type, itemId: 2299, sourceLineKey: '100', transactionId: type, transactionLineKey: '1', quantity });
  assert.equal(verifiedHistoricalCompletion(input.order, source, [link('ItemShip', 5)]), false);
  assert.equal(verifiedHistoricalCompletion(input.order, source, [link('ItemShip', 5), link('ItemRcpt', 5)]), true);
  assert.equal(verifiedHistoricalCompletion(input.order, source, [link('ItemShip', 3), link('ItemShip', 3), link('ItemRcpt', 5)]), false);
});
test('physical partial receipt jobs use cumulative maxima instead of repeated receipt totals', () => {
  const input = base(); input.lines.push({ ...line, id: '2', line_id: '101', line_stage: 'receiving' });
  input.receipts = [3, 4].map(id => ({ id, receipt_status: 'partial_received' }));
  input.jobs = [3, 4].map(id => ({ transaction_type: 'IR', operator_record_id: String(id), snapshot: { lines: [{ sourceLineKey: '101', cumulativeQuantity: 3 }] } }));
  assert.equal(planLocalYardState(input).header.receiving_status, 'partial_received');
  input.jobs[1].snapshot.lines[0].cumulativeQuantity = 5;
  assert.equal(planLocalYardState(input).header.receiving_status, 'received');
});
test('destination rows with a different sales unit are held rather than silently converted', () => {
  const source = { lines: [{ stage: 'outbound', identityStatus: 'exact', logicalLineIdentity: 'pair', sourceLineKey: '100', itemId: 2299 },
    { stage: 'receiving', identityStatus: 'exact', logicalLineIdentity: 'pair', sourceLineKey: '101', itemId: 2299, unit: 'SQFT' }] };
  const plan = receivingRowsForMissingLines([line], source);
  assert.equal(plan.rows.length, 0); assert.match(plan.issues[0], /units differ/u);
});
test('historical IF and IR coverage follows both legs of the same logical transfer line', () => {
  const input = base(); const source = { status: 'G', lines: [
    { stage: 'outbound', identityStatus: 'exact', sourceLineKey: '100', logicalLineIdentity: 'pair', itemId: 2299, quantity: 5 },
    { stage: 'receiving', identityStatus: 'exact', sourceLineKey: '101', logicalLineIdentity: 'pair', itemId: 2299, quantity: 5 }
  ] };
  const links = ['ItemShip', 'ItemRcpt'].map((type, index) => ({ transactionType: type, itemId: 2299, sourceLineKey: index ? '101' : '100', transactionId: type, transactionLineKey: '1', quantity: 5 }));
  assert.equal(verifiedHistoricalCompletion(input.order, source, links), true);
});
