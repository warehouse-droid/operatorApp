import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeDb, query, withTransaction } from '../../../src/db.js';
import { getDispatchSplitPreview } from '../../../src/dispatch-split-preview-repository.js';
import { getOperatorProgressDetails } from '../../../src/operator-order-progress-repository.js';
import { seedSalesOrder } from '../support/fulfilled-so-fixture.js';

after(closeDb);
const id = 8710414001;
const ref = 'SO-CARGO-PROGRESS-10414';
const preview = () => getDispatchSplitPreview({ orderRef: ref, type: 'SO' });
async function fixture() {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  await seedSalesOrder(id, ref, { status: 'D' });
  await query("UPDATE sales_order_lines SET item_type='InvtPart',quantity=313.8,loaded_qty=0 WHERE sales_order_id=$1", [id]);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,sku,item_name,item_type,quantity,loaded_qty,netsuite_active)
    VALUES($1,2,1987,'Delivery Charge','Delivery Charge','OthCharge',2,2,true),
      ($1,3,10414,'Special Delivery Offer','Special Delivery Offer','Discount',0,1,true),
      ($1,4,10380,'Seasonal Discount','Seasonal Discount','Discount',0,1,true)`, [id]);
}
async function snapshot() {
  return {
    header: (await query('SELECT * FROM sales_orders WHERE netsuite_id=$1', [id])).rows,
    lines: (await query('SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id', [id])).rows,
    audits: (await query('SELECT * FROM delivery_audit_log WHERE order_id=$1 ORDER BY id', [id])).rows
  };
}

test('released SO with imported charge and discount fulfillment is splittable and its data is preserved', () => withTransaction(async () => {
  await fixture();
  const before = await snapshot();
  const result = await preview();
  assert.equal(result.operatorStatus, 'open');
  assert.equal(result.localYardOrderStatus, 'Open');
  assert.deepEqual(result.items.map(item => item.quantity), [313.8, 2, 0, 0]);
  const progress = await getOperatorProgressDetails([ref]);
  assert.equal(progress[0].status, 'open');
  assert.deepEqual(await snapshot(), before);
}, { rollback: true }));

test('the same order remains protected when its goods are really packed or loaded', () => withTransaction(async () => {
  await fixture();
  await query('UPDATE sales_order_lines SET packed_sales_qty=1 WHERE id=$1', [id]);
  assert.equal((await preview()).operatorStatus, 'packed');
  await query('UPDATE sales_order_lines SET loaded_qty=0.01 WHERE id=$1', [id]);
  assert.equal((await preview()).operatorStatus, 'loaded');
  await query('UPDATE sales_order_lines SET netsuite_active=false WHERE id=$1', [id]);
  assert.equal((await preview()).operatorStatus, 'loaded');
}, { rollback: true }));
