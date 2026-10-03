import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,withTransaction,closeDb} from '../../../src/db.js';
import {createOperator,updateOperatorEmail,getOperatorByToken,loginOperator,listAudit} from '../../../src/auth-repository.js';
import {createBossRepository} from '../../../src/boss-approval-repository.js';
import {createBossApprovalService} from '../../../src/boss-approval-service.js';
import {createBossApprovalRuntime} from '../../../src/boss-approval-runtime.js';
import {createDelayedStatusRefreshWorker} from '../../../src/netsuite-delayed-status-refresh-service.js';

let repo,people;
const snapshot=(orderId,patch={})=>({orderId,tranid:`SO${orderId}`,status:'A',customerId:77,customerName:'ABC Construction',ownerId:null,currency:'CAD',creditLimit:'100000',balance:'105000',unbilledOrders:'0',orderVersion:'v1',...patch});
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  await query("TRUNCATE boss_approval_notifications,boss_approval_events,boss_approval_commands,boss_approval_requests,boss_approval_sources RESTART IDENTITY");
  await query("UPDATE boss_approval_principals SET operator_id=NULL,owner_id=NULL");
  await query("UPDATE boss_approval_settings SET revision=1,enabled=false");
  repo=createBossRepository();
  people=[];
  for(const [index,name] of ['tony_tan','jason_pu','alex_huang'].entries()){
    const person=await createOperator({username:`boss-test-${name}-${crypto.randomUUID()}`,displayName:name,role:'boss',email:`${name}@example.test`,password:crypto.randomUUID()});
    people.push({...person,ownerId:String(index+1),key:name});
  }
  await repo.configure({revision:1,enabled:true,principals:people.map(p=>({key:p.key,operatorId:p.id,ownerId:p.ownerId}))},people[0].id);
});
after(async()=>{await closeDb();});
async function ingest(orderId,patch={}){
  await withTransaction(()=>repo.observe({orderType:'sales_order',netsuiteOrderId:orderId,tranid:`SO${orderId}`,status:'A'}));
  const job=await repo.claimSource();assert(job);
  return repo.applySource(job,snapshot(orderId,patch));
}
async function completeRejection(r){
  const service=createBossApprovalService({repo,remote:{read:async()=>snapshot(r.orderId,{status:'H'}),close:async()=>{throw Error('reconciliation must not write');}}});
  const command=await repo.claimCommand();assert.equal(command.requestId,r.id);assert.equal(await repo.beginRemote(command),true);
  await service.processCommand({...command,remote_attempted_at:new Date()});
  await repo.applySource(await repo.claimSource(),snapshot(r.orderId,{status:'H'}));
}
test('email is persisted, returned on login and can be edited',async()=>{
  const user=await createOperator({username:`boss-email-${crypto.randomUUID()}`,password:'test-account-password',email:' TEST@Example.COM '});
  assert.equal(user.email,'test@example.com');
  await updateOperatorEmail(user.id,'changed@example.com');
  const login=await loginOperator(user.username,'test-account-password');
  assert.equal((await getOperatorByToken(login.token)).email,'changed@example.com');
  await assert.rejects(()=>updateOperatorEmail(user.id,'invalid'),e=>e.status===400);
});
test('successful SO observations only; duplicates share one request; transaction rollback publishes nothing',async()=>{
  await repo.observe({orderType:'purchase_order',netsuiteOrderId:900001,status:'A',tranid:'PO'});
  assert.equal(await repo.claimSource(),null);
  await assert.rejects(()=>withTransaction(async()=>{await repo.observe({orderType:'sales_order',netsuiteOrderId:900002,status:'A',tranid:'SO'});throw Error('rollback');}),/rollback/);
  assert.equal(await repo.claimSource(),null);
  const first=await ingest(900003);
  const again=await ingest(900003);
  assert.equal(first.id,again.id);
  assert.equal((await query('SELECT count(*)::int AS n FROM boss_approval_events WHERE request_id=$1 AND kind=\'requested\'',[first.id])).rows[0].n,1);
});
test('orders that never needed approval do not create financial-enrichment work',async()=>{
  await repo.observe({orderType:'sales_order',netsuiteOrderId:900030,tranid:'SO900030',status:'B'});
  assert.equal((await query('SELECT count(*)::int AS n FROM boss_approval_sources WHERE order_id=900030')).rows[0].n,0);
});
test('stale confirmations refresh amounts and owner access, external approval becomes shared history',async()=>{
  const r=await ingest(900031,{ownerId:'1'});
  await repo.refreshRequest(r.id,snapshot(900031,{ownerId:'2',balance:'130000'}));
  await assert.rejects(()=>repo.detail(people[0],r.id),e=>e.status===403);
  const changed=await repo.detail(people[1],r.id);assert.equal(changed.snapshot.balance,'130000');assert(changed.revision>r.revision);
  assert((await repo.notifications(people[1])).notifications.some(n=>n.requestId===r.id&&n.kind==='requested'));
  await repo.refreshRequest(r.id,snapshot(900031,{status:'B'}));
  assert.equal((await repo.detail(people[2],r.id)).status,'approved');
  const external=await ingest(900032);
  await ingest(900032,{status:'H'});assert.equal((await repo.detail(people[0],external.id)).status,'resolved');
});
test('financial enrichment failures are retried without publishing incomplete requests',async()=>{
  await repo.observe({orderType:'sales_order',netsuiteOrderId:900033,tranid:'SO900033',status:'A'});
  const job=await repo.claimSource();await repo.failSource(job,new Error('customer read failed'));
  assert((await repo.health()).sources.some(s=>s.last_error==='customer read failed'));
  assert.equal((await query('SELECT count(*)::int AS n FROM boss_approval_requests WHERE order_id=900033')).rows[0].n,0);
  await query('UPDATE boss_approval_sources SET available_at=now() WHERE order_id=900033');
  assert(await repo.applySource(await repo.claimSource(),snapshot(900033)));
});
test('durable notification delivery reads the current account address and records success',async()=>{
  const r=await ingest(900034,{ownerId:'1'});
  const notice=(await repo.notifications(people[0])).notifications.find(n=>n.requestId===r.id);
  const job=(await query("UPDATE boss_approval_notifications SET email_status='sending',lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes' WHERE id=$1 RETURNING *",[notice.id])).rows[0];
  await updateOperatorEmail(people[0].id,'updated.tony@example.test');let mail;
  const runtime=createBossApprovalRuntime({repo,service:{},remote:{},enqueue:async()=>{},mailer:{send:async(j,event)=>{mail={j,event};},readiness:()=>({configured:true})}});
  await runtime.sendEmail(job);assert.equal(mail.j.email,'updated.tony@example.test');assert.equal(Number(mail.event.request_id),r.id);
  assert.equal((await query('SELECT email_status FROM boss_approval_notifications WHERE id=$1',[notice.id])).rows[0].email_status,'sent');
});
test('owner-only visibility is enforced by list, detail, and decision APIs',async()=>{
  const r=await ingest(900004,{ownerId:'2'});
  assert((await repo.list(people[1],{})).requests.some(x=>x.id===r.id));
  assert(!(await repo.list(people[0],{})).requests.some(x=>x.id===r.id));
  await assert.rejects(()=>repo.detail(people[0],r.id),e=>e.status===403);
  await assert.rejects(()=>repo.claimDecision(people[0],{requestId:r.id,expectedRevision:r.revision,commandId:crypto.randomUUID(),action:'reject'}),e=>e.status===403);
  await assert.rejects(()=>repo.list({...people[0],roles:['admin'],role:'admin'},{}),e=>e.status===403);
});
test('first shared decision wins, rejection waits for confirmed closure, all three receive history and notices',async()=>{
  const r=await ingest(900005);
  const results=await Promise.allSettled(people.slice(0,2).map(p=>repo.claimDecision(p,{requestId:r.id,expectedRevision:r.revision,commandId:crypto.randomUUID(),action:'reject'})));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.filter(x=>x.status==='rejected'&&x.reason.status===409).length,1);
  assert.equal((await repo.detail(people[0],r.id)).status,'processing');
  assert.equal((await query("SELECT count(*)::int AS n FROM boss_approval_events WHERE request_id=$1 AND kind='rejected_closed'",[r.id])).rows[0].n,0);
  await completeRejection(r);
  const done=await repo.detail(people[2],r.id);assert.equal(done.status,'rejected');assert.equal(done.closedInNetSuite,true);assert.deepEqual(done.snapshot,r.snapshot);
  const repeated=await ingest(900005,{status:'H',orderVersion:'v2'});assert.equal(repeated.id,r.id);assert.equal(repeated.status,'rejected');
  for(const p of people){const notices=await repo.notifications(p);assert(notices.notifications.some(n=>n.requestId===r.id&&n.kind==='rejected_closed'));assert((await repo.list(p,{queue:'history'})).requests.some(x=>x.id===r.id));}
});
test('idempotent decision replay returns the same result; a different actor cannot reuse its key',async()=>{
  const r=await ingest(900006);const input={requestId:r.id,expectedRevision:r.revision,commandId:crypto.randomUUID(),action:'reject'};
  const first=await repo.claimDecision(people[0],input);const again=await repo.claimDecision(people[0],input);assert.equal(first.id,again.id);
  await assert.rejects(()=>repo.claimDecision(people[1],input),e=>e.status===409);
  await completeRejection(r);assert.equal((await repo.claimDecision(people[0],input)).status,'succeeded');
});
test('reassigned pending notifications are hidden from the previous owner',async()=>{
  const r=await ingest(900010,{ownerId:'1'});
  assert((await repo.notifications(people[0])).notifications.some(n=>n.requestId===r.id));
  await ingest(900010,{ownerId:'2'});
  assert(!(await repo.notifications(people[0])).notifications.some(n=>n.requestId===r.id));
  assert((await repo.notifications(people[1])).notifications.some(n=>n.requestId===r.id));
});
test('verified departure and reentry creates a new cycle after rejection',async()=>{
  const r=await ingest(900011);
  await repo.claimDecision(people[0],{requestId:r.id,expectedRevision:r.revision,commandId:crypto.randomUUID(),action:'reject'});
  await completeRejection(r);
  await ingest(900011,{status:'H'});
  const renewed=await ingest(900011,{orderVersion:'v2'});
  assert.notEqual(renewed.id,r.id);assert.equal(renewed.status,'pending');assert.equal(renewed.cycle,2);
});
test('expired source lease cannot publish a request',async()=>{
  await repo.observe({orderType:'sales_order',netsuiteOrderId:900012,tranid:'SO900012',status:'A'});
  const job=await repo.claimSource();await query("UPDATE boss_approval_sources SET lease_until=now()-interval '1 minute' WHERE order_id=$1",[job.order_id]);
  assert.equal(await repo.applySource(job,snapshot(900012)),null);
  const replacement=await repo.claimSource();assert(await repo.applySource(replacement,snapshot(900012)));
});
test('acceptance command survives a lost response and is reconciled without another write',async()=>{
  const r=await ingest(900020);let status='A',writes=0;
  const service=createBossApprovalService({repo,remote:{read:async()=>snapshot(900020,{status}),approve:async()=>{writes++;status='B';throw new Error('response lost');}}});
  const input={requestId:r.id,expectedRevision:r.revision,commandId:crypto.randomUUID(),action:'accept'};
  const claimed=await service.decide(people[0],input);assert.equal(claimed.status,'queued');
  assert.equal((await repo.detail(people[0],r.id)).status,'processing');
  const command=await repo.claimCommand();assert(command);await service.processCommand(command);
  assert.equal((await repo.detail(people[1],r.id)).status,'approved');assert.equal(writes,1);
  assert.equal((await service.decide(people[0],input)).status,'succeeded');
  for(const person of people){assert((await repo.notifications(person)).notifications.some(n=>n.requestId===r.id&&n.kind==='approved'));}
  // Drain the enrichment requested by the confirmed native result.
  await repo.applySource(await repo.claimSource(),snapshot(900020,{status:'B'}));
});
test('uncertain rejection waits without notices, then preserves its audited figures after closed readback',async()=>{
  const r=await ingest(900040);let status='A',writes=0;
  const service=createBossApprovalService({repo,remote:{read:async()=>snapshot(900040,{status}),close:async(_id,{beforeSend})=>{await beforeSend();writes++;throw Error('response lost');}}});
  const input={requestId:r.id,expectedRevision:r.revision,commandId:crypto.randomUUID(),action:'reject'};
  const claimed=await service.decide(people[0],input);assert.equal(claimed.status,'queued');
  await service.processCommand(await repo.claimCommand());assert.equal(writes,1);
  assert.equal((await repo.detail(people[0],r.id)).status,'processing');
  assert.equal((await query("SELECT count(*)::int AS n FROM boss_approval_events WHERE request_id=$1 AND kind='rejected_closed'",[r.id])).rows[0].n,0);
  assert.equal(await repo.claimCommand(),null);
  const durable=(await query('SELECT snapshot,available_at>now() AS deferred FROM boss_approval_commands WHERE id=$1',[claimed.id])).rows[0];assert(durable.deferred);
  await query('UPDATE boss_approval_commands SET available_at=now() WHERE id=$1',[claimed.id]);status='H';
  const retry=await repo.claimCommand();retry.snapshot.creditLimit='1';await service.processCommand(retry);assert.equal(writes,1);
  for(const person of people){
    const detail=await repo.detail(person,r.id);assert.equal(detail.status,'rejected');assert.equal(detail.closedInNetSuite,true);assert.deepEqual(detail.snapshot,durable.snapshot);
    const notices=(await repo.notifications(person)).notifications.filter(n=>n.requestId===r.id&&n.kind==='rejected_closed');assert.equal(notices.length,1);assert.deepEqual(notices[0].snapshot,durable.snapshot);
  }
  assert.equal((await service.decide(people[0],input)).status,'succeeded');
  const audit=await listAudit({tranid:'SO900040',action:'boss.approval.rejected_closed'});assert.equal(audit.length,1);assert.equal(audit[0].display_name,'Tony Tan');assert.deepEqual(audit[0].details.snapshot,durable.snapshot);
  await repo.applySource(await repo.claimSource(),snapshot(900040,{status:'H',creditLimit:'900'}));assert.deepEqual((await repo.detail(people[2],r.id)).snapshot,durable.snapshot);
});
test('expired command lease becomes uncertain, stale worker cannot finalize it',async()=>{
  const r=await ingest(900021);
  await repo.claimDecision(people[0],{requestId:r.id,expectedRevision:r.revision,commandId:crypto.randomUUID(),action:'accept'});
  const first=await repo.claimCommand();assert.equal(await repo.beginRemote(first),true);
  await query("UPDATE boss_approval_commands SET lease_until=now()-interval '1 minute' WHERE id=$1",[first.id]);
  const next=await repo.claimCommand();assert.equal(next.status,'uncertain');
  assert.equal(await repo.finishCommand(first,{outcome:'approved'}),false);
  await repo.finishCommand(next,{outcome:'failed',error:'fixture recovery'});
  assert.equal((await repo.detail(people[0],r.id)).status,'pending');
  await repo.applySource(await repo.claimSource(),snapshot(900021));
});
test('observation and delayed refresh roll back together if the observation transaction fails',async()=>{
  const id=900022;
  const worker=createDelayedStatusRefreshWorker({claimJobs:async()=>[],lockLease:async()=>true,finishAttempt:async()=>true,
    fetchTransactionStatus:async()=>({tranid:'SO900022',status:'A'}),fetchSalesOrderLines:async()=>[],applyStatus:async()=>null,
    applySalesOrderLines:async()=>{},withTransaction,writeAudit:async()=>{},emitEvents:()=>{},logger:{error(){}},
    onStatusObserved:async input=>{await repo.observe(input);throw new Error('forced rollback after observation');}});
  await worker.processJob({jobId:333,orderType:'sales_order',netsuiteOrderId:id,tranid:'SO900022',attemptNumber:1,leaseToken:crypto.randomUUID()});
  assert.equal((await query('SELECT count(*)::int AS n FROM boss_approval_sources WHERE order_id=$1',[id])).rows[0].n,0);
});
test('email leases prevent concurrent sends, read receipts are scoped, and migration can roll back',async()=>{
  const [first,second]=await Promise.all([repo.claimEmail(),repo.claimEmail()]);assert(first);assert(second);assert.notEqual(first.id,second.id);
  await repo.finishEmail(first,'pending','temporary');
  assert.equal((await query('SELECT email_status FROM boss_approval_notifications WHERE id=$1',[first.id])).rows[0].email_status,'pending');
  await query("UPDATE boss_approval_notifications SET lease_until=now()-interval '1 minute' WHERE id=$1",[second.id]);
  await repo.claimEmail();
  await repo.finishEmail(second,'sent');
  assert.equal((await query('SELECT email_status FROM boss_approval_notifications WHERE id=$1',[second.id])).rows[0].email_status,'uncertain');
  const notice=(await repo.notifications(people[0])).notifications.find(n=>!n.readAt);
  await repo.markRead(people[1],notice.id);
  assert.equal((await query('SELECT read_at FROM boss_approval_notifications WHERE id=$1',[notice.id])).rows[0].read_at,null);
  await repo.markRead(people[0],notice.id);assert((await query('SELECT read_at FROM boss_approval_notifications WHERE id=$1',[notice.id])).rows[0].read_at);
  const {readFile}=await import('node:fs/promises');
  await assert.rejects(()=>withTransaction(async()=>{await query(await readFile('migrations/261_boss_approvals.sql','utf8'));throw new Error('rollback migration');}),/rollback migration/);
  assert.equal((await repo.settings()).enabled,true);
});
test('stale source worker cannot override the newer generation',async()=>{
  await repo.observe({orderType:'sales_order',netsuiteOrderId:900007,tranid:'SOT900007',status:'A'});
  const job=await repo.claimSource();await repo.observe({orderType:'sales_order',netsuiteOrderId:900007,tranid:'SOT900007',status:'B'});
  assert.equal(await repo.applySource(job,snapshot(900007)),null);
});
