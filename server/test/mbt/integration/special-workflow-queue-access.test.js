import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import pg from 'pg';
import {readSpecialDispatchPlans,specialDispatchPlanning} from '../../../src/special-stock-planning.js';
import fc from 'fast-check';
import {beginRollbackContext,query,closeDb} from '../../../src/db.js';
import {createSpecialStockCase,getSpecialStockCase,listSpecialStockCases} from '../../../src/special-stock-request-repository.js';
after(closeDb);
async function fixture(run){
 const tx=await beginRollbackContext();
 try{await tx.run(async()=>{
  await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES('queue-access-test','queue-access-test','TEST','hash','salt','sales',ARRAY['sales'],ARRAY[1,28]) ON CONFLICT DO NOTHING");
  const cases=[];
  for(const yard of [1,28,1,28])cases.push(await createSpecialStockCase({storeLocationId:yard,inquiryDate:'2099-01-01',customerName:'TEST Queue Access',vendorName:'TEST vendor',fulfillmentMethod:'yard_pickup',lines:[{productName:'TEST item',quantity:2,uom:'PCS',rate:100,requiredDate:'2099-02-01'}]},{operatorId:'queue-access-test',authorizedStoreLocationIds:[1,28]}));
  await run(cases);
 });}finally{await tx.rollback();}
}
const search='TEST Queue Access';
test('yard filters intersect Sales access, SCM retains every yard, and malformed filters fail',()=>fixture(async cases=>{
 const scm=await listSpecialStockCases({search,audience:'scm',storeLocationId:28});
 assert.deepEqual(scm.map(r=>r.id).sort(),cases.filter(r=>r.storeLocationId===28).map(r=>r.id).sort());
 assert.equal((await listSpecialStockCases({search,audience:'sales',authorizedStoreLocationIds:[1],storeLocationId:28})).length,0);
 assert.equal((await listSpecialStockCases({search,authorizedStoreLocationIds:[]})).length,0);
 for(const storeLocationId of ['bad',-1,1.5,'1,28'])await assert.rejects(listSpecialStockCases({search,storeLocationId}),{status:400});
 await assert.rejects(getSpecialStockCase(cases[1].id,{audience:'sales',authorizedStoreLocationIds:[1]}),{status:403});
}));
test('property: queue returns exactly the intersection of authorized yards and selected yard',()=>fixture(async cases=>{
 await fc.assert(fc.asyncProperty(fc.subarray([1,28]),fc.constantFrom('',1,28),async(allowed,yard)=>{
  const result=await listSpecialStockCases({search,audience:'sales',authorizedStoreLocationIds:allowed,storeLocationId:yard});
  const expected=cases.filter(r=>allowed.includes(r.storeLocationId)&&(!yard||r.storeLocationId===yard)).map(r=>r.id).sort();
  assert.deepEqual(result.map(r=>r.id).sort(),expected);
 }),{seed:260930,numRuns:12});
}));
test('queue hydration uses bounded SQL reads and equals full case details',()=>fixture(async()=>{
 const original=pg.Client.prototype.query;let reads=0;
 pg.Client.prototype.query=function(...args){reads++;return original.apply(this,args);};
 let cases;try{cases=await listSpecialStockCases({search,audience:'scm'});}finally{pg.Client.prototype.query=original;}
 assert.ok(reads<=9,`Expected at most 9 SQL reads, got ${reads}`);
 for(const row of cases)assert.deepEqual(row,await getSpecialStockCase(row.id,{audience:'scm'}));
 const sales=await listSpecialStockCases({search,audience:'sales',authorizedStoreLocationIds:[1]});
 for(const row of sales){assert.equal(row.storeLocationId,1);assert.ok(!JSON.stringify(row).includes('unitPurchaseCost'));assert.deepEqual(row,await getSpecialStockCase(row.id,{audience:'sales',authorizedStoreLocationIds:[1]}));}
}));


test('compact planning reads preserve nested groups, split parents, CO exclusion and unplanned orders',()=>fixture(async()=>{
 const plan=(await query("INSERT INTO dispatch_plans(plan_date,status) VALUES('2099-12-25','draft') RETURNING id")).rows[0];
 const orders=[{id:'TEST-GROUP',type:'TO',childOrders:['TEST-SO-A-S1'],childOrderDetails:[{id:'TEST-GROUP-2',type:'TO',childOrderDetails:[{id:'TEST-SO-B-S2',originalOrderId:'TEST-SO-B'}]}]},
  {id:'TEST-SO-A-S1',originalOrderId:'TEST-SO-A',items:[{payload:'Irrelevant large item snapshot'}]},
  {id:'TEST-CO',type:'CO',childOrders:['TEST-SO-C'],childOrderDetails:[{id:'TEST-SO-C'}]},
  {id:'TEST-SO-D',childOrders:null,childOrderDetails:null}];
 const trucks=[{plate:'TEST',loads:[{name:'Load',stops:[{type:'drop',orderId:'TEST-GROUP'},{type:'delivery',orderId:'TEST-CO'},{type:'pick',orderRefs:['TEST-PO-A']}]},
  {returnOnly:true,stops:[{type:'drop',orderId:'TEST-SO-D'}]}]}];
 await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2,$3,'{}')",[plan.id,JSON.stringify(orders),JSON.stringify(trucks)]);
 const plans=await readSpecialDispatchPlans();
 for(const [salesOrderRef,planned]of [['TEST-SO-A',true],['TEST-SO-B',true],['TEST-SO-C',false],['TEST-SO-D',false],['TEST-SO-E',false]]){
  const status=specialDispatchPlanning({salesOrderId:1,salesOrderRef,purchaseOrderId:2,purchaseOrderRef:'TEST-PO-A'},plans);
  assert.equal(status.salesOrder.planned,planned,salesOrderRef);assert.equal(status.purchaseOrder.planned,true);
 }
 await query("UPDATE dispatch_plans SET status='cancelled' WHERE id=$1",[plan.id]);
 assert.equal(specialDispatchPlanning({salesOrderId:1,salesOrderRef:'TEST-SO-A'},await readSpecialDispatchPlans()).anyPlanned,false);
}));
