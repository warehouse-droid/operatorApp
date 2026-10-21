import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { query, closeDb } from '../../../src/db.js';
import { listDeliveryOrders } from '../../../src/delivery-repository.js';
import { listReceivingOrders, listReceivingSources, searchReceivingItems, getReceivingOrder, getReceivableReceivingOrder, confirmReceivingLine } from '../../../src/receiving-repository.js';
import { prepareTransferPostingJob } from '../../../src/transfer-order-posting-service.js';
import { finalizeTransferPosting, assertTransferPostingStepReady } from '../../../src/transfer-order-posting-repository.js';
import { upsertOutboundTransferOrderLines, markMissingInboundOrders, listExistingInboundOrderIds } from '../../../src/order-sync-repository.js';
import { reconcileTransferOrderProgress } from '../../../src/server.js';
import { config } from '../../../src/config.js';
import { fetchTransferDeliveryOrderFromNetSuite, fetchTransferReceivingOrderFromNetSuite } from '../../../src/netsuite.js';
import { seedYardTransfer, yardRollback, yardLoad, yardReceive, yardDeliver, yardPostingDependencies } from '../../support/operator-to-yard-flow-fixture.mjs';
after(closeDb);

test('tracked TO readers retain both stages regardless of delivery status and remaining remote quantity', () => yardRollback(async () => {
  const f = await seedYardTransfer(), previous = { ...config.netsuite }, nativeFetch = globalThis.fetch;
  await query("INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,'yard-flow-fixture',now()+interval '1 hour') ON CONFLICT(id) DO UPDATE SET access_token=EXCLUDED.access_token,expires_at=EXCLUDED.expires_at");
  Object.assign(config.netsuite, { directAccessEnabled: true, restBaseUrl: 'https://netsuite.invalid/services/rest' });
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(new URL(url).origin, 'https://netsuite.invalid');
      const sql = JSON.parse(options.body).q;
      assert.doesNotMatch(sql, /LIKE '%Pending (?:Fulfillment|Receipt)%'/u);
      assert.doesNotMatch(sql, /quantityshiprecv|quantityreceived/u);
      return new Response(JSON.stringify({ items: [{ id: f.id, tranid: f.ref, status: 'G', status_text: 'Received',
        source_location_id: 1, source_location: '3445', destination_location_id: 28, destination_location: '2967' }], hasMore: false }), { status: 200 });
    };
    assert.equal(Number((await fetchTransferDeliveryOrderFromNetSuite(f.id, 1)).id), f.id);
    assert.equal(Number((await fetchTransferReceivingOrderFromNetSuite(f.id, 1)).id), f.id);
  } finally { globalThis.fetch = nativeFetch; Object.assign(config.netsuite, previous); }
}));

test('NetSuite sync never infers local truck loading from remote fulfilled quantity', () => yardRollback(async () => {
  const f = await seedYardTransfer();
  await upsertOutboundTransferOrderLines(f.id, [{ line_id: 5073149, item_id: 2299, item_name: f.ref, item_type: 'InvtPart',
    quantity: 5, unit: 'PC', piece_qty: 5, to_pcs: 1, location_id: 1, netsuite_received_qty: 5 }]);
  assert.equal(Number((await query("SELECT loaded_qty FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='outbound'", [f.id])).rows[0].loaded_qty), 0);
}));
test('NetSuite open-receipt discovery cannot remove a locally tracked Pending Fulfillment TO', () => yardRollback(async () => {
  const f = await seedYardTransfer();
  await markMissingInboundOrders({ orderFamily: 'transfer_order', activeOrderIds: [], destinationLocationId: 28 });
  assert.equal((await query("SELECT netsuite_active FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='receiving'", [f.id])).rows[0].netsuite_active, true);
}));
test('tracked Pending Fulfillment TOs are refreshed for receiving before any receipt status exists', () => yardRollback(async () => {
  const f = await seedYardTransfer();
  await query('UPDATE transfer_orders SET receiving_status=NULL WHERE netsuite_id=$1', [f.id]);
  assert.ok((await listExistingInboundOrderIds({ orderFamily: 'transfer_order', sourceLocationId: 1, destinationLocationId: 28 })).some(id => Number(id) === f.id));
  assert.ok(!(await listExistingInboundOrderIds({ orderFamily: 'transfer_order', destinationLocationId: 1 })).some(id => Number(id) === f.id));
}));
test('physical waiting status migration preserves immutable jobs and can be reapplied', () => yardRollback(async () => {
  const f = await seedYardTransfer(), loaded = await yardLoad(f);
  const sql = (await readFile(new URL('../../../migrations/279_operator_to_yard_flow.sql', import.meta.url), 'utf8'))
    .replace(/^BEGIN;\s*/u, '').replace(/COMMIT;\s*$/u, '');
  await query(sql);
  await query("UPDATE transfer_order_posting_jobs SET status='waiting_receipt' WHERE id=$1", [loaded.id]);
  await query(sql);
  const saved = (await query('SELECT * FROM transfer_order_posting_jobs WHERE id=$1', [loaded.id])).rows[0];
  assert.equal(saved.status, 'waiting_receipt');
  assert.deepEqual(saved.snapshot, loaded.snapshot);
  assert.equal(saved.operator_record_id, loaded.operator_record_id);
}));
test('NetSuite progress preserves local packing, receiving drafts and physical statuses', () => yardRollback(async () => {
  const f = await seedYardTransfer();
  const before = (await query('SELECT line_stage,loaded_qty,packed_piece_qty,received_piece_qty,confirmed,confirmed_at FROM transfer_order_lines WHERE transfer_order_id=$1 ORDER BY line_stage', [f.id])).rows;
  await reconcileTransferOrderProgress({ id: f.id, status: 'F', status_text: 'Pending Receipt', source_location_id: 1, destination_location_id: 28,
    lines: [{ line_id: 5073149, item_id: 2299, item_type: 'InvtPart', location_id: 1, quantity: 5, unit: 'PC', piece_qty: 5, to_pcs: 1, netsuite_received_qty: 5 },
      { line_id: 5073151, item_id: 2299, item_type: 'InvtPart', location_id: 28, quantity: 5, unit: 'PC', piece_qty: 5, to_pcs: 1, netsuite_received_qty: 0 }] });
  assert.deepEqual((await query('SELECT line_stage,loaded_qty,packed_piece_qty,received_piece_qty,confirmed,confirmed_at FROM transfer_order_lines WHERE transfer_order_id=$1 ORDER BY line_stage', [f.id])).rows, before);
  const order = (await query('SELECT outbound_operator_status,local_yard_order_status,status_text FROM transfer_orders WHERE netsuite_id=$1', [f.id])).rows[0];
  assert.equal(order.outbound_operator_status, 'packed');
  assert.equal(order.local_yard_order_status, 'Open');
  assert.equal(order.status_text, 'Pending Receipt');
}));

test('TO outbound preparation follows local progress across NetSuite delivery statuses', () => yardRollback(async () => {
  const f = await seedYardTransfer();
  for (const [status, statusText, fulfillment] of [['B', 'Pending Fulfillment', 'not_fulfilled'], ['F', 'Pending Receipt', 'fulfilled'], ['G', 'Received', 'fulfilled']]) {
    await query('UPDATE transfer_orders SET status=$2,status_text=$3,fulfillment_status=$4 WHERE netsuite_id=$1', [f.id, status, statusText, fulfillment]);
    assert.ok((await listDeliveryOrders({ locationId: 1, status: 'packed', orderType: 'transfer_order' })).some(o => String(o.netsuite_id) === String(f.id)), statusText);
  }
}));
test('remote received quantity cannot replace the receiving yard physical receipt', () => yardRollback(async () => {
  const f = await seedYardTransfer();
  await query("UPDATE transfer_orders SET status='G',status_text='Received' WHERE netsuite_id=$1", [f.id]);
  await query("UPDATE transfer_order_lines SET netsuite_received_qty=5 WHERE transfer_order_id=$1 AND line_stage='receiving'", [f.id]);
  const loaded = await yardLoad(f);
  assert.equal(Number((await getReceivingOrder(f.id)).lines[0].quantity), 5);
  await yardDeliver(f);
  assert.equal((await prepareTransferPostingJob(loaded.id, yardPostingDependencies(f))).command.status, 'queued');
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1', [f.id])).rowCount, 0);
  await yardReceive(f);
  assert.equal((await getReceivingOrder(f.id)).receipt_status, 'received');
}));
test('Receiving discovers a TO only after local truck loading, before NetSuite fulfillment', () => yardRollback(async () => {
  const f = await seedYardTransfer();
  const list = () => listReceivingOrders({ orderType: 'transfer_order', destinationLocationId: 28, search: f.ref });
  assert.equal((await list()).length, 0);
  await yardDeliver(f);
  assert.equal((await list()).length, 0, 'Driver completion cannot supply a physical load');
  await yardLoad(f);
  assert.equal((await list()).length, 1);
  assert.ok((await listReceivingSources({ destinationLocationId: 28 })).some(s => Number(s.source_location_id) === 1));
  assert.equal((await searchReceivingItems({ orderType: 'transfer_order', destinationLocationId: 28, search: f.ref })).length, 1);
  assert.equal((await listReceivingOrders({ orderType: 'transfer_order', destinationLocationId: 1, search: f.ref })).length, 0);
}));
test('an unloaded TO cannot be received by a direct API/repository request', () => yardRollback(async () => {
  const f = await seedYardTransfer();
  await assert.rejects(getReceivableReceivingOrder(f.id), /load/i);
  await assert.rejects(yardReceive(f), /load/i);
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1', [f.id])).rowCount, 0);
  await yardLoad(f);
  await assert.rejects(yardReceive(f, 0), /selected to receive/i);
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1', [f.id])).rowCount, 0);
}));
test('partial receiving capacity is capped at local loaded quantities and cannot be exceeded', () => yardRollback(async () => {
  const f = await seedYardTransfer();
  await query("UPDATE transfer_order_lines SET packed_piece_qty=2 WHERE transfer_order_id=$1 AND line_stage='outbound'", [f.id]);
  await yardLoad(f);
  const order = await getReceivingOrder(f.id);
  assert.equal(Number(order.lines[0].quantity), 2);
  await assert.rejects(yardReceive(f, 3), /quantity|loaded/i);
  await yardReceive(f, 2);
  assert.equal((await getReceivingOrder(f.id)).lines.length, 0);
}));
test('receiving line confirmation follows the local load and cannot draft unloaded goods', () => yardRollback(async () => {
  const f = await seedYardTransfer();
  const line = (await query("SELECT id FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='receiving'", [f.id])).rows[0];
  await query("UPDATE transfer_order_lines SET received_piece_qty=0 WHERE transfer_order_id=$1 AND line_stage='receiving'", [f.id]);
  await assert.rejects(confirmReceivingLine(f.id, line.id, { pieces: 99 }, f.operator), /loaded quantity/i);
  await query("UPDATE transfer_order_lines SET packed_piece_qty=2 WHERE transfer_order_id=$1 AND line_stage='outbound'", [f.id]);
  await yardLoad(f);
  const confirmed = await confirmReceivingLine(f.id, line.id, { pieces: 99 }, f.operator);
  assert.equal(Number(confirmed.lines[0].received_piece_qty), 2);
  assert.equal(Number((await getReceivableReceivingOrder(f.id)).receivableLines[0].quantity), 2);
  await yardReceive(f, 2);
  await assert.rejects(yardReceive(f, 1), /quantity|loaded/i);
}));
test('IF starts with loading before receiving or Driver completion', () => yardRollback(async () => {
  const f = await seedYardTransfer(), loaded = await yardLoad(f);
  assert.equal((await prepareTransferPostingJob(loaded.id, yardPostingDependencies(f))).command.status, 'queued');
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1', [f.id])).rowCount, 0);
}));
test('IR queues after the local receipt and verified IF without a Driver milestone', () => yardRollback(async () => {
  const f = await seedYardTransfer(), loaded = await yardLoad(f), received = await yardReceive(f);
  assert.equal((await prepareTransferPostingJob(received.id, yardPostingDependencies(f, 'IR'))).status, 'waiting_fulfillment');
  const ready = await prepareTransferPostingJob(loaded.id, yardPostingDependencies(f));
  assert.equal((await prepareTransferPostingJob(received.id, yardPostingDependencies(f, 'IR'))).status, 'waiting_fulfillment');
  await finalizeTransferPosting({ ...ready.command, steps: ready.command.steps.map(s => ({ ...s, status: 'posted', netSuiteTransactionId: 12345, netSuiteTransactionRef: 'IF-YARD' })) });
  const ir = await prepareTransferPostingJob(received.id, yardPostingDependencies(f, 'IR'));
  assert.equal(ir.command.status, 'queued');
  assert.equal(ir.command.steps[0].transactionType, 'IR');
}));
test('load evidence is checked again before IF transforms', () => yardRollback(async () => {
  const f = await seedYardTransfer(), loaded = await yardLoad(f);
  const ready = await prepareTransferPostingJob(loaded.id, yardPostingDependencies(f));
  await query('DELETE FROM operator_load_records WHERE id=$1', [loaded.operator_record_id]);
  await assert.rejects(assertTransferPostingStepReady(ready.command.steps[0]), /waiting_load/);
}));
test('IR without a matching local IF cannot bypass fulfillment ordering', () => yardRollback(async () => {
  const f = await seedYardTransfer();
  await yardLoad(f);
  const received = await yardReceive(f);
  await query("DELETE FROM transfer_order_posting_jobs WHERE local_to_id=$1 AND transaction_type='IF'", [f.id]);
  await yardDeliver(f);
  const result = await prepareTransferPostingJob(received.id, { ...yardPostingDependencies(f, 'IR'), resolveSource: async () => assert.fail('Missing IF evidence must block NetSuite resolution') });
  assert.equal(result.status, 'waiting_load');
}));
