import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {normalizeSnapshot,snapshotFingerprint,snapshotReady} from '../../../src/boss-approval-domain.js';
import {createBossNetSuiteAdapter} from '../../../src/boss-approval-netsuite.js';
import {createBossApprovalService} from '../../../src/boss-approval-service.js';

const base={orderId:123,tranid:'SO123',status:'A',customerId:77,customerName:'Acme',ownerId:null,
 currency:'CAD',creditLimit:'200000',balance:'14723.64',unbilledOrders:'37021.83',orderVersion:'v1',orderTotal:'54.10'};
test('credit figures include unbilled orders exactly once and display owed as a deduction',()=>{
 const s=normalizeSnapshot(base);
 assert.equal(s.unbilledOrders,'37021.83');assert.equal(s.currentOwed,'-51745.47');assert.equal(s.creditBalance,'148254.53');
 assert.equal(normalizeSnapshot({...base,orderTotal:'99999'}).creditBalance,'148254.53');
});
test('decimal arithmetic preserves cents, zero, customer credits and over-limit balances',()=>{
 for(const [creditLimit,balance,unbilledOrders,owed,remaining] of [
  ['0.3','0.1','0.2','-0.3','0'],['100','0','0','0','100'],['100','-25','5','20','120'],
  ['100','95','10','-105','-5'],['9007199254740993.01','0.01','0.02','-0.03','9007199254740992.98']
 ]){
  const s=normalizeSnapshot({...base,creditLimit,balance,unbilledOrders});
  assert.equal(s.currentOwed,owed);assert.equal(s.creditBalance,remaining);
 }
});
test('missing or malformed unbilled data is unavailable and prevents accepting a legacy snapshot',()=>{
 for(const value of [undefined,null,'','not-money']){
  const s=normalizeSnapshot({...base,unbilledOrders:value});assert.equal(s.unbilledOrders,null);
  assert.equal(s.currentOwed,null);assert.equal(s.creditBalance,null);assert.equal(snapshotReady(s),false);
 }
 const missingBalance=normalizeSnapshot({...base,balance:null});assert.equal(missingBalance.currentOwed,null);assert.equal(missingBalance.creditBalance,null);
 const missingLimit=normalizeSnapshot({...base,creditLimit:null});assert.equal(missingLimit.currentOwed,'-51745.47');assert.equal(missingLimit.creditBalance,null);
});
test('unbilled changes invalidate the financial fingerprint and block a stale approval before write',async()=>{
 assert.notEqual(snapshotFingerprint(base),snapshotFingerprint({...base,unbilledOrders:'37022.83'}));
 let wrote=false,outcome;
 const actor={id:'boss',active:true,roles:['boss']};
 const repo={settings:async()=>({enabled:true}),accountActor:async()=>actor,
  roster:async()=>[{key:'tony_tan',operatorId:'boss',active:true,roles:['boss'],ownerId:'1'}],
  beginRemote:async()=>true,finishCommand:async(_command,result)=>{outcome=result.outcome;}};
 const service=createBossApprovalService({repo,remote:{read:async()=>({...base,unbilledOrders:'37022.83'}),approve:async()=>{wrote=true;}}});
 await service.processCommand({actorId:'boss',snapshot:base,fingerprint:snapshotFingerprint(base)});
 assert.equal(wrote,false);assert.equal(outcome,'failed');
});
test('REST adapter takes balance and unbilled orders from the same customer record',async()=>{
 let customerReads=0;
 const remote=createBossNetSuiteAdapter({rest:async path=>{
  if(path.includes('salesOrder')){return {data:{id:'123',tranId:'SO123',entity:{id:'77'},orderStatus:{id:'A'},lastModifiedDate:'v1',total:54.10,custbody_mrbin_credit_balance:150151.82}};}
  if(path.includes('customer')){customerReads++;return {data:{id:'77',companyName:'Acme',creditLimit:200000,balance:14723.64,unbilledOrders:37021.83,currency:{id:'1'}}};}
  return {data:{symbol:'CAD'}};
 },queryAll:async()=>[],mutate:fn=>fn()});
 const s=await remote.read(123);assert.equal(customerReads,1);assert.equal(s.creditBalance,'148254.53');assert.equal(s.currentOwed,'-51745.47');
});
test('property: credit limit plus signed Current Owed always equals Credit Balance exactly',()=>{
 const decimal=cents=>{const n=BigInt(cents),abs=n<0n?-n:n;return `${n<0n?'-':''}${abs/100n}.${String(abs%100n).padStart(2,'0')}`;};
 const cents=value=>{assert.equal(typeof value,'string');const [whole,fraction='']=value.replace(/^-/,'').split('.');return (value.startsWith('-')?-1n:1n)*(BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0')));};
 fc.assert(fc.property(fc.integer({min:0,max:1000000000}),fc.integer({min:-1000000000,max:1000000000}),fc.integer({min:0,max:1000000000}),(limit,balance,unbilled)=>{
  const s=normalizeSnapshot({...base,creditLimit:decimal(limit),balance:decimal(balance),unbilledOrders:decimal(unbilled)});
  assert.equal(cents(s.currentOwed),-BigInt(balance)-BigInt(unbilled));assert.equal(cents(s.creditBalance),BigInt(limit)-BigInt(balance)-BigInt(unbilled));
 }),{numRuns:300,seed:20261003});
});
