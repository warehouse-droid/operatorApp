import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { query, beginRollbackContext, closeDb } from '../../../src/db.js';
import { reconcileTransferOrderProgress } from '../../../src/server.js';
import { listExistingInboundOrderIds, markMissingInboundOrders, upsertOutboundTransferOrderLines } from '../../../src/order-sync-repository.js';

after(closeDb);
async function fixture(work) {
  const context = await beginRollbackContext();
  try {
    return await context.run(async () => {
      const id = 8_988_000_000 + Math.floor(Math.random() * 100000), ref = `TO-WORKER-${randomUUID()}`;
      await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,status_text,from_location_id,to_location_id,
        netsuite_active,outbound_operator_status,receiving_status,local_yard_order_status)
        VALUES($1,$2,'B','Pending Fulfillment',1,28,true,'packed',NULL,'Open')`, [id, ref]);
      for (const stage of ['outbound', 'receiving']) {
        await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_stage,line_id,item_id,item_name,item_type,
          quantity,unit,piece_qty,to_pcs,packed_piece_qty,received_piece_qty,confirmed,netsuite_active,location_id)
          VALUES($1,$2,$3,2299,$4,'InvtPart',5,'PC',5,1,2,3,true,true,$5)`,
        [id, stage, stage === 'outbound' ? 5073149 : 5073151, ref, stage === 'outbound' ? 1 : 28]);
      }
      return work({ id, ref });
    });
  } finally { await context.rollback(); }
}

test('worker NetSuite progress preserves local truck loading, drafts and yard milestones', () => fixture(async ({ id }) => {
  const read = () => query(`SELECT line_stage,loaded_qty,packed_piece_qty,received_piece_qty,confirmed,confirmed_at
    FROM transfer_order_lines WHERE transfer_order_id=$1 ORDER BY line_stage`, [id]);
  const before = (await read()).rows;
  await reconcileTransferOrderProgress({ id, status: 'G', status_text: 'Received', source_location_id: 1, destination_location_id: 28,
    lines: [{ line_id: 5073149, item_id: 2299, item_type: 'InvtPart', location_id: 1, quantity: 5, unit: 'PC', piece_qty: 5, to_pcs: 1, netsuite_received_qty: 5 },
      { line_id: 5073151, item_id: 2299, item_type: 'InvtPart', location_id: 28, quantity: 5, unit: 'PC', piece_qty: 5, to_pcs: 1, netsuite_received_qty: 5 }] });
  assert.deepEqual((await read()).rows, before);
  assert.deepEqual((await query('SELECT outbound_operator_status,receiving_status,local_yard_order_status FROM transfer_orders WHERE netsuite_id=$1', [id])).rows[0],
    { outbound_operator_status: 'packed', receiving_status: null, local_yard_order_status: 'Open' });
}));

test('worker tracks destination refresh before receipt and does not treat open discovery as deletion', () => fixture(async ({ id }) => {
  assert.ok((await listExistingInboundOrderIds({ orderFamily: 'transfer_order', destinationLocationId: 28 })).some(value => Number(value) === id));
  await markMissingInboundOrders({ orderFamily: 'transfer_order', activeOrderIds: [], destinationLocationId: 28 });
  assert.equal((await query("SELECT netsuite_active FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='receiving'", [id])).rows[0].netsuite_active, true);
}));

test('worker inserts remote fulfilled lines with no physical loaded quantity', () => fixture(async ({ id, ref }) => {
  await query("DELETE FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='outbound'", [id]);
  await upsertOutboundTransferOrderLines(id, [{ line_id: 5073149, item_id: 2299, item_name: ref, item_type: 'InvtPart',
    quantity: 5, unit: 'PC', piece_qty: 5, to_pcs: 1, location_id: 1, netsuite_received_qty: 5 }]);
  assert.equal(Number((await query("SELECT loaded_qty FROM transfer_order_lines WHERE transfer_order_id=$1 AND line_stage='outbound'", [id])).rows[0].loaded_qty), 0);
}));
