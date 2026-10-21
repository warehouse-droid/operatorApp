import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {beginRollbackContext,query,closeDb} from '../../src/db.js';
import {createSpecialStockCase} from '../../src/special-stock-request-repository.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
const transaction=await beginRollbackContext();
const original=`ALTER TABLE sales_special_stock_lines DROP CONSTRAINT sales_special_stock_line_availability_check;
 ALTER TABLE sales_special_stock_lines ADD CONSTRAINT sales_special_stock_line_availability_check CHECK (
 (availability_mode IS NULL AND available_date IS NULL) OR (availability_mode='dated' AND available_date IS NOT NULL)
 OR (availability_mode='no_projection' AND available_date IS NULL));
 ALTER TABLE sales_special_stock_cases DROP COLUMN sales_order_placed_date;`;
try{await transaction.run(async()=>{
 await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES('transfer-schema','transfer-schema','TEST Schema','hash','salt','sales',ARRAY['sales'],ARRAY[1])");
 const d=await createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST Migration',vendorName:'TEST Vendor',fulfillmentMethod:'yard_pickup',
  lines:[{productName:'TEST legacy transfer',quantity:1,uom:'PCS',rate:1,requiredDate:'2099-02-01'}]},{operatorId:'transfer-schema',authorizedStoreLocationIds:[1]});
 await query("UPDATE sales_special_stock_lines SET supply_status='vendor_transfer',availability_mode='dated',available_date='2020-01-10' WHERE request_id=$1",[d.id]);
 await query(original);
 const before=(await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1',[d.id])).rows;
 await query(readFileSync('migrations/294_special_transfer_eta.sql','utf8'));
 assert.deepEqual((await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1',[d.id])).rows,before);
 assert.equal((await query('SELECT sales_order_placed_date FROM sales_special_stock_cases WHERE request_id=$1',[d.id])).rows[0].sales_order_placed_date,null);
 await query("UPDATE sales_special_stock_lines SET availability_mode='so_placement',available_date=NULL WHERE request_id=$1",[d.id]);
 for(const status of ['production',null]) {
  await query('SAVEPOINT invalid_policy');
  await assert.rejects(query('UPDATE sales_special_stock_lines SET supply_status=$2 WHERE request_id=$1',[d.id,status]),{code:'23514'});
  await query('ROLLBACK TO SAVEPOINT invalid_policy');
 }
 await query("UPDATE sales_special_stock_lines SET availability_mode='dated',available_date='2020-01-10' WHERE request_id=$1",[d.id]);
 await query(original);
 assert.deepEqual((await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1',[d.id])).rows,before);
 writeFileSync('test-artifacts/transfer-eta-20261016/schema-check.json',JSON.stringify({forward:true,legacyRowsUnchanged:true,invalidPolicyRejected:true,rollbackRehearsed:true},null,2));
});}finally{await transaction.rollback();await closeDb();}
