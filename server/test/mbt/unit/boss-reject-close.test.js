import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {createBossNetSuiteAdapter} from '../../../src/boss-approval-netsuite.js';
import {createBossApprovalService} from '../../../src/boss-approval-service.js';
import {createBossMailer} from '../../../src/boss-approval-mail.js';
import {snapshotFingerprint} from '../../../src/boss-approval-domain.js';
const snapshot={orderId:123,tranid:'SO123',status:'A',customerId:45,customerName:'Acme',ownerId:null,currency:'CAD',creditLimit:'100',balance:'120',unbilledOrders:'0',orderVersion:'v1'};
function serviceHarness({status='H',error=null,reconcile=false}={}){
 const calls={closed:0,approved:0,finished:[]};let reads=0;
 const command={id:'1',requestId:1,actorId:'tony',action:'reject',status:reconcile?'uncertain':'queued',remote_attempted_at:reconcile?new Date():null,snapshot,fingerprint:snapshotFingerprint(snapshot)};
 const repo={settings:async()=>({enabled:true}),accountActor:async()=>({id:'tony',active:true,roles:['boss']}),roster:async()=>[{key:'tony_tan',operatorId:'tony',active:true,roles:['boss'],ownerId:'1'}],beginRemote:async()=>true,finishCommand:async(_c,r)=>calls.finished.push(r)};
 const remote={read:async()=>{if(!reconcile&&reads++===0){return snapshot;}if(status instanceof Error){throw status;}return {...snapshot,status};},approve:async()=>{calls.approved++;},close:async()=>{calls.closed++;if(error){throw error;}}};
 return {calls,command,repo,remote,service:createBossApprovalService({repo,remote})};
}
const order=items=>({id:'123',tranId:'SO123',orderStatus:{id:'A'},lastModifiedDate:'v1',item:{items,totalResults:items.length}});
function adapterHarness(record,rows=[]){
 const calls=[];let queued=false;
 const adapter=createBossNetSuiteAdapter({rest:async(path,options={})=>{calls.push({path,...options,queued});if(options.method==='PATCH'){return {status:204};}if(record instanceof Error){throw record;}return {data:record};},queryAll:async sql=>{assert.match(sql,/type='SalesOrd'/);assert.match(sql,/id=123/);return rows;},mutate:async fn=>{queued=true;return fn();}});
 return {adapter,calls};
}
test('Reject sends close once and records rejected only after H readback',async()=>{
 const h=serviceHarness();await h.service.processCommand(h.command);assert.equal(h.calls.closed,1);assert.equal(h.calls.approved,0);assert.equal(h.calls.finished[0].outcome,'rejected');
});
test('property: rejecting any other status never claims closure or sends approval',async()=>{
 await fc.assert(fc.asyncProperty(fc.constantFrom('A','B','C','D','E','F','G','H'),async status=>{
  const h=serviceHarness({status});await h.service.processCommand(h.command);
  assert.equal(h.calls.closed,1);assert.equal(h.calls.approved,0);assert.equal(h.calls.finished[0].outcome,status==='H'?'rejected':status==='A'?'failed':'resolved');
  if(!['A','H'].includes(status)){assert.equal(h.calls.finished[0].external,true);}
 }),{numRuns:100,seed:20261003});
});
test('timeout reconciliation confirms closure without a second write',async()=>{
 const first=serviceHarness({status:'A',error:Error('timeout')});await first.service.processCommand(first.command);assert.equal(first.calls.closed,1);assert.equal(first.calls.finished[0].outcome,'uncertain');
 const next=serviceHarness({reconcile:true});await next.service.processCommand(next.command);assert.equal(next.calls.closed,0);assert.equal(next.calls.approved,0);assert.equal(next.calls.finished[0].outcome,'rejected');
});
test('failed or missing verification never publishes rejected; stale authority cancels close',async()=>{
 const lost=serviceHarness({status:Error('read lost')});await lost.service.processCommand(lost.command);assert.equal(lost.calls.closed,1);assert.equal(lost.calls.finished[0].outcome,'uncertain');
 const denied=serviceHarness({status:'A',error:Object.assign(Error('permission denied'),{status:403,netsuiteResponseReceived:true})});await denied.service.processCommand(denied.command);assert.equal(denied.calls.closed,1);assert.equal(denied.calls.finished[0].outcome,'failed');assert.match(denied.calls.finished[0].error,/not been closed/i);
 const revoked=serviceHarness();revoked.remote.close=async(_id,{beforeSend})=>{revoked.repo.accountActor=async()=>({id:'tony',active:false,roles:['boss']});await beforeSend();revoked.calls.closed++;};revoked.remote.read=async()=>snapshot;await revoked.service.processCommand(revoked.command);assert.equal(revoked.calls.closed,0);assert.equal(revoked.calls.approved,0);assert.equal(revoked.calls.finished[0].outcome,'failed');
});
test('native close uses exact expanded line IDs inside queue and checks before sending',async()=>{
 const h=adapterHarness(order([{line:2,isClosed:false},{line:9,isClosed:true},{line:41,isClosed:false}]));let checks=0;
 assert.equal(typeof h.adapter.close,'function');await h.adapter.close(123,{beforeSend:async()=>{checks++;assert.equal(h.calls.length,1);}});
 assert.equal(checks,1);assert.deepEqual(h.calls,[{path:'/record/v1/salesOrder/123?expandSubResources=true',queued:true},{path:'/record/v1/salesOrder/123',method:'PATCH',body:{item:{items:[{line:2,isClosed:true},{line:41,isClosed:true}]}},queued:true}]);
});
test('property: closure preserves arbitrary sparse line IDs with no extra fields',async()=>{
 await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.integer({min:1,max:100000}),{minLength:1,maxLength:30}),async ids=>{
  const h=adapterHarness(order(ids.map(line=>({line,isClosed:false}))));assert.equal(typeof h.adapter.close,'function');await h.adapter.close(123);
  assert.deepEqual(h.calls.at(-1).body,{item:{items:ids.map(line=>({line,isClosed:true}))}});
 }),{numRuns:100,seed:20261004});
});
test('invalid or truncated line evidence and changed order prevent a closure write',async()=>{
 const records=[order([]),order([{line:0,isClosed:false}]),order([{line:2,isClosed:false},{line:2,isClosed:false}]),order([{line:2}]),{...order([{line:2,isClosed:false}]),id:'999'},{...order([{line:2,isClosed:false}]),orderStatus:{id:'B'}},{...order([{line:2,isClosed:false}]),item:{items:[{line:2,isClosed:false}],totalResults:2}}];
 for(const record of records){const h=adapterHarness(record);assert.equal(typeof h.adapter.close,'function');await assert.rejects(()=>h.adapter.close(123),e=>e.bossNoWrite===true);assert.equal(h.calls.filter(c=>c.method==='PATCH').length,0);}
 const h=adapterHarness(order([{line:2,isClosed:false}]));assert.equal(typeof h.adapter.close,'function');await assert.rejects(()=>h.adapter.close(123,{beforeSend:async()=>{throw Error('owner changed');}}),/owner changed/);assert.equal(h.calls.filter(c=>c.method==='PATCH').length,0);
});
const locked=()=>Object.assign(Error('This record has been locked by a user defined workflow.'),{status:400,netsuiteErrorCodes:['USER_ERROR']});
test('workflow-locked closed records are verified by exact SalesOrd query evidence',async()=>{
 const h=adapterHarness(locked(),[{id:'123',tranid:'SO123',entity:'45',status:'H',lastmodifieddate:'v2'}]);
 const result=await h.adapter.read(123);assert.equal(result.orderId,123);assert.equal(result.status,'H');assert.equal(result.tranid,'SO123');assert.equal(result.creditLimit,null);
});
test('property: workflow lock fallback never fabricates closure for other statuses',async()=>{
 await fc.assert(fc.asyncProperty(fc.constantFrom('A','B','C','D','E','F','G','H'),async status=>{
  const h=adapterHarness(locked(),[{id:'123',tranid:'SO123',entity:'45',status}]);
  if(status==='H'){assert.equal((await h.adapter.read(123)).status,'H');}else{await assert.rejects(()=>h.adapter.read(123),/locked/);}
 }),{numRuns:100,seed:20261005});
});
test('closure email explicitly says closed and legacy rejection email is distinct',async()=>{
 const sent=[];const mailer=createBossMailer({env:{BOSS_SMTP_HOST:'fixture',BOSS_SMTP_USER:'fixture',BOSS_SMTP_PASSWORD:'fixture'},loadTransport:async()=>({sendMail:async input=>{sent.push(input);return {accepted:['boss@example.test']};}})});
 for(const kind of ['rejected_closed','rejected']){await mailer.send({id:1,email:'boss@example.test'},{kind,snapshot,actor_name:'Tony Tan'});}
 assert.match(sent[0].subject,/Rejected/);assert.match(sent[0].text,/closed in NetSuite/i);assert.doesNotMatch(sent[0].text,/remains Pending/);assert.match(sent[1].text,/remains Pending Approval/);
});

test('invalid fallback identities and unrelated read errors stay failed; stale version cannot close',async()=>{
 for(const rows of [[],[{id:'999',tranid:'SO999',entity:'45',status:'H'}],[{id:'123',status:'H'},{id:'123',status:'H'}]]){
  const h=adapterHarness(locked(),rows);await assert.rejects(()=>h.adapter.read(123));
 }
 const failed=adapterHarness(Error('offline'),[{id:'123',tranid:'SO123',entity:'45',status:'H'}]);await assert.rejects(()=>failed.adapter.read(123),/offline/);
 const stale=adapterHarness(order([{line:1,isClosed:false}]));assert.equal(typeof stale.adapter.close,'function');await assert.rejects(()=>stale.adapter.close(123,{expectedVersion:'v2'}),e=>e.bossNoWrite===true);assert.equal(stale.calls.filter(c=>c.method==='PATCH').length,0);
 const closed=adapterHarness(order([{line:1,isClosed:true}]));assert.equal(typeof closed.adapter.close,'function');await closed.adapter.close(123);assert.equal(closed.calls.filter(c=>c.method==='PATCH').length,0);
});
