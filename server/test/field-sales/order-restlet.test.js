import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sandbox,payload} from './order-restlet-fixture.js';

function linked(s,p){
 const id='700';if(!s.records.has('customer:'+id)){
  s.records.set('customer:'+id,{id,type:'customer',fields:{entityid:'Existing builder',externalid:'created-in-netsuite',subsidiary:p.config.customerSubsidiaries[0],currency:'1',isinactive:false},sublists:{}});
  for(const subsidiary of p.config.customerSubsidiaries.slice(1)){s.relationships.push({fields:{entity:id,subsidiary}});}
 }
 return {...p,linkedCustomerId:id,customerNetsuiteId:id};
}
test('Simple quotes leave NetSuite customer billing sourced instead of overriding it',()=>{
 const s=sandbox(),p=linked(s,{...payload(),useCustomerBilling:true,billToAddress:'Must not replace customer billing'}),order=s.post({...p,action:'order.create'});
 assert.equal(order.ok,true,order.message);assert.equal(order.unmodified,true);
 assert.equal(s.records.get('salesorder:'+order.internalId).fields.billaddress,undefined);
 assert.equal(s.records.get('salesorder:'+order.internalId).fields.shipaddress,p.jobsite.address);
});
test('SO RESTlet reuses an existing shared customer with both subsidiary memberships and independent company orders',()=>{
 const s=sandbox(),p=payload(),first=linked(s,p),customer=s.post({...first,action:'customer.lookup'});
 assert.deepEqual(customer.subsidiaries,['3','7']);assert.equal(customer.active,true);
 const order=s.post({...first,action:'order.create'});assert.equal(order.ok,true,order.message);assert.equal(order.unmodified,true);assert.equal(order.totals.totalMinor,6777);
 assert.equal(s.post({...first,action:'order.create'}).internalId,order.internalId);
 const mbr={...p,company:'MBR',externalId:'field-sales-order-'+randomUUID(),config:{...p.config,subsidiaryId:'7'},lines:p.lines.map(l=>({...l,company:'MBR'}))};
 const shared=linked(s,mbr);assert.equal(shared.customerNetsuiteId,first.customerNetsuiteId);
 const other=s.post({...shared,action:'order.create'});assert.equal(other.ok,true,other.message);assert.notEqual(other.internalId,order.internalId);
 assert.equal(s.saves.filter(t=>t==='customer').length,0);assert.equal(s.relationships.length,1);
 assert.equal([...s.records.values()].filter(r=>r.type==='salesorder').length,2);
});
test('SO RESTlet recovers an order commit after a lost response without customer creation',()=>{
 const s=sandbox(),p=payload('MBBS');const input=linked(s,p);s.loseNext('salesorder');
 const first=s.post({...input,action:'order.create'});assert.equal(first.ok,true,first.message);assert.equal(first.unmodified,true);
 const retry=s.post({...input,action:'order.lookup'});assert.equal(retry.internalId,first.internalId);assert.equal(retry.unmodified,true);
 assert.equal([...s.records.values()].filter(r=>r.type==='customer').length,1);assert.equal([...s.records.values()].filter(r=>r.type==='salesorder').length,1);
});
test('SO RESTlet detects external changes and keeps the existing order identity',()=>{
 const s=sandbox(),p=linked(s,payload());const order=s.post({...p,action:'order.create'});
 s.records.get('salesorder:'+order.internalId).fields.memo='Edited in NetSuite';
 const retry=s.post({...p,action:'order.create'});assert.equal(retry.internalId,order.internalId);assert.equal(retry.unmodified,false);
 const t=sandbox(),input=linked(t,payload());t.editOnSave('memo');const modified=t.post({...input,action:'order.create'});assert.equal(modified.ok,true);assert.equal(modified.unmodified,false);assert.ok(modified.internalId);
});
test('SO RESTlet validates sandbox, write gate, shared feature, item company, unit and form fields before writes',()=>{
 for(const options of [{environment:'PRODUCTION'},{writes:false},{multi:false}]){const s=sandbox(options);assert.equal(s.post({...linked(s,payload()),action:'order.create'}).ok,false);assert.equal(s.saves.length,0);}
 for(const change of [p=>{p.lines[0].company='MBBS';},p=>{p.lines[0].unitId='99';},p=>{p.config.currencyId='0';},p=>{p.lines[0].quantity='-1';},p=>{p.shippingMethod='Delivery';}]){const s=sandbox(),p=linked(s,payload());change(p);assert.equal(s.post({...p,action:'order.preflight'}).ok,false);assert.equal(s.saves.length,0);}
 const s=sandbox();s.fields.pop();assert.equal(s.post({...linked(s,payload()),action:'order.preflight'}).ok,false);assert.equal(s.saves.length,0);
 const tax=sandbox({suiteTax:true}),p=linked(tax,payload());delete p.config.taxCodeId;assert.equal(tax.post({...p,action:'order.preflight'}).ok,true);
});
