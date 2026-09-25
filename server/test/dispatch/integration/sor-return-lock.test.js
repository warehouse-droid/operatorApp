import test,{beforeEach,afterEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {query,pool,withTransaction,closeDb,hasActiveTransaction} from '../../../src/db.js';
import {runSorReturnQueue} from '../../../src/sor-rental-service.js';
import {DISPATCH_FLEET_PLANNING_LOCK} from '../../../src/dispatch-fleet-status.js';
import {createSerialExecutor} from '../../../src/coalescing-work-queue.js';

const ref='SOR998901';
const order={id:ref,type:'SO',netsuiteId:998901,address:'77 Rental Road',items:[{itemId:998901,itemName:'Lift/Day',itemType:'Service',quantity:2}]};
beforeEach(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='sor_rental_workflow'");
 await query("DELETE FROM sor_return_reconcile_queue");
 await query("INSERT INTO sales_orders(netsuite_id,tranid,sales_order_type,netsuite_active,status_text) VALUES(998901,$1,'Delivery',true,'Pending Fulfillment')",[ref]);
});
afterEach(async()=>{
 await query("DELETE FROM dispatch_custom_orders WHERE parent_order_ref=$1",[ref]);
 await query('DELETE FROM sales_orders WHERE netsuite_id=998901');
 await query('DELETE FROM sor_return_reconcile_queue WHERE source_ref=$1',[ref]);
 await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='sor_rental_workflow'");
});
after(closeDb);
test('SOR refresh sees committed return and can acquire fleet lock on an independent connection',async()=>{
 let refreshed=false;
 const result=await runSorReturnQueue({loadOrders:async()=>[order],limit:1,refreshRefs:async refs=>{
  assert.equal(hasActiveTransaction(),false,'refresh must run outside the return transaction');
  assert.deepEqual(refs,[ref+'-Return']);
  const client=await pool.connect();
  try {
   await client.query('BEGIN');
   await client.query("SET LOCAL lock_timeout='500ms'");
   await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);
   assert.equal((await client.query('SELECT 1 FROM dispatch_custom_orders WHERE ref_number=$1',[ref+'-Return'])).rowCount,1);
   refreshed=true;
  } finally {await client.query('ROLLBACK');client.release();}
 }});
 assert.equal(refreshed,true);assert.equal(result.processed,1);
 assert.equal((await query('SELECT 1 FROM sor_return_reconcile_queue WHERE source_ref=$1',[ref])).rowCount,0);
});
test('SOR queued behind a catalog refresh needing fleet lock completes without a lock cycle',async()=>{
 const serial=createSerialExecutor();
 const client=await pool.connect();
 let contender;
 try {
  const result=await runSorReturnQueue({limit:1,loadOrders:async()=>{
   contender=serial.run(async()=>{
    await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='500ms'");
    try {await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[DISPATCH_FLEET_PLANNING_LOCK]);}
    finally {await client.query('ROLLBACK');}
   });
   contender.catch(()=>{});
   return [order];
  },refreshRefs:async()=>{await serial.run(async()=>{});await contender;}});
  assert.equal(result.processed,1);
 } finally {await contender?.catch(()=>{});await client.query('ROLLBACK');client.release();}
});
test('SOR catalog failure retains durable return and queue; retry cannot duplicate it',async()=>{
 const failed=await runSorReturnQueue({limit:1,loadOrders:async()=>[order],refreshRefs:async()=>{throw new Error('catalog unavailable');}});
 assert.equal(failed.processed,0);
 const saved=(await query('SELECT id FROM dispatch_custom_orders WHERE ref_number=$1',[ref+'-Return'])).rows;
 assert.equal(saved.length,1,'return must commit before refresh');
 assert.match((await query('SELECT last_error FROM sor_return_reconcile_queue WHERE source_ref=$1',[ref])).rows[0].last_error,/catalog unavailable/);
 assert.equal((await runSorReturnQueue({limit:1,loadOrders:async()=>[order]})).processed,1);
 assert.deepEqual((await query('SELECT id FROM dispatch_custom_orders WHERE ref_number=$1',[ref+'-Return'])).rows,saved);
});
test('SOR refresh cannot erase a newer queued source version',async()=>{
 await runSorReturnQueue({limit:1,loadOrders:async()=>[order],refreshRefs:async()=>{
  await query('UPDATE sor_return_reconcile_queue SET version=version+1,attempts=0,last_error=\'\' WHERE source_ref=$1',[ref]);
 }});
 assert.equal((await query('SELECT 1 FROM sor_return_reconcile_queue WHERE source_ref=$1',[ref])).rowCount,1);
});
test('SOR worker requested inside an outer transaction defers until commit and ignores rollback',async()=>{
 let loads=0;
 const options={limit:1,loadOrders:async()=>{loads++;return [order];}};
 await withTransaction(async()=>{
  assert.deepEqual(await runSorReturnQueue(options),{deferred:true,processed:0});
  assert.equal(loads,0);
 },{rollback:true});
 assert.equal(loads,0);
 await withTransaction(async()=>{
  assert.deepEqual(await runSorReturnQueue(options),{deferred:true,processed:0});
  assert.equal(loads,0);
 });
 assert.equal(loads,1);
});
