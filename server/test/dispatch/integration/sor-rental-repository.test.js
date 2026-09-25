import {beforeEach,afterEach} from 'node:test';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { query,withTransaction,closeDb } from '../../../src/db.js';
import { upsertSorItemMetadata,updateSorItemPolicy,getSorSignatureSettings,updateSorSignatureSettings,decorateSorOrders,reconcileSorReturnDrafts } from '../../../src/sor-rental-repository.js';
import {sorReturnDraft} from '../../../src/sor-rental-policy.js';
import {listDispatchOrders} from '../../../src/dispatch-repository.js';
import {listDispatchCustomOrders,dispatchOrderFromCustomOrder,canonicalizeDispatchCustomOrdersInPlan} from '../../../src/dispatch-custom-order-repository.js';
import {loadDispatchOrdersForResponse} from '../../../src/server.js';
import {upsertDispatchOrderCatalog,listDispatchOrderPool} from '../../../src/dispatch-order-catalog-repository.js';
beforeEach(()=>query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='sor_rental_workflow'"));
afterEach(()=>query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='sor_rental_workflow'"));
after(closeDb);
async function fixture(){
 await query('DELETE FROM sor_configuration_audit');
 await query("INSERT INTO sales_orders(netsuite_id,tranid,sales_order_type,netsuite_active) VALUES(98800188,'SOR98800188','Delivery',true)");
 await query("INSERT INTO sor_item_policies(item_id,item_name,full_name,item_type) VALUES(98800188,'Lift','05 MBR Equip : Lift','Service')");
 const [order]=await decorateSorOrders([{id:'SOR98800188',type:'SO',netsuiteId:98800188,address:'77 Site Road',items:[{itemId:98800188,itemName:'Lift',itemType:'Service',quantity:2}]}]);
 return {order,draft:sorReturnDraft(order)};
}
test('SOR-2 Admin revisions, stable override and T&C history',async()=>withTransaction(async()=>{
 const f=await fixture();
 await updateSorItemPolicy(98800188,{override:false,expectedRevision:0,actor:'admin'});
 await assert.rejects(updateSorItemPolicy(98800188,{override:true,expectedRevision:0,actor:'other'}),e=>e.status===409);
 const [order]=await decorateSorOrders([f.order]);assert.equal(order.items[0].sorAutoReturn,false);assert.equal(order.items[0].rentalEquipment,true);
 const setting=await getSorSignatureSettings();
 const changed=await updateSorSignatureSettings({terms:'Terms <script> are plain text',expectedRevision:setting.revision,actor:'admin'});
 assert.equal(changed.revision,setting.revision+1);
 assert.equal((await query('SELECT terms FROM sor_signature_terms_history WHERE revision=$1',[setting.revision])).rows[0].terms,setting.terms);
 assert.equal((await query('SELECT count(*)::int AS n FROM sor_configuration_audit')).rows[0].n,2);
}, {rollback:true}));
test('SOR-3 real Dispatch projects rental service cargo and SOR-4 return keeps equipment detail',async()=>withTransaction(async()=>{
 const f=await fixture();
 await query("UPDATE sales_orders SET status_text='Pending Fulfillment',outbound_location='Rental',outbound_location_id=50,dispatch_address='77 Site Road' WHERE netsuite_id=98800188");
 await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_type,quantity,netsuite_active) VALUES(98800188,1,98800188,'Lift','Service',2,true)");
 const [source]=await listDispatchOrders({type:'SO',exactOrderRefs:['SOR98800188']});
 assert.equal(source.sourceYard,'3445');assert.equal(source.items[0].rentalEquipment,true);
 await reconcileSorReturnDrafts('SOR98800188',[f.draft]);
 const [row]=await listDispatchCustomOrders({search:'SOR98800188-Return'});
 const projected=dispatchOrderFromCustomOrder(row);
 assert.equal(projected.items[0].itemName,'Lift');assert.equal(projected.items[0].quantity,2);
 assert.equal(projected.items[0].rentalEquipment,true);assert.equal(projected.orderKind,'sor_rental_return');
 assert.equal(projected.billingDisposition,'linked_parent_no_charge');
}, {rollback:true}));
test('SOR-4/6 repeated reconciliation preserves one exact return and completed history',async()=>withTransaction(async()=>{
 const f=await fixture();
 assert.ok(f.draft);assert.equal((await reconcileSorReturnDrafts('SOR98800188',[f.draft])).created,1);
 assert.equal((await reconcileSorReturnDrafts('SOR98800188',[f.draft])).created,0);
 const rows=(await query("SELECT * FROM dispatch_custom_orders WHERE parent_order_ref='SOR98800188'")).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].sales_qty,'2');assert.equal(rows[0].pickup_location,'77 Site Road');
 await query("UPDATE dispatch_custom_orders SET status='completed' WHERE id=$1",[rows[0].id]);
 await reconcileSorReturnDrafts('SOR98800188',[]);
 assert.equal((await query('SELECT status FROM dispatch_custom_orders WHERE id=$1',[rows[0].id])).rows[0].status,'completed');
}, {rollback:true}));
test('SOR-6 source changes reconcile unassigned returns and suppress empty returns',async()=>withTransaction(async()=>{
 const f=await fixture();await reconcileSorReturnDrafts('SOR98800188',[f.draft]);
 const changed={...f.draft,pickupLocation:'88 New Road',salesQty:1,lineSnapshot:f.draft.lineSnapshot.map(line=>({...line,quantity:1}))};
 assert.equal((await reconcileSorReturnDrafts('SOR98800188',[changed])).updated,1);
 assert.equal((await reconcileSorReturnDrafts('SOR98800188',[])).cancelled,1);
 assert.equal((await reconcileSorReturnDrafts('SOR98800188',[changed])).updated,1);
}, {rollback:true}));
test('SOR-7 a missing return address blocks assignment, while an unassigned pool card does not block saving',async()=>withTransaction(async()=>{
 const f=await fixture();await reconcileSorReturnDrafts('SOR98800188',[{...f.draft,pickupLocation:''}]);
 const [row]=await listDispatchCustomOrders({search:'SOR98800188-Return'});
 const order=dispatchOrderFromCustomOrder(row);
 const plan={orders:[order],trucks:[]};
 await canonicalizeDispatchCustomOrdersInPlan(plan);
 const assigned={...plan,trucks:[{id:'truck',loads:[{id:'load',stops:[{id:'drop',type:'drop',orderId:order.id}]}]}]};
 await assert.rejects(canonicalizeDispatchCustomOrdersInPlan(assigned),error=>error.code==='SOR_RETURN_ADDRESS_REQUIRED');
}, {rollback:true}));
test('SOR-2 metadata changes preserve Admin overrides and enqueue affected returns once',async()=>withTransaction(async()=>{
 await fixture();
 await query("INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_type,quantity,netsuite_active) VALUES(98800188,1,98800188,'Lift','Service',2,true)");
 await updateSorItemPolicy(98800188,{override:true,expectedRevision:0,actor:'admin'});
 await query("DELETE FROM sor_return_reconcile_queue WHERE source_ref='SOR98800188'");
 const metadata={id:98800188,itemid:'Inventory machine',fullname:'Machine',itemtype:'InvtPart'};
 await upsertSorItemMetadata([metadata]);
 const saved=(await query('SELECT * FROM sor_item_policies WHERE item_id=98800188')).rows[0];
 assert.equal(saved.auto_return_override,true);assert.equal(Number(saved.revision),1);
 const first=(await query("SELECT version FROM sor_return_reconcile_queue WHERE source_ref='SOR98800188'")).rows[0];
 assert.ok(first);
 await upsertSorItemMetadata([metadata]);
 assert.equal((await query("SELECT version FROM sor_return_reconcile_queue WHERE source_ref='SOR98800188'")).rows[0].version,first.version);
}, {rollback:true}));
test('SOR-4/6 return appears in the actual SO feed and optimized pool; cancellation hides even a stale card',async()=>withTransaction(async()=>{
 const f=await fixture();await reconcileSorReturnDrafts('SOR98800188',[f.draft]);
 const feed=await loadDispatchOrdersForResponse({type:'SO',exactOrderRefs:[f.draft.refNumber]});
 const order=feed.find(row=>row.id===f.draft.refNumber);assert.ok(order);assert.equal(order.items[0].quantity,2);
 await upsertDispatchOrderCatalog({orders:[order],source:'sor-test'});
 const pool=await listDispatchOrderPool({type:'SO',search:f.draft.refNumber});
 assert.equal(pool.orders.length,1);assert.equal(pool.orders[0].items[0].rentalEquipment,true);
 await reconcileSorReturnDrafts('SOR98800188',[]);
 assert.equal((await listDispatchOrderPool({type:'SO',search:f.draft.refNumber})).orders.length,0);
}, {rollback:true}));
