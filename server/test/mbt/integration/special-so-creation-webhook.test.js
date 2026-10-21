import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import { reconcileSpecialOrderWebhook } from '../../../src/special-stock-request-repository.js';

after(closeDb);

test('SO webhook reports confirmed creation without comparing a draft before PO creation', async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES('so-confirmed-webhook-test','so-confirmed-webhook-test','TEST','hash','salt','admin',ARRAY['admin'],ARRAY[1]) ON CONFLICT DO NOTHING");
      await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()) ON CONFLICT DO NOTHING");
      const request = (await query("INSERT INTO sales_stock_requests(request_ref,request_type,destination_location_id,destination_name,requested_by) VALUES('SPREQ-TEST-CONFIRMED-WEBHOOK','special',1,'3445','so-confirmed-webhook-test') RETURNING id")).rows[0].id;
      await query("INSERT INTO sales_orders(netsuite_id,tranid,customer_id,order_location_id,status,status_text,netsuite_active) VALUES(8877482,'TEST-SO-WEBHOOK',999,28,'B','Pending Fulfillment',true)");
      await query("INSERT INTO sales_special_stock_cases(request_id,inquiry_date,customer_name,vendor_name,sales_order_source,sales_order_netsuite_id,sales_order_ref,sales_order_operation_status,sales_order_status,sales_order_approved,operational_yard_location_id) VALUES($1,current_date,'TEST Draft','TEST Vendor','standalone',8877482,'TEST-SO-WEBHOOK','linked','Pending Fulfillment',true,1)", [request]);
      const caseLine = (await query("INSERT INTO sales_special_stock_lines(request_id,line_number,product_name,requested_quantity,requested_uom) VALUES($1,1,'TEST Original',10,'PCS') RETURNING id", [request])).rows[0].id;
      await query("INSERT INTO sales_special_stock_order_lines(request_id,case_line_id,order_kind,item_id,item_name,description,quantity,uom,unit_rate) VALUES($1,$2,'sales_order',2055,'MBBS-Special Order','Original draft',10,'PC',5)", [request, caseLine]);
      await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_description,quantity,unit,netsuite_active) VALUES(8877482,88774821,2055,'MBBS-Special Order','Edited order',20,'SQFT',true)");
      const before = (await query('SELECT to_jsonb(l) AS data FROM sales_special_stock_order_lines l WHERE request_id=$1 ORDER BY id', [request])).rows;
      const result = await reconcileSpecialOrderWebhook({ orderKind: 'sales_order', orderId: 8877482 });
      assert.equal(result.matched, true);
      assert.equal(result.attention, false);
      const state = (await query('SELECT sales_order_ref,sales_order_operation_status,attention FROM sales_special_stock_cases WHERE request_id=$1', [request])).rows[0];
      assert.deepEqual(state, { sales_order_ref: 'TEST-SO-WEBHOOK', sales_order_operation_status: 'linked', attention: false });
      assert.deepEqual((await query('SELECT to_jsonb(l) AS data FROM sales_special_stock_order_lines l WHERE request_id=$1 ORDER BY id', [request])).rows, before);
    });
  } finally { await rollback.rollback(); }
});
