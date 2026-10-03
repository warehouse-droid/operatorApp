import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { eligibleBossIds, requireBoss, snapshotFingerprint, normalizeSnapshot } from '../../../src/boss-approval-domain.js';
import { normalizeAccountEmail } from '../../../src/account-email.js';

const roster = ['tony_tan','jason_pu','alex_huang'].map((key,i)=>({key,ownerId:String(i+1),operatorId:key,active:true,roles:['boss'],email:`${key}@example.test`}));
test('owner IDs route exclusively; missing and other owners route to all three',()=>{
  for(const person of roster) { assert.deepEqual(eligibleBossIds(person.ownerId,roster),[person.operatorId]);}
  for(const owner of [null,'','42']) { assert.deepEqual(eligibleBossIds(owner,roster),roster.map(x=>x.operatorId));}
});
test('known inactive owner never falls back to another BOSS',()=>{
  assert.deepEqual(eligibleBossIds('1',[{...roster[0],active:false},...roster.slice(1)]),[]);
});
test('authority plus configured identity required; admin and client supplied role are insufficient',()=>{
  assert.equal(requireBoss({id:'tony_tan',roles:['boss']},roster).key,'tony_tan');
  for(const actor of [{id:'tony_tan',roles:['admin']},{id:'stranger',roles:['boss']},{id:'tony_tan',roles:['boss'],active:false}]) { assert.throws(()=>requireBoss(actor,roster),e=>e.status===403);}
});
test('customer balances preserve missing values and stable monetary fingerprints',()=>{
  const base={orderId:123,tranid:'SO123',status:'A',customerId:77,customerName:'Customer',ownerId:null,currency:'CAD',creditLimit:'100.00',balance:0,orderVersion:'v1'};
  const normalized=normalizeSnapshot(base);
  assert.equal(normalized.creditLimit,'100');assert.equal(normalized.balance,'0');
  assert.equal(normalizeSnapshot({...base,balance:null}).balance,null);
  assert.equal(snapshotFingerprint(normalized),snapshotFingerprint({...base,creditLimit:100,balance:'0.0',refreshedAt:'later'}));
  for(const patch of [{balance:1},{ownerId:'2'},{orderVersion:'v2'},{customerId:88}]) { assert.notEqual(snapshotFingerprint(base),snapshotFingerprint({...base,...patch}));}
});
test('email is optional, normalized, and rejects header injection or malformed addresses',()=>{
  assert.equal(normalizeAccountEmail(' Boss@Example.COM '),'boss@example.com');
  assert.equal(normalizeAccountEmail(''),'');assert.equal(normalizeAccountEmail(null),'');
  for(const value of ['bad','a@','x\r\nBcc:y@e.com','a b@example.com','x'.repeat(260)+'@x.com']) { assert.throws(()=>normalizeAccountEmail(value),e=>e.status===400);}
});
test('property: only a matching active owner or the shared roster is ever eligible',()=>{
  fc.assert(fc.property(fc.option(fc.integer({min:1,max:100})),fc.array(fc.boolean(),{minLength:3,maxLength:3}),(owner,active)=>{
    const people=roster.map((p,i)=>({...p,active:active[i]}));
    const expected=people.filter(p=>p.active&&(owner===null||owner>3||p.ownerId===String(owner))).map(p=>p.operatorId);
    assert.deepEqual(eligibleBossIds(owner,people),expected);
  }),{numRuns:200});
});
