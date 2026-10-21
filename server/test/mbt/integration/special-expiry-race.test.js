import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {pool,query,closeDb} from '../../../src/db.js';
import {createSpecialStockCase,expireSpecialStockCases,getSpecialStockCase,updateSpecialCaseExpiry} from '../../../src/special-stock-request-repository.js';
after(closeDb);
test('expiry skips an order claim lock, observes committed state and concurrent sweepers close once',async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.ok(process.env.DATABASE_URL.endsWith('/mbt_verify'));
 const actor='special-expiry-race';const ids=[];const previous=(await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
 const client=await pool.connect();
 try{
 await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
 await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES($1,$1,$1,'hash','salt','sales',ARRAY['sales'],ARRAY[1])",[actor]);
 const ctx={operatorId:actor,authorizedStoreLocationIds:[1]};
 const make=async()=>{const d=await createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST',vendorName:'TEST',fulfillmentMethod:'yard_pickup',lines:[{productName:'TEST',quantity:1,uom:'PCS',rate:1,requiredDate:'2099-02-01'}]},ctx);ids.push(d.id);await query("UPDATE sales_special_stock_cases SET expires_on='2026-09-27' WHERE request_id=$1",[d.id]);return d;};
 const d=await make();await client.query('BEGIN');await client.query('SELECT request.id FROM sales_stock_requests request JOIN sales_special_stock_cases special ON special.request_id=request.id WHERE request.id=$1 FOR UPDATE OF request,special',[d.id]);
 await client.query("UPDATE sales_special_stock_cases SET sales_order_operation_status='creating' WHERE request_id=$1",[d.id]);
 assert.ok(!(await expireSpecialStockCases({today:'2026-09-28'})).includes(d.id));await client.query('COMMIT');
 assert.ok(!(await expireSpecialStockCases({today:'2026-09-28'})).includes(d.id));
 await query("UPDATE sales_special_stock_cases SET sales_order_operation_status='idle' WHERE request_id=$1",[d.id]);
 await updateSpecialCaseExpiry(d.id,{expectedRevision:d.revision,expiresOn:'2099-03-01'},ctx);
 assert.ok(!(await expireSpecialStockCases({today:'2026-09-28'})).includes(d.id));
 const expired=await make();const results=await Promise.all([expireSpecialStockCases({today:'2026-09-28'}),expireSpecialStockCases({today:'2026-09-28'})]);
 assert.equal(results.flat().filter(id=>id===expired.id).length,1);assert.equal((await getSpecialStockCase(expired.id)).closeStatus,'closed');
 assert.equal((await query("SELECT count(*)::int AS n FROM sales_special_stock_events WHERE request_id=$1 AND event_type='special_case_expired'",[expired.id])).rows[0].n,1);
 }finally{await client.query('ROLLBACK');client.release();await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[ids]);await query('DELETE FROM operators WHERE id=$1',[actor]);await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'",[previous]);}
});
