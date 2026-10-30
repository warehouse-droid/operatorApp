import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { query, closeDb } from '../../../src/db.js';
import { listDeliveryOrders } from '../../../src/delivery-repository.js';
import { isBilledSalesOrderIdentifier, reconcileSalesOrderFromNetSuite } from '../../../src/sales-order-reconciliation-repository.js';
after(closeDb);

test('O1 SOB122244 regression: applied Billed result removes stale pending Operator entry without rewriting canonical stock or packing', async () => {
  const id = 99822440; const ref = 'SOB-RECON-BILLED';
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,sales_order_type,outbound_location_id,outbound_location,operator_status,fulfillment_status,netsuite_active,is_test_fixture,synced_at)
    VALUES($1,$2,'B','Pending Fulfillment','Delivery',1,'3445','open','not_fulfilled',true,false,now()-interval '1 day')`, [id,ref]);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_type,quantity,unit,piece_qty,to_pcs,location_id,location,netsuite_active)
    VALUES($1,1,9910,'Aggregate-HPB','InvtPart',14,'EA',14,1,1,'3445',true)`, [id]);
  const listed = async () => (await listDeliveryOrders({ locationId: 1 })).some(row => row.tranid === ref);
  const remote = { kind: 'SO', id, tranid: ref, status: 'G', statusText: 'Sales Order : Billed', sourceLocationId: 1, sourceLocation: '3445', lines: [{ id: 1, sourceLineKey: '1', lineId: 1, itemId: 9910, itemName: 'Aggregate-HPB', itemType: 'InvtPart', quantity: 14, unit: 'EA', pieceQty: 14, toPcs: 1, locationId: 1, cumulativeProgressQuantity: 14 }] };
  try {
    assert.equal(await listed(), true);
    await reconcileSalesOrderFromNetSuite({ order: remote, dryRun: true });
    assert.equal(await listed(), true, 'A proposal cannot hide pending work');
    await reconcileSalesOrderFromNetSuite({ order: remote, dryRun: false });
    assert.equal(await listed(), false, 'Applied Billed evidence must remove stale pending work');
    assert.equal(await isBilledSalesOrderIdentifier(ref), true);
    const header = (await query('SELECT status,operator_status,fulfillment_status FROM sales_orders WHERE netsuite_id=$1', [id])).rows[0];
    assert.deepEqual(header, { status: 'B', operator_status: 'open', fulfillment_status: 'not_fulfilled' });
    await query("UPDATE scm_reconciliation_order_state SET reconciliation_status='review' WHERE source_order_netsuite_id=$1 AND order_kind='SO'", [id]);
    assert.equal(await listed(), true, 'Review must remain visible');
    await query("UPDATE scm_reconciliation_order_state SET reconciliation_status='current' WHERE source_order_netsuite_id=$1 AND order_kind='SO'", [id]);
    await query('UPDATE sales_orders SET synced_at=now()+interval \'1 second\' WHERE netsuite_id=$1', [id]);
    assert.equal(await listed(), true, 'Newer canonical evidence supersedes old calculations');
  } finally {
    await query("DELETE FROM scm_reconciliation_order_state WHERE order_kind='SO' AND source_order_netsuite_id=$1", [id]);
    await query('DELETE FROM sales_order_lines WHERE sales_order_id=$1', [id]);
    await query('DELETE FROM sales_orders WHERE netsuite_id=$1', [id]);
  }
});
