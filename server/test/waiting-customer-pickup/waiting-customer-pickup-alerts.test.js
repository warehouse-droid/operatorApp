// Release waiting-customer-pickup (2026-11-09): Special requests the customer only has to collect get
// their own stage, Waiting Customer Pickup, and Sales' "My special requests" alert counts them.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { beginRollbackContext, query, closeDb } from '../../src/db.js';
import * as repo from '../../src/special-stock-request-repository.js';
import * as alerts from '../../src/special-stock-alerts.js';

const context = { operatorId: 'waiting-pickup-sales', authorizedStoreLocationIds: [1] };
after(closeDb);

async function fixture(run) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
      await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids)
        VALUES($1,$1,$1,'hash','salt','sales',ARRAY['sales'],ARRAY[1]) ON CONFLICT DO NOTHING`, [context.operatorId]);
      await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()) ON CONFLICT DO NOTHING");
      await query(`INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash)
        VALUES(8899811,'8899811','Pickup customer','Pickup customer','CAD',true,now(),'test',repeat('e',64)) ON CONFLICT DO NOTHING`);
      await run();
    });
  } finally {
    await rollback.rollback();
  }
}

const enquiry = () => repo.createSpecialStockCase({
  storeLocationId: 1, inquiryDate: '2099-01-01', customerId: 8899811, customerName: 'Pickup customer', customerPhone: '555-0198',
  vendorId: 8899200, vendorName: 'Vendor A', fulfillmentMethod: 'yard_pickup', netsuiteSalesRep: { id: 123, name: 'Chosen Rep' },
  lines: [{ productName: 'Stone', quantity: 2, uom: 'PLT', rate: 120, requiredDate: '2099-02-01' }]
}, context);
const salesCounts = (extra = {}) => alerts.getSpecialSalesAlertCounts({ ...context, ...extra });

test('Sales alerts count requests waiting for customer pickup separately from Dispatch Arrangement', () => fixture(async () => {
  const request = await enquiry();
  // SO and PO steps skipped (test requests): delivery and yard pickup go to Dispatch Arrangement.
  await query('UPDATE sales_special_stock_cases SET sales_order_skipped=true,purchase_order_skipped=true WHERE request_id=$1', [request.id]);
  assert.deepEqual(await salesCounts(), { awaitCustomerConfirmation: 0, dispatchArrangement: 1, waitingCustomerPickup: 0,
    waitForProduction: 0, pendingUpdate: 0, total: 1 });

  // Customer pickup at the vendor yard has nothing to dispatch: the customer collects it.
  await query("UPDATE sales_special_stock_cases SET fulfillment_method='vendor_pickup' WHERE request_id=$1", [request.id]);
  assert.equal((await repo.getSpecialStockCase(request.id)).stage, 'waiting_customer_pickup');
  assert.deepEqual(await salesCounts(), { awaitCustomerConfirmation: 0, dispatchArrangement: 0, waitingCustomerPickup: 1,
    waitForProduction: 0, pendingUpdate: 0, total: 1 });
  const listed = await salesCounts({ includeRequests: true });
  assert.deepEqual(listed.requests.map(row => [row.id, row.stage]), [[request.id, 'waiting_customer_pickup']]);

  // Signed-out or yard-less callers still get the full zero shape.
  assert.deepEqual(await alerts.getSpecialSalesAlertCounts({ operatorId: context.operatorId, authorizedStoreLocationIds: [] }),
    { awaitCustomerConfirmation: 0, dispatchArrangement: 0, waitingCustomerPickup: 0, waitForProduction: 0, pendingUpdate: 0, total: 0 });
  // SCM's alert (new requests and confirmed orders) is unchanged.
  const scm = await alerts.getSpecialStockAlertCounts();
  assert.deepEqual(Object.keys(scm).sort(), ['confirmedOrders', 'newRequests', 'total']);
}));
