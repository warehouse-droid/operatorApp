import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import fc from 'fast-check';
import {newId} from '../../public/field-sales/identity.js';
import {customerGroup,customerExternalId} from '../../src/field-sales/customers.js';
import {verifyOrder} from '../../src/field-sales/orders.js';
const runs={seed:20260921,numRuns:150};
test('Property secure fallback UUIDs have v4 version, RFC variant and unique customer group identities',()=>{
 const source={getRandomValues:bytes=>webcrypto.getRandomValues(bytes)},seen=new Set();
 fc.assert(fc.property(fc.constantFrom('MBBS','MBT','MBR'),company=>{
  const id=newId(source);assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);assert.equal(seen.has(id),false);seen.add(id);
  const expected={MBBS:'MBBS',MBT:'MBT_MBR',MBR:'MBT_MBR'}[company];assert.equal(customerGroup(company),expected);
  assert.equal(customerExternalId(id,expected),'field-sales-customer-'+id+'-'+expected.toLowerCase());
  assert.notEqual(customerExternalId(id,'MBBS'),customerExternalId(id,'MBT_MBR'));
 }),runs);
});
test('Property order acknowledgement accepts exact identity and totals and rejects any one-cent discrepancy',()=>{
 fc.assert(fc.property(fc.integer({min:0,max:100000000}),fc.integer({min:0,max:10000000}),fc.constantFrom('subtotalMinor','taxMinor','totalMinor'),fc.constantFrom(-1,1),(subtotal,tax,key,delta)=>{
  const p={externalId:'field-sales-order-test',payloadHash:'hash',revision:1,company:'MBBS',customerNetsuiteId:'1',totals:{subtotalMinor:subtotal,taxMinor:tax,totalMinor:subtotal+tax}};
  const remote={internalId:'2',externalId:p.externalId,payloadHash:p.payloadHash,revision:p.revision,company:p.company,customerId:'1',unmodified:true,totals:{...p.totals}};
  assert.doesNotThrow(()=>verifyOrder(remote,p));remote.totals[key]+=delta;assert.throws(()=>verifyOrder(remote,p),/differs/);
 }),runs);
});
test('Property mismatched remote order identity never acknowledges the accepted quote',()=>{
 fc.assert(fc.property(fc.constantFrom('externalId','payloadHash','revision','company','customerId','unmodified'),key=>{
  const p={externalId:'field-sales-order-test',payloadHash:'hash',revision:1,company:'MBBS',customerNetsuiteId:'1',totals:{subtotalMinor:100,taxMinor:13,totalMinor:113}};
  const remote={internalId:'2',externalId:p.externalId,payloadHash:p.payloadHash,revision:1,company:'MBBS',customerId:'1',unmodified:true,totals:{...p.totals}};
  remote[key]=key==='unmodified'?false:key==='revision'?2:'different';assert.throws(()=>verifyOrder(remote,p),/identity|revision/);
 }),runs);
});

test('Remote order acknowledgements reject missing, nonnumeric or unsafe amounts and IDs even for free items',()=>{
 const p={externalId:'field-sales-order-test',payloadHash:'hash',revision:1,company:'MBBS',customerNetsuiteId:'1',totals:{subtotalMinor:0,taxMinor:0,totalMinor:0}};
 const remote={internalId:'2',externalId:p.externalId,payloadHash:p.payloadHash,revision:1,company:'MBBS',customerId:'1',unmodified:true,totals:{...p.totals}};
 for(const value of [null,'',undefined,'0',Number.NaN,Number.MAX_SAFE_INTEGER+1]){assert.throws(()=>verifyOrder({...remote,totals:{...remote.totals,totalMinor:value}},p),/differs/);}
 for(const internalId of ['not-an-id','0','-1']){assert.throws(()=>verifyOrder({...remote,internalId},p),/identity|revision/);}
});
