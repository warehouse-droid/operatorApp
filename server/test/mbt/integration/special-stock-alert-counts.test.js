import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import { getSpecialStockAlertCounts } from '../../../src/special-stock-alerts.js';
import { createSpecialStockCase } from '../../../src/special-stock-request-repository.js';

after(closeDb);
test('Special counts include every new and confirmed case across yards, beyond the 60-case queue page', async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.ok(process.env.DATABASE_URL.endsWith('/mbt_verify'));
  const transaction = await beginRollbackContext();
  try {
    await transaction.run(async () => {
      const actor = 'special-alert-count-test';
      await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES($1,$1,'TEST Alert Rep','hash','salt','sales',ARRAY['sales'],ARRAY[1,28]) ON CONFLICT DO NOTHING", [actor]);
      const initial = await getSpecialStockAlertCounts(), cases = [];
      for (let index = 0; index < 66; index++) {
        cases.push(await createSpecialStockCase({
          storeLocationId: index % 2 ? 28 : 1, inquiryDate: '2099-01-01', customerName: 'TEST Alert Count',
          vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
          lines: [{ productName: 'TEST slab', quantity: 1, uom: 'PLT', rate: 10, requiredDate: '2099-02-01' }]
        }, { operatorId: actor, authorizedStoreLocationIds: [1,28] }));
      }
      await query('UPDATE sales_special_stock_cases SET sales_order_skipped=true WHERE request_id=ANY($1::bigint[])', [[cases[60].id,cases[61].id]]);
      await query("UPDATE sales_special_stock_lines SET supply_status='production', sales_decision='accepted', available_date='2099-02-01' WHERE request_id=$1", [cases[62].id]);
      await query('UPDATE sales_special_stock_cases SET sales_order_skipped=true, purchase_order_skipped=true WHERE request_id=$1', [cases[63].id]);
      await query("UPDATE sales_special_stock_cases SET close_status='closed' WHERE request_id=$1", [cases[64].id]);
      await query('UPDATE sales_special_stock_cases SET operationally_complete=true WHERE request_id=$1', [cases[65].id]);
      assert.deepEqual(await getSpecialStockAlertCounts(), { newRequests: initial.newRequests + 60, confirmedOrders: initial.confirmedOrders + 2, total: initial.total + 62 });
      await query("UPDATE sales_special_stock_cases SET close_status='closed' WHERE request_id=$1", [cases[61].id]);
      await query("UPDATE sales_special_stock_lines SET supply_status='in_stock' WHERE request_id=$1", [cases[0].id]);
      assert.deepEqual(await getSpecialStockAlertCounts(), { newRequests: initial.newRequests + 59, confirmedOrders: initial.confirmedOrders + 1, total: initial.total + 60 });
    });
  } finally { await transaction.rollback(); }
});
