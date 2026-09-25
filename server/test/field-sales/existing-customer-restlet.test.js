import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {sandbox,payload} from './order-restlet-fixture.js';
function existing(s,p,{id='700',active=true,currency='1',subsidiaries=p.config.customerSubsidiaries}={}){
 s.records.set('customer:'+id,{id,type:'customer',fields:{entityid:'Existing builder',externalid:'created-in-netsuite',subsidiary:subsidiaries[0],currency,isinactive:!active},sublists:{}});
 for(const subsidiary of subsidiaries.slice(1)){s.relationships.push({fields:{entity:id,subsidiary}});}
 return {...p,linkedCustomerId:id,customerNetsuiteId:id};
}
test('RESTlet never creates customers or subsidiary relationships, including direct customer.ensure requests',()=>{
 for(const linked of [false,true]){
  const s=sandbox(),p=linked?existing(s,payload(),{subsidiaries:['3']}):payload(),before=s.relationships.length;
  const result=s.post({...p,action:'customer.ensure'});
  assert.equal(result.ok,false);assert.match(result.message,/created.*NetSuite|create.*NetSuite|disabled/i);
  assert.deepEqual(s.saves,[]);assert.equal(s.relationships.length,before);
 }
});
test('RESTlet uses an explicitly linked existing customer without customer form or status configuration',()=>{
 const s=sandbox(),p=existing(s,payload());delete p.config.customerFormId;delete p.config.customerStatusId;
 const customer=s.post({...p,action:'customer.lookup'});assert.equal(customer.ok,true);assert.equal(customer.internalId,p.linkedCustomerId);assert.deepEqual(customer.subsidiaries,['3','7']);
 const order=s.post({...p,action:'order.create'});assert.equal(order.ok,true,order.message);assert.equal(order.customerId,p.linkedCustomerId);assert.equal(order.totals.totalMinor,6777);
 assert.ok(s.saves.every(t=>t==='salesorder'));assert.equal(s.relationships.length,1);
 assert.equal(s.post({action:'order.health'}).customerMode,'existing-only');
});
test('RESTlet explicit identity and subsidiary property rejects missing, mismatched or unavailable customers without writes',()=>{
 fc.assert(fc.property(fc.constantFrom('missing-link','different-order-id','missing-subsidiary','inactive','currency'),mode=>{
  const s=sandbox(),p=existing(s,payload());
  if(mode==='missing-link'){delete p.linkedCustomerId;}
  if(mode==='different-order-id'){existing(s,p,{id:'701'});p.customerNetsuiteId='701';}
  if(mode==='missing-subsidiary'){s.relationships.length=0;}
  if(mode==='inactive'){s.records.get('customer:700').fields.isinactive=true;}
  if(mode==='currency'){s.records.get('customer:700').fields.currency='2';}
  const before=s.relationships.length,result=s.post({...p,action:'order.create'});
  assert.equal(result.ok,false,mode);assert.deepEqual(s.saves,[]);assert.equal(s.relationships.length,before);
 }),{numRuns:30,seed:20260922});
});
