import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {createSpecialStockCase} from '../../src/special-stock-request-repository.js';
import {createOperator} from '../../src/auth-repository.js';
import crypto from 'node:crypto';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
const migration='268_regular_backorder.sql';
const rollback=readFileSync('tools/backorder-requests-20261006/rollback.sql','utf8');
const upgrade=readFileSync('migrations/'+migration,'utf8');
try {
  const operator=await createOperator({username:'migration-backorder-'+crypto.randomUUID(),password:crypto.randomUUID(),displayName:'TEST migration',role:'sales',roles:['sales'],yardLocationIds:[1]});
  const old=await createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST old customer',vendorName:'TEST old vendor',fulfillmentMethod:'vendor_pickup',lines:[{productName:'Old material',quantity:1,uom:'PCS',rate:10,requiredDate:'2099-02-01'}]},
    {operatorId:operator.id,authorizedStoreLocationIds:[1]});
  const snapshot=async()=>(await query("SELECT to_jsonb(special)-'workflow_kind' AS value FROM sales_special_stock_cases special WHERE request_id=$1",[old.id])).rows[0].value;
  const before=await snapshot();
  await assert.rejects(withTransaction(async()=>{await query(rollback);throw new Error('Simulated interrupted rollback');}),/Simulated interrupted rollback/);
  assert.deepEqual(await snapshot(),before);
  assert.equal((await query('SELECT workflow_kind FROM sales_special_stock_cases WHERE request_id=$1',[old.id])).rows[0].workflow_kind,'special');
  await withTransaction(async()=>{await query(rollback);await query('DELETE FROM schema_migrations WHERE filename=$1',[migration]);});
  assert.deepEqual(await snapshot(),before);
  assert.equal((await query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='sales_special_stock_cases' AND column_name='workflow_kind'")).rows[0].n,0);
  assert.equal((await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[old.id])).rows[0].stage,old.stage);
  await assert.rejects(query("UPDATE sales_special_stock_cases SET customer_name='' WHERE request_id=$1",[old.id]),{code:'23514'});
  await withTransaction(async()=>{await query(upgrade);await query('INSERT INTO schema_migrations(filename) VALUES($1)',[migration]);});
  assert.deepEqual(await snapshot(),before);
  const back=(await query("INSERT INTO sales_stock_requests(request_type,workflow_version,regular_details,destination_location_id,destination_name,requested_by) VALUES('regular',2,'{\"deliveryMethod\":\"backorder\"}',1,'Toronto',$1) RETURNING id",[operator.id])).rows[0].id;
  await query("INSERT INTO sales_special_stock_cases(request_id,inquiry_date,customer_name,vendor_name,workflow_kind,fulfillment_method,operational_yard_location_id) VALUES($1,'2099-01-01','','TEST vendor','backorder','yard_pickup',1)",[back]);
  await assert.rejects(withTransaction(()=>query(rollback)),/Rollback refused/);
  assert.equal((await query('SELECT workflow_kind FROM sales_special_stock_cases WHERE request_id=$1',[back])).rows[0].workflow_kind,'backorder');
  await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[[old.id,back]]);
  console.log(JSON.stringify({upgrade:true,rollback:true,reupgrade:true,oldRecordPreserved:true,interruptedDdlAtomic:true,rollbackWithBackorderRefused:true}));
} finally {await closeDb();}
