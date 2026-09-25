import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {query,closeDb} from '../../../src/db.js';
import {reconcileSorReturnDrafts,updateSorItemPolicy} from '../../../src/sor-rental-repository.js';
after(closeDb);
test('SOR-6 concurrent reconciliation creates one return; racing Admin edits have one winner',async()=>{
 const ref='SOR98800771';
 await query("INSERT INTO sales_orders(netsuite_id,tranid,sales_order_type,netsuite_active) VALUES(98800771,$1,'Delivery',true)",[ref]);
 await query("INSERT INTO sor_item_policies(item_id,item_name,full_name,item_type) VALUES(98800771,'Lift/Day','Lift/Day','Service')");
 try {
  const draft={refNumber:`${ref}-Return`,parentOrderRef:ref,parentSalesOrderId:98800771,pickupLocation:'77 Site Road',dropoffLocation:'3445 Kennedy Road, Toronto, ON',expectedDeliveryDate:'',lineSnapshot:[{itemId:98800771,itemName:'Lift/Day',quantity:2}],orderDetails:`Rental equipment return for ${ref}`,weightLbs:0,salesQty:2,customer:'Fixture'};
  const results=await Promise.all(Array.from({length:20},()=>reconcileSorReturnDrafts(ref,[draft])));
  assert.equal(results.reduce((n,value)=>n+value.created,0),1);
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_custom_orders WHERE parent_order_ref=$1',[ref])).rows[0].n,1);
  const edits=await Promise.allSettled(Array.from({length:20},(_,n)=>updateSorItemPolicy(98800771,{override:false,expectedRevision:0,actor:`race-${n}`})));
  assert.equal(edits.filter(result=>result.status==='fulfilled').length,1);
  assert.ok(edits.filter(result=>result.status==='rejected').every(result=>result.reason.status===409));
 } finally {
  await query('DELETE FROM dispatch_custom_orders WHERE parent_order_ref=$1',[ref]);
  await query('DELETE FROM sales_orders WHERE netsuite_id=98800771');
  await query('DELETE FROM sor_return_reconcile_queue WHERE source_ref=$1',[ref]);
  await query('DELETE FROM sor_item_policies WHERE item_id=98800771');
 }
});
