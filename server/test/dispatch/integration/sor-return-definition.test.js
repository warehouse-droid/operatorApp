import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {query,withTransaction,closeDb} from '../../../src/db.js';
import {sorSourceDrafts} from '../../../src/sor-rental-service.js';
import {syncDispatchDeliveryGroupsFromPlan,reconcileDispatchGlobalOrderSources,reconcileDispatchPlanGlobalOrderDefinitions} from '../../../src/dispatch-delivery-group-repository.js';

after(closeDb);
const ref='SOR998903';
const source={id:ref,type:'SO',netsuiteId:998903,address:'77 Rental Road',items:[{itemId:998903,itemName:'Lift/Day',itemType:'Service',quantity:2}]};
const collection={id:ref+'-Return',type:'CUSTOM',orderKind:'sor_rental_return',parentOrderRef:ref,sourceYard:'Customer',address:'3445 Kennedy Road',items:source.items};
async function fixture(){await query("INSERT INTO sales_orders(netsuite_id,tranid,sales_order_type,netsuite_active,status_text) VALUES(998903,$1,'Delivery',true,'Pending Fulfillment')",[ref]);}
test('SOR collection mislabelled as a split cannot remove its delivery source',async()=>withTransaction(async()=>{
 await fixture();
 await query("INSERT INTO dispatch_global_order_splits(split_ref,order_type,parent_order_ref,source_plan_date,full_order,card) VALUES($1,'CUSTOM',$2,'2026-09-24',$3,$3)",[collection.id,ref,JSON.stringify(collection)]);
 const {drafts}=await sorSourceDrafts(ref,[source,collection]);
 assert.deepEqual(drafts.map(row=>[row.refNumber,row.salesQty]),[[collection.id,2]]);
},{rollback:true}));
test('SOR plan projection persists the collection as derived and preserves true delivery splits',async()=>withTransaction(async()=>{
 await fixture();
 const plan=(await query("INSERT INTO dispatch_plans(plan_date,status,note,revision) VALUES('2098-10-01','draft','SOR derived collection regression',1) RETURNING id")).rows[0];
 const split={...source,id:ref+'-S1',originalOrderId:ref,items:[{...source.items[0],quantity:1}]};
 await syncDispatchDeliveryGroupsFromPlan({id:plan.id,planDate:'2098-10-01',revision:1,orders:[collection,split],trucks:[]});
 const rows=(await query('SELECT split_ref,definition_kind,parent_order_ref FROM dispatch_global_order_splits WHERE split_ref=ANY($1::text[]) ORDER BY split_ref',[[collection.id,split.id]])).rows;
 assert.deepEqual(rows,[{split_ref:collection.id,definition_kind:'derived',parent_order_ref:ref},{split_ref:split.id,definition_kind:'split',parent_order_ref:ref}]);
 assert.deepEqual((await sorSourceDrafts(ref,[source,collection,split])).drafts.map(row=>[row.refNumber,row.salesQty]),[[ref+'-S1-Return',1]]);
},{rollback:true}));
test('SOR definition repair only changes legacy rental collections and is repeatable',async()=>withTransaction(async()=>{
 const split={...source,id:ref+'-S1',originalOrderId:ref};
 for(const order of [collection,split])await query("INSERT INTO dispatch_global_order_splits(split_ref,order_type,parent_order_ref,source_plan_date,full_order,card) VALUES($1,$2,$3,'2026-09-24',$4,$4)",[order.id,order.type,ref,JSON.stringify(order)]);
 const migration=new URL('../../../migrations/224_sor_return_definitions.sql',import.meta.url);
 const sql=readFileSync(migration,'utf8');
 await query(sql);const first=(await query('SELECT split_ref,definition_kind,active,full_order,card FROM dispatch_global_order_splits WHERE parent_order_ref=$1 ORDER BY split_ref',[ref])).rows;
 assert.equal(first[0].definition_kind,'derived');assert.equal(first[0].full_order.globalOrderDefinitionKind,'derived');assert.equal(first[0].active,true);
 assert.equal(first[1].definition_kind,'split');assert.deepEqual(first[1].full_order,split);
 await query(sql);assert.deepEqual((await query('SELECT split_ref,definition_kind,active,full_order,card FROM dispatch_global_order_splits WHERE parent_order_ref=$1 ORDER BY split_ref',[ref])).rows,first);
},{rollback:true}));

test('SOR collection keeps its own source when the delivery source refreshes',async()=>withTransaction(async()=>{
 const saved={...collection,sourceTable:'dispatch_custom_orders',sourceAddress:'77 Customer Road',pickupLocations:['77 Customer Road'],expectedDeliveryDate:'',originalOrderId:''};
 await query("INSERT INTO dispatch_global_order_splits(split_ref,order_type,definition_kind,parent_order_ref,source_plan_date,full_order,card) VALUES($1,'CUSTOM','derived',$2,'2026-09-24',$3,$3)",[saved.id,ref,JSON.stringify(saved)]);
 const actualSplit={...source,id:ref+'-S1',originalOrderId:ref,sourceYard:'Old yard',pickupLocations:['Old yard']};
 await query("INSERT INTO dispatch_global_order_splits(split_ref,order_type,definition_kind,parent_order_ref,source_plan_date,full_order,card) VALUES($1,'SO','split',$2,'2026-09-24',$3,$3)",[actualSplit.id,ref,JSON.stringify(actualSplit)]);
 await reconcileDispatchGlobalOrderSources({orders:[{...source,sourceTable:'sales_orders',sourceYard:'Rental',pickupLocations:['Rental'],expectedDeliveryDate:'2026-09-24'}]});
 assert.deepEqual((await query('SELECT full_order FROM dispatch_global_order_splits WHERE split_ref=$1',[saved.id])).rows[0].full_order,saved);
 const fresh=(await query('SELECT full_order FROM dispatch_global_order_splits WHERE split_ref=$1',[actualSplit.id])).rows[0].full_order;
 assert.equal(fresh.sourceYard,'Rental');assert.equal(fresh.id,actualSplit.id);assert.deepEqual(fresh.items,actualSplit.items);
},{rollback:true}));

test('SOR canonical collection is not overwritten by an obsolete global delivery projection',async()=>withTransaction(async()=>{
 const canonical={...collection,sourceTable:'dispatch_custom_orders',sourceYard:'77 Customer Road',sourceAddress:'77 Customer Road',pickupLocations:['77 Customer Road'],address:'3445 Kennedy Road',expectedDeliveryDate:'',originalOrderId:''};
 const obsolete={...canonical,sourceTable:'sales_orders',sourceYard:'Rental',sourceAddress:'Rental',pickupLocations:['Rental'],expectedDeliveryDate:'2026-09-24',items:[{itemId:1,quantity:999}]};
 await query("INSERT INTO dispatch_global_order_splits(split_ref,order_type,definition_kind,parent_order_ref,source_plan_date,full_order,card) VALUES($1,'CUSTOM','derived',$2,'2026-09-24',$3,$3)",[canonical.id,ref,JSON.stringify(obsolete)]);
 const plan=await reconcileDispatchPlanGlobalOrderDefinitions({orders:[canonical],trucks:[]});
 assert.deepEqual(plan.orders,[canonical]);
},{rollback:true}));
