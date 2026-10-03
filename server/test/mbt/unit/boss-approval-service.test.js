import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {createBossApprovalService} from '../../../src/boss-approval-service.js';
import {createBossNetSuiteAdapter} from '../../../src/boss-approval-netsuite.js';
import {snapshotFingerprint} from '../../../src/boss-approval-domain.js';

const snap={orderId:123,tranid:'SO123',status:'A',customerId:45,customerName:'Acme',ownerId:null,currency:'CAD',creditLimit:'100',balance:'120',unbilledOrders:'0',orderVersion:'v1'};
const actor={id:'tony',active:true,roles:['boss']};
const people=[{key:'tony_tan',operatorId:'tony',active:true,roles:['boss'],ownerId:'1'}];
function setup({snapshots=[snap,{...snap,status:'B'}],patchError=null,commandPatch={}}={}){
 const calls={writes:0,finished:[],claims:0,refreshed:[]};
 const command={id:'1',requestId:1,actorId:'tony',actorName:'Tony Tan',status:'queued',snapshot:snap,fingerprint:snapshotFingerprint(snap),...commandPatch};
 const repo={settings:async()=>({enabled:true}),roster:async()=>people,accountActor:async()=>actor,
  existingCommand:async()=>null,detail:async()=>({id:1,revision:1,status:'pending',snapshot:snap}),
  refreshRequest:async(id,s)=>calls.refreshed.push(s),claimDecision:async()=>{calls.claims++;return command;},
  beginRemote:async()=>true,finishCommand:async(c,result)=>calls.finished.push(result)};
 const remote={read:async()=>{const value=snapshots.shift();if(value instanceof Error){throw value;}return value;},
  approve:async()=>{calls.writes++;if(patchError){throw patchError;}}};
 return {service:createBossApprovalService({repo,remote}),repo,remote,calls,command};
}
test('Accept writes once and succeeds only after approved read-back',async()=>{
 const {service,calls,command}=setup();await service.processCommand(command);
 assert.equal(calls.writes,1);assert.equal(calls.finished[0].outcome,'approved');
});
test('successful PATCH still pending never reports success',async()=>{
 const {service,calls,command}=setup({snapshots:[snap,snap]});await service.processCommand(command);
 assert.equal(calls.writes,1);assert.equal(calls.finished[0].outcome,'failed');
});
test('timeout with pending read-back stays uncertain; reconciliation never resends',async()=>{
 const first=setup({snapshots:[snap,snap],patchError:new Error('timeout')});await first.service.processCommand(first.command);
 assert.equal(first.calls.finished[0].outcome,'uncertain');
 const next=setup({snapshots:[{...snap,status:'B'}],commandPatch:{status:'uncertain',remote_attempted_at:new Date()}});
 await next.service.processCommand(next.command);assert.equal(next.calls.writes,0);assert.equal(next.calls.finished[0].outcome,'approved');
});
test('changed credit information prevents remote write',async()=>{
 const {service,calls,command}=setup({snapshots:[{...snap,balance:'140'}]});await service.processCommand(command);
 assert.equal(calls.writes,0);assert.equal(calls.finished[0].outcome,'failed');
});
test('unavailable read-back remains uncertain and completed external statuses never send a write',async()=>{
 const lost=setup({snapshots:[snap,new Error('read-back lost')]});await lost.service.processCommand(lost.command);assert.equal(lost.calls.finished[0].outcome,'uncertain');
 for(const status of ['B','H']){const h=setup({snapshots:[{...snap,status}]});await h.service.processCommand(h.command);assert.equal(h.calls.writes,0);assert.equal(h.calls.finished[0].outcome,status==='B'?'approved':'resolved');assert.equal(h.calls.finished[0].external,true);}
});
test('revoked BOSS authority and an expired lease prevent native acceptance',async()=>{
 const revoked=setup();revoked.repo.accountActor=async()=>({...actor,active:false});await revoked.service.processCommand(revoked.command);assert.equal(revoked.calls.writes,0);assert.equal(revoked.calls.finished[0].outcome,'failed');
 const expired=setup();expired.repo.beginRemote=async()=>false;await expired.service.processCommand(expired.command);assert.equal(expired.calls.writes,0);assert.equal(expired.calls.finished.length,0);
});
test('sources enrich financial data or defer failed reads without creating a request',async()=>{
 const ok=setup({snapshots:[snap]});let applied=0;ok.repo.applySource=async(job,value)=>{assert.equal(value.orderId,job.order_id);applied++;};await ok.service.processSource({order_id:123});assert.equal(applied,1);
 const fail=setup({snapshots:[new Error('customer timeout')]});let retries=0;fail.repo.failSource=async()=>{retries++;};assert.equal(await fail.service.processSource({order_id:123}),null);assert.equal(retries,1);
});
test('Reject validates fresh data before enqueueing the asynchronous decision',async()=>{
 const {service,calls}=setup({snapshots:[snap]});
 await service.decide(actor,{requestId:1,expectedRevision:1,action:'reject',commandId:'ebaa99b8-9c45-49a0-a5b0-40f1e3f301fa'});
 assert.equal(calls.claims,1);assert.equal(calls.writes,0);
});
test('stale confirmation updates the card and requires another confirmation',async()=>{
 const {service,calls}=setup({snapshots:[{...snap,ownerId:'2'}]});
 await assert.rejects(()=>service.decide(actor,{requestId:1,expectedRevision:1,action:'accept',commandId:'ebaa99b8-9c45-49a0-a5b0-40f1e3f301fa'}),e=>e.status===409);
 assert.equal(calls.claims,0);assert.equal(calls.refreshed.length,1);
});
test('native adapter reads customer A/R balance and sends only orderStatus B',async()=>{
 const requests=[];
 const remote=createBossNetSuiteAdapter({rest:async(path,opts={})=>{
  requests.push({path,...opts});
  if(opts.method==='PATCH'){return {status:204};}
  if(path.includes('salesOrder')){return {data:{id:'123',tranId:'SO123',entity:{id:'45',refName:'Acme'},orderStatus:{id:'A'},lastModifiedDate:'v1'}};}
  if(path.includes('customer')){return {data:{id:'45',companyName:'Acme',balance:120,creditLimit:100,currency:{id:'3',refName:'Canadian Dollar'},custentity4:{id:'2',refName:'Jason Pu'},custentity_credit_balance:999}};}
  return {data:{symbol:'CAD'}};
 },queryAll:async()=>[{id:123,tranid:'SO123'}],mutate:fn=>fn()});
 const result=await remote.read(123);assert.equal(result.balance,'120');assert.equal(result.currency,'CAD');assert.equal(result.ownerId,'2');
 await remote.approve(123);assert.deepEqual(requests.at(-1),{path:'/record/v1/salesOrder/123',method:'PATCH',body:{orderStatus:{id:'B'}}});
 assert.deepEqual(await remote.pending(),[{id:123,tranid:'SO123'}]);
});
test('native approval revalidates after waiting in the NetSuite mutation queue',async()=>{
 let writes=0,checks=0;
 const remote=createBossNetSuiteAdapter({rest:async()=>{writes++;},queryAll:async()=>[],mutate:fn=>fn()});
 await assert.rejects(()=>remote.approve(123,{beforeSend:async()=>{checks++;throw new Error('owner changed');}}),/owner changed/);
 assert.equal(checks,1);assert.equal(writes,0);
});
test('owner change inside the native mutation queue cancels acceptance without a remote write',async()=>{
 const h=setup({snapshots:[snap,{...snap,ownerId:'2'}]});
 h.remote.approve=async(_id,{beforeSend})=>{await beforeSend();h.calls.writes++;};
 await h.service.processCommand(h.command);assert.equal(h.calls.writes,0);assert.equal(h.calls.finished[0].outcome,'failed');
});
test('property: only an approved read-back finishes approval, with one write at most',async()=>{
 await fc.assert(fc.asyncProperty(fc.constantFrom('A','B','C','D','E','F','G','H'),async status=>{
  const {service,calls,command}=setup({snapshots:[snap,{...snap,status}]});await service.processCommand(command);
  const expected=['B','D','E','F','G'].includes(status)?'approved':status==='A'?'failed':'resolved';
  assert.equal(calls.finished[0].outcome,expected);assert.equal(calls.writes,1);
 }),{numRuns:100,seed:20261003});
});
