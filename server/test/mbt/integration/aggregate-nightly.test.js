import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { query, closeDb } from '../../../src/db.js';
import { listPendingAggregateReconciliationSources } from '../../../src/aggregate-reconciliation-repository.js';
after(closeDb);

test('A1/A2 real SQL selects pending aggregate delivery and pickup once and excludes unrelated/terminal/inactive fixtures', async () => {
  await query("INSERT INTO inventory_items(item_id,item_name) VALUES (9910,'Aggregate-HPB'),(599,'Alliance Supersand Grey') ON CONFLICT(item_id) DO UPDATE SET item_name=EXCLUDED.item_name");
  const ids = [];
  for (let n = 0; n < 9; n++) {
    const id = 99000000 + n; ids.push(id);
    await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,sales_order_type,netsuite_active,is_test_fixture)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, `SO-AGG-${n}`, n === 2 ? 'G' : n === 3 ? 'D' : 'B', n === 2 ? 'Billed' : n === 3 ? 'Partially Fulfilled' : 'Pending Fulfillment', n === 1 ? 'Pick-Up' : 'Delivery', n !== 4, n === 5]);
    await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,quantity,netsuite_active)
      VALUES($1,1,$2,$3,$4,$5)`, [id, n === 6 ? 599 : 9910, n === 6 ? 'Alliance Supersand Grey' : 'Aggregate-HPB', n === 7 ? 0 : 5, n !== 8]);
  }
  try {
    await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,quantity,netsuite_active) VALUES(99000000,2,9910,'Aggregate-HPB',3,true)");
    const selected = await listPendingAggregateReconciliationSources();
    assert.deepEqual(selected.filter(row => ids.includes(row.id)), [
      { kind: 'SO', id: 99000000, tranid: 'SO-AGG-0' }, { kind: 'SO', id: 99000001, tranid: 'SO-AGG-1' }
    ]);
  } finally {
    await query('DELETE FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[])', [ids]);
    await query('DELETE FROM sales_orders WHERE netsuite_id=ANY($1::bigint[])', [ids]);
  }
});
