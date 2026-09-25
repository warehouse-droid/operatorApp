import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { query, withTransaction, closeDb } from '../../../src/db.js';
import { runSorReturnQueue } from '../../../src/sor-rental-service.js';
import { fetchDeliveryOrdersFromNetSuite } from '../../../src/netsuite.js';
import { MBT_ADMIN_GATE_KEYS, materializeMbtAdminGates } from '../../../src/mbt/feature-gate-catalog.js';
import { upsertDispatchOrderCatalog, listDispatchOrderPool } from '../../../src/dispatch-order-catalog-repository.js';
import { loadDispatchOrdersForResponse } from '../../../src/server.js';
import { getDriverDayJobs } from '../../../src/driver-repository.js';

after(closeDb);
const flag='sor_rental_workflow';
test('SOR gate is an independent, default-off Admin gate', async()=>{
 assert.ok(MBT_ADMIN_GATE_KEYS.includes(flag));
 const row=(await query('SELECT enabled FROM mbt_feature_flags WHERE flag_key=$1',[flag])).rows[0];
 assert.equal(row?.enabled,false);
 const on=materializeMbtAdminGates({flags:[{flagKey:flag,enabled:true,revision:0}],environment:{}}).find(g=>g.flagKey===flag);
 assert.equal(on.effective,true);
});
for(const state of ['missing','off']) test(`SOR ${state} gate stops queued automation even with legacy rollout enabled`,async()=>withTransaction(async()=>{
 await query('DELETE FROM mbt_feature_flags WHERE flag_key=$1',[flag]);
 if(state==='off')await query('INSERT INTO mbt_feature_flags(flag_key,enabled,description) VALUES($1,false,$1)',[flag]);
 await query('UPDATE sor_signature_settings SET returns_enabled=true');
 await query("INSERT INTO sor_return_reconcile_queue(source_ref) VALUES('SOR998801') ON CONFLICT DO NOTHING");
 let loads=0,refreshes=0;
 const result=await runSorReturnQueue({loadOrders:async()=>{loads++;return [];},refreshRefs:async()=>{refreshes++;},limit:1});
 assert.deepEqual(result,{disabled:true,processed:0});
 assert.equal(loads,0);assert.equal(refreshes,0);
 assert.equal((await query("SELECT 1 FROM sor_return_reconcile_queue WHERE source_ref='SOR998801'")).rowCount,1);
},{rollback:true}));
test('SOR off removes new prompts from assigned work; enabling restores prompts without changing jobs',async()=>withTransaction(async()=>{
 const date='1901-09-25',login='sor-gate-signature';
 const plan=(await query("INSERT INTO dispatch_plans(plan_date,status,revision,confirmed_at) VALUES($1,'confirmed',1,now()) RETURNING id",[date])).rows[0];
 const order={id:'SOR998802',type:'SO',customer:'Rental customer',address:'77 Customer Road',sourceYard:'3445',pickupLocations:['3445'],items:[{itemId:998802,itemName:'Lift/Day',itemType:'Service',quantity:2}]};
 const trucks=[{id:'sor-gate-truck',plate:'SOR-TEST',base:'3445',driverLogin:login,loads:[{id:'sor-load',name:'Rental delivery',driverLogin:login,stops:[{id:'sor-drop',type:'drop',orderId:order.id,location:order.address}]}]}];
 await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2,$3,'{}')",[plan.id,JSON.stringify([order]),JSON.stringify(trucks)]);
 await query('UPDATE mbt_feature_flags SET enabled=false WHERE flag_key=$1',[flag]);
 const off=(await getDriverDayJobs(login,{date})).jobs;
 assert.ok(off.some(job=>job.stopType==='dropoff'));
 assert.ok(off.every(job=>!job.customerSignaturePrompt));
 await query('UPDATE mbt_feature_flags SET enabled=true WHERE flag_key=$1',[flag]);
 const on=(await getDriverDayJobs(login,{date})).jobs;
 assert.deepEqual(on.map(job=>job.jobId),off.map(job=>job.jobId));
 assert.deepEqual(on.find(job=>job.stopType==='dropoff').customerSignaturePrompt.orderRefs,[order.id]);
},{rollback:true}));
test('SOR off prevents rental-yard NetSuite requests',async()=>withTransaction(async()=>{
 await query('UPDATE mbt_feature_flags SET enabled=false WHERE flag_key=$1',[flag]);
 assert.deepEqual(await fetchDeliveryOrdersFromNetSuite(50),[]);
},{rollback:true}));
test('SOR off hides stale rental delivery, return and group cards, preserving ordinary orders',async()=>withTransaction(async()=>{
 await query('UPDATE mbt_feature_flags SET enabled=false WHERE flag_key=$1',[flag]);
 const base={type:'SO',customer:'Gate test',sourceYard:'3445',address:'77 Site Road',items:[{itemId:998801,itemName:'Lift/Day',itemType:'Service',quantity:2}]};
 const cards=[{...base,id:'SOR998801'},{...base,id:'SOB998801'},{...base,id:'GOB998801',childOrders:['SOR998801-S1','SOB998801']}];
 await upsertDispatchOrderCatalog({orders:cards,source:'sor-gate-test'});
 const result=await listDispatchOrderPool({search:'998801'});
 assert.deepEqual(result.orders.map(o=>o.id),['SOB998801']);
 await query("INSERT INTO sales_orders(netsuite_id,tranid,sales_order_type,netsuite_active,status_text) VALUES(998801,'SOR998801','Delivery',true,'Pending Fulfillment')");
 await query("INSERT INTO dispatch_custom_orders(ref_number,order_kind,system_managed,parent_sales_order_id,billing_disposition,parent_order_ref,pickup_location,dropoff_location,order_details,weight_lbs,line_snapshot) VALUES('SOR998801-Return','sor_rental_return',true,998801,'linked_parent_no_charge','SOR998801','77 Site Road','3445 Kennedy Road','Rental',0,'[]')");
 assert.equal((await loadDispatchOrdersForResponse({type:'SO',search:'SOR998801'})).length,0);
 assert.ok((await loadDispatchOrdersForResponse({type:'SO',exactOrderRefs:['SOR998801-Return']})).some(o=>o.id==='SOR998801-Return'));
},{rollback:true}));
