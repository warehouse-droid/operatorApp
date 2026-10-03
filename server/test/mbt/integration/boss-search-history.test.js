import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fc from 'fast-check';
import {query,closeDb} from '../../../src/db.js';
import {createOperator,listAudit,listAuditOptions} from '../../../src/auth-repository.js';
import {createBossRepository} from '../../../src/boss-approval-repository.js';
import {createBossApprovalService} from '../../../src/boss-approval-service.js';
import {normalizeSnapshot} from '../../../src/boss-approval-domain.js';
let repo;const people=[];
const snap=(id,extra={})=>({orderId:id,tranid:'SO-TRACE-'+id,status:'A',customerId:77,customerName:'Trace Customer',ownerId:null,
 creditLimit:'200000',balance:'14723.64',unbilledOrders:'37021.83',currency:'CAD',orderTotal:'54.10',orderVersion:'v1',refreshedAt:'2026-10-03T01:02:03.000Z',...extra});
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 await query('TRUNCATE boss_approval_notifications,boss_approval_events,boss_approval_commands,boss_approval_requests,boss_approval_sources RESTART IDENTITY');
 await query('UPDATE boss_approval_principals SET operator_id=NULL,owner_id=NULL');await query('UPDATE boss_approval_settings SET enabled=false,revision=1');
 repo=createBossRepository();
 for(const [i,key] of ['tony_tan','jason_pu','alex_huang'].entries()){
  const person=await createOperator({username:'search-history-'+crypto.randomUUID(),displayName:key,role:'boss',email:key+'@example.test',password:'test-password'});
  people.push({...person,key,ownerId:String(i+1)});
 }
 await repo.configure({revision:1,enabled:true,principals:people.map(p=>({key:p.key,operatorId:p.id,ownerId:p.ownerId}))},people[0].id);
});
after(closeDb);
async function ingest(id,extra={}){
 const s=snap(id,extra);await repo.observe({orderType:'sales_order',netsuiteOrderId:id,tranid:s.tranid,status:s.status});
 let job;do{job=await repo.claimSource();assert(job);if(Number(job.order_id)!==id){await repo.applySource(job,snap(Number(job.order_id),{status:'B'}));}}while(Number(job.order_id)!==id);
 return repo.applySource(job,s);
}
async function reject(request,person=people[1]){
 await repo.claimDecision(person,{requestId:request.id,expectedRevision:request.revision,commandId:crypto.randomUUID(),action:'reject'});
 const command=await repo.claimCommand();assert.equal(command.requestId,request.id);await repo.beginRemote(command);
 await repo.finishCommand(command,{outcome:'rejected',snapshot:{...request.snapshot,status:'H'}});
}
test('search from either tab combines authorized pending orders with every completed decision',async()=>{
 const shared=await ingest(970001),owned=await ingest(970002,{ownerId:'1'}),hidden=await ingest(970003,{ownerId:'2'});
 const history=await ingest(970004,{ownerId:'2'});await reject(history);
 const resolved=await ingest(970005);await ingest(970005,{status:'H'});
 const expected=[shared.id,owned.id,history.id,resolved.id].sort((a,b)=>a-b);
 for(const queue of ['pending','history']){
  const results=await repo.list(people[0],{queue,search:'tRaCe cUsT',status:'approved'});
  assert.deepEqual(results.requests.map(r=>r.id).sort((a,b)=>a-b),expected);assert(!results.requests.some(r=>r.id===hidden.id));
 }
 assert.equal((await repo.list(people[0],{queue:'pending',search:'970004'})).requests[0].id,history.id);
 assert((await repo.list(people[0],{queue:'history',search:'   '})).requests.every(r=>['approved','rejected','resolved'].includes(r.status)));
});
test('combined search paginates stably and treats SQL wildcard characters literally',async()=>{
 const expected=[];
 for(let i=0;i<34;i++){
  const r=await ingest(971000+i,{customerName:'Paged %_\\ customer'});expected.push(r.id);if(i%2){await reject(r,people[0]);}
 }
 const first=await repo.list(people[0],{queue:'pending',search:'%_\\'});assert.equal(first.requests.length,30);assert.equal(first.hasMore,true);
 const last=await repo.list(people[0],{queue:'history',search:'%_\\',offset:first.nextOffset});assert.equal(last.requests.length,4);assert.equal(last.hasMore,false);
 assert.deepEqual([...first.requests,...last.requests].map(r=>r.id).sort((a,b)=>a-b),expected);
 assert.equal((await repo.list(people[0],{search:"' OR true --"})).requests.length,0);
});
test('approval retains the reviewed snapshot through read-back, concurrent enrichment and later order cycles',async()=>{
 const id=972000,request=await ingest(id);const original=normalizeSnapshot(snap(id));
 let changed=false;
 const remote={read:async()=>changed?snap(id,{status:'B',customerName:'Changed after approval',creditLimit:'1',balance:'999',unbilledOrders:'300',currency:'USD',orderVersion:'v2'}):snap(id),approve:async()=>{changed=true;}};
 const service=createBossApprovalService({repo,remote});
 await service.decide(people[0],{requestId:request.id,expectedRevision:request.revision,commandId:crypto.randomUUID(),action:'accept'});
 const command=await repo.claimCommand();
 await ingest(id,{creditLimit:'2',balance:'12',unbilledOrders:'34',orderVersion:'v2'});
 await service.processCommand(command);
 for(const person of people){const completed=await repo.detail(person,request.id);assert.equal(completed.status,'approved');assert.deepEqual(completed.snapshot,original);assert.equal(completed.actorName,'Tony Tan');assert(completed.completedAt);}
 await ingest(id,{status:'B',balance:'888',unbilledOrders:'444'});await repo.refreshRequest(request.id,snap(id,{status:'B',creditLimit:'0'}));
 const again=await ingest(id,{orderVersion:'v3',balance:'111'});assert.notEqual(again.id,request.id);
 const completed=await repo.detail(people[2],request.id);assert.deepEqual(completed.snapshot,original);assert.deepEqual(completed.events.find(e=>e.kind==='approved').snapshot,original);
 const notices=(await repo.notifications(people[2])).notifications.filter(n=>n.requestId===request.id&&n.kind==='approved');assert.equal(notices.length,1);assert.deepEqual(notices[0].snapshot,original);
});
test('finalization uses the persisted command snapshot even if a worker object is mutated',async()=>{
 const request=await ingest(972001);await repo.claimDecision(people[0],{requestId:request.id,expectedRevision:request.revision,commandId:crypto.randomUUID(),action:'accept'});
 const command=await repo.claimCommand();const original=structuredClone(command.snapshot);
 // Simulate stale mutable request data; the durable decision command is the audit authority.
 await query("UPDATE boss_approval_requests SET snapshot=jsonb_set(snapshot,'{creditLimit}','\"1\"') WHERE id=$1",[request.id]);
 command.snapshot={...command.snapshot,creditLimit:'2'};
 await repo.finishCommand(command,{outcome:'approved',snapshot:snap(972001,{status:'B',creditLimit:'3'})});
 assert.deepEqual((await repo.detail(people[0],request.id)).snapshot,original);
});
test('Admin audit finds prior approval events with the immutable figures and saved approver identity',async()=>{
 const items=await listAudit({tranid:'SO-TRACE-972000',action:'boss.approval.approved'});assert.equal(items.length,1);
 const row=items[0];assert.equal(row.audit_stream,'boss_approval');assert.equal(row.display_name,'Tony Tan');assert.equal(row.details.snapshot.creditBalance,'148254.53');assert.equal(row.details.snapshot.currentOwed,'-51745.47');
 assert.equal(row.details.snapshot.unbilledOrders,'37021.83');assert.equal(row.details.snapshot.orderTotal,'54.1');assert.equal(row.tranid,'SO-TRACE-972000');
 await query("UPDATE operators SET display_name='Renamed account' WHERE id=$1",[people[0].id]);
 const after=await listAudit({tranid:'SO-TRACE-972000',actor:'Tony Tan',action:'boss.approval.approved',from:new Date(Date.now()-86400000).toISOString(),to:new Date(Date.now()+86400000).toISOString()});
 assert.equal(after.length,1);assert.equal(after[0].display_name,'Tony Tan');assert.deepEqual(after[0].details.snapshot,row.details.snapshot);
 const options=await listAuditOptions({tranid:'SO-TRACE-972000'});assert(options.actions.includes('boss.approval.approved'));assert(options.actors.includes('Tony Tan'));
});
test('property: combined search preserves visibility for varied ownership and literal customer text',async()=>{
 let example=0;
 await fc.assert(fc.asyncProperty(
  fc.array(fc.record({owner:fc.constantFrom(null,'1','2','3'),rejected:fc.boolean()}),{minLength:1,maxLength:12}),
  fc.array(fc.constantFrom('%','_','\\',"'",'A','z',' '),{minLength:1,maxLength:10}),
  async(records,letters)=>{
   const needle=`Property-${++example}:${letters.join('')}:end`,expected=[];
   for(const [i,row] of records.entries()){
    const request=await ingest(973000+example*20+i,{customerName:needle,ownerId:row.owner});
    if(row.rejected){await reject(request,row.owner?people[Number(row.owner)-1]:people[0]);}
    if(row.rejected||row.owner===null||row.owner==='1'){expected.push(request.id);}
   }
   for(const queue of ['pending','history']){
    const actual=await repo.list(people[0],{queue,search:needle.toLowerCase(),status:'approved'});
    assert.deepEqual(actual.requests.map(r=>r.id).sort((a,b)=>a-b),expected.sort((a,b)=>a-b));
   }
  }
 ),{seed:20261003,numRuns:20,endOnFailure:true});
});
