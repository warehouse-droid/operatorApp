import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { query, closeDb } from '../../../src/db.js';
import { writeAudit } from '../../../src/auth-repository.js';
import { listReceivingOrders, listReceivingSources, searchReceivingItems, getReceivingOrder, recordReceivingReceipt } from '../../../src/receiving-repository.js';
import { readTransferLoadedQuantities } from '../../../src/transfer-order-posting-repository.js';
import { prepareTransferPostingJob } from '../../../src/transfer-order-posting-service.js';
import { seedYardTransfer, yardRollback, yardLoad, yardPhotos } from '../../support/operator-to-yard-flow-fixture.mjs';
after(closeDb);

async function acceptLegacyShipment(f, quantity = 2) {
  await writeAudit({ actorType: 'system', source: 'admin', action: 'operator.to.legacy_receiving_enabled', orderId: f.id,
    details: { orderRef: f.ref, sourceNetSuiteId: f.id, verifiedLoadLines: [{ sourceLineKey: '5073149', itemId: 2299, quantity, unit: 'PC', transactionId: 900 }], netSuiteWrites: 0 } });
}
test('explicit verified legacy shipment appears only in its destination yard and is capped to the shipped quantity', () => yardRollback(async () => {
  const f = await seedYardTransfer();
  assert.equal((await listReceivingOrders({ orderType: 'transfer_order', destinationLocationId: 28, search: f.ref })).length, 0);
  await acceptLegacyShipment(f);
  assert.equal((await listReceivingOrders({ orderType: 'transfer_order', destinationLocationId: 28, search: f.ref })).length, 1);
  assert.equal((await listReceivingOrders({ orderType: 'transfer_order', destinationLocationId: 1, search: f.ref })).length, 0);
  assert.ok((await listReceivingSources({ destinationLocationId: 28 })).some(row => Number(row.source_location_id) === 1));
  assert.equal((await searchReceivingItems({ orderType: 'transfer_order', destinationLocationId: 28, search: f.ref })).length, 1);
  assert.equal(Number((await getReceivingOrder(f.id)).lines[0].quantity), 2);
  assert.equal((await query('SELECT id FROM operator_load_records WHERE order_id=$1', [f.id])).rowCount, 0);
}));
test('repeated legacy acceptance and real cumulative loads never double receiving capacity', () => yardRollback(async () => {
  const f = await seedYardTransfer(); await acceptLegacyShipment(f, 2); await acceptLegacyShipment(f, 3); await yardLoad(f);
  const quantities = await readTransferLoadedQuantities(f.id);
  assert.equal(quantities.get('2299'), 5); assert.equal(Number((await getReceivingOrder(f.id)).lines[0].quantity), 5);
}));
test('an accepted legacy shipment can save a physical yard receipt without manufacturing a load or bypassing posting guards', () => yardRollback(async () => {
  const f = await seedYardTransfer(); await acceptLegacyShipment(f, 2);
  await query("UPDATE transfer_order_lines SET received_piece_qty=2,netsuite_received_qty=5 WHERE transfer_order_id=$1 AND line_stage='receiving'", [f.id]);
  await recordReceivingReceipt(f.id, f.operator, { photoDataUrls: yardPhotos, payload: { item: { items: [{ orderLine: 5073151, itemReceive: true, quantity: 2 }] } }, response: { localOnly: true } });
  assert.equal((await getReceivingOrder(f.id)).lines.length, 0);
  const job = (await query("SELECT id FROM transfer_order_posting_jobs WHERE local_to_id=$1 AND transaction_type='IR'", [f.id])).rows[0];
  assert.equal((await prepareTransferPostingJob(job.id, { resolveSource: () => assert.fail('Historical visibility must not bypass physical posting guards') })).status, 'waiting_load');
  assert.equal((await query('SELECT id FROM operator_load_records WHERE order_id=$1', [f.id])).rowCount, 0);
}));

for (const shipment of ['legacy', 'local']) {
  test(`receiving a complete ${shipment} shipment leaves unloaded items open for a later truck`, () => yardRollback(async () => {
    const f = await seedYardTransfer();
    for (const stage of ['outbound', 'receiving']) {
      await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_stage,line_id,item_id,item_name,item_type,
        quantity,unit,piece_qty,to_pcs,packed_piece_qty,received_piece_qty,netsuite_active,location_id)
        VALUES($1,$2,$3,2300,'Unloaded second item','InvtPart',2,'PC',2,1,0,0,true,$4)`,
      [f.id, stage, stage === 'outbound' ? 5073152 : 5073154, stage === 'outbound' ? 1 : 28]);
    }
    if (shipment === 'legacy') { await acceptLegacyShipment(f, 5); }
    else { await yardLoad(f); }
    assert.equal((await getReceivingOrder(f.id)).lines.length, 1);
    const result = await recordReceivingReceipt(f.id, f.operator, { photoDataUrls: yardPhotos,
      payload: { item: { items: [{ orderLine: 5073151, itemReceive: true, quantity: 5 }] } }, response: { localOnly: true } });
    assert.equal(result.receiptStatus, 'partial_received');
    assert.equal((await query('SELECT receiving_status FROM transfer_orders WHERE netsuite_id=$1', [f.id])).rows[0].receiving_status, 'partial_received');
    assert.equal((await getReceivingOrder(f.id)).lines.length, 0);
    await query("UPDATE transfer_order_lines SET packed_piece_qty=2 WHERE transfer_order_id=$1 AND line_stage='outbound' AND item_id=2300", [f.id]);
    await query("UPDATE transfer_orders SET outbound_operator_status='packed' WHERE netsuite_id=$1", [f.id]);
    await yardLoad(f);
    assert.equal((await listReceivingOrders({ orderType: 'transfer_order', destinationLocationId: 28, search: f.ref })).length, 1);
    const remaining = await getReceivingOrder(f.id);
    assert.equal(remaining.lines.length, 1);
    assert.equal(Number(remaining.lines[0].item_id), 2300);
    assert.equal(Number(remaining.lines[0].quantity), 2);
    await query("UPDATE transfer_order_lines SET received_piece_qty=2 WHERE transfer_order_id=$1 AND line_stage='receiving' AND item_id=2300", [f.id]);
    const completed = await recordReceivingReceipt(f.id, f.operator, { photoDataUrls: yardPhotos,
      payload: { item: { items: [{ orderLine: 5073154, itemReceive: true, quantity: 2 }] } }, response: { localOnly: true } });
    assert.equal(completed.receiptStatus, 'received');
  }));
}
