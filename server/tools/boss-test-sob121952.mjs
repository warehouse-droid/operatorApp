// User-authorized operational test: SOB121952 -> Pending Approval -> application
// approval as Tony Tan. Hold ALL test emails before the first status change.
// Run through stdin in /app; no credentials are printed or persisted.
import './src/config.js';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {config} from './src/config.js';
import {query,withTransaction,closeDb} from './src/db.js';
import {writeAudit,logoutToken,listAudit} from './src/auth-repository.js';
import {createBossApprovalNetSuite} from './src/netsuite.js';
import {createBossRepository} from './src/boss-approval-repository.js';
import {getNetSuiteM2mAccessToken,isNetSuiteM2mActive} from './src/netsuite-m2m-runtime.js';
import {enqueueDelayedStatusRefresh} from './src/netsuite-delayed-status-refresh-repository.js';
const orderId=1036373,customerId=8444,tranid='SOB121952',guard='boss_test_sob121952_no_email';
const mode=process.argv.find(a=>['--pending','--approve','--verify','--inspect'].includes(a))||'--inspect';
let sessionToken=null;
const active=async()=>Number((await query("SELECT count(*)::int AS count FROM boss_approval_commands c JOIN boss_approval_requests r ON r.id=c.request_id WHERE r.order_id=$1 AND c.status IN ('queued','sending','uncertain')",[orderId])).rows[0].count);
const latest=async()=>(await query('SELECT * FROM boss_approval_requests WHERE order_id=$1 ORDER BY cycle DESC LIMIT 1',[orderId])).rows[0];
async function audit(action,details){await writeAudit({actorType:'system',source:'assistant_maintenance',action,orderId,
 details:{tranid,test:true,automated:true,note:'TEST approval of SOB121952',authorizedAccount:'Tony Tan',emailRequested:false,...details}});}
async function guardInstalled(){return Number((await query("SELECT count(*)::int AS count FROM pg_trigger WHERE tgname=$1 AND tgrelid='boss_approval_notifications'::regclass AND tgenabled='O'",[guard])).rows[0].count)===1;}
async function installGuard(){
 await withTransaction(async()=>{
  await query("SET LOCAL lock_timeout='5s'");
  if(!await guardInstalled()){
   await query(`CREATE FUNCTION ${guard}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF EXISTS(SELECT 1 FROM boss_approval_events e JOIN boss_approval_requests r ON r.id=e.request_id WHERE e.id=NEW.event_id AND r.order_id=1036373) THEN
     NEW.available_at='infinity'::timestamptz;
     NEW.last_error='Email withheld: user-authorized automated test SOB121952; do not send.';
    END IF; RETURN NEW; END $$`);
   await query(`CREATE TRIGGER ${guard} BEFORE INSERT ON boss_approval_notifications FOR EACH ROW EXECUTE FUNCTION ${guard}()`);
  }
  const sending=await query("SELECT n.id FROM boss_approval_notifications n JOIN boss_approval_events e ON e.id=n.event_id JOIN boss_approval_requests r ON r.id=e.request_id WHERE r.order_id=$1 AND n.email_status='sending'",[orderId]);
  assert.equal(sending.rows.length,0,'An email send is already in progress; stop.');
  await query("UPDATE boss_approval_notifications n SET available_at='infinity'::timestamptz,last_error='Email withheld: user-authorized automated test SOB121952; do not send.' FROM boss_approval_events e JOIN boss_approval_requests r ON r.id=e.request_id WHERE n.event_id=e.id AND r.order_id=$1 AND n.email_status='pending'",[orderId]);
 });
 assert(await guardInstalled());
}
async function readNative(){
 assert.equal(config.netsuite.directAccessEnabled,true);assert.equal(await isNetSuiteM2mActive(),true);
 const target=new URL(config.netsuite.restBaseUrl.replace(/\/$/,'')+'/record/v1/salesOrder/'+orderId);
 assert.equal(target.protocol,'https:');assert(target.hostname.endsWith('.suitetalk.api.netsuite.com'));assert.equal(target.pathname,'/services/rest/record/v1/salesOrder/1036373');
 const token=await getNetSuiteM2mAccessToken();
 const rest=async(method='GET',body)=>{
  const response=await fetch(target,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const text=await response.text();if(!response.ok){throw new Error('NetSuite REST '+response.status+': '+text.slice(0,2000));}
  return {status:response.status,data:text?JSON.parse(text):null};
 };
 const record=(await rest()).data;assert.equal(Number(record.id),orderId);assert.equal(record.tranId,tranid);assert.equal(Number(record.entity?.id),customerId);
 return {record,rest};
}
try{
 if(mode==='--pending'){
  assert.equal(await active(),0);const existing=await latest();assert(!existing||existing.status==='pending','An existing completed review must not be reset accidentally.');
  await installGuard();
  const {record:before,rest}=await readNative();assert(['A','B'].includes(before.orderStatus?.id));
  await audit('boss.test_approval.pending_requested',{beforeStatus:before.orderStatus.id,emailGuardInstalled:true});
  let patchStatus=null,patchError=null;
  if(before.orderStatus.id==='B'){
   try{patchStatus=(await rest('PATCH',{orderStatus:'A'})).status;}catch(error){patchError=error.message;}
  }
  const after=(await rest()).data;assert.equal(Number(after.id),orderId);assert.equal(after.tranId,tranid);
  await audit('boss.test_approval.pending_result',{beforeStatus:before.orderStatus.id,afterStatus:after.orderStatus?.id,patchStatus,patchError});
  console.log(JSON.stringify({stage:'reset',tranid,beforeStatus:before.orderStatus.id,afterStatus:after.orderStatus?.id,patchStatus,patchError,emailGuardInstalled:true}));
  assert.equal(after.orderStatus?.id,'A','NetSuite did not retain Pending Approval; stop without repeating PATCH.');
  const job=await enqueueDelayedStatusRefresh({orderType:'sales_order',netsuiteOrderId:orderId,tranid,availableAt:new Date(Date.now()+10000)});
  console.log(JSON.stringify({stage:'refreshQueued',jobId:job.jobId,status:job.status,availableAt:job.availableAt}));
 }
 if(mode==='--approve'){
  assert(await guardInstalled(),'Email suppression must be installed before approval.');assert.equal(await active(),0);
  const r=await latest();assert(r);assert.equal(r.status,'pending');assert.equal(r.snapshot.tranid,tranid);
  const source=(await query('SELECT observed_status,generation,enriched_generation FROM boss_approval_sources WHERE order_id=$1',[orderId])).rows[0];
  assert.equal(source.observed_status,'A');assert.equal(source.generation,source.enriched_generation);
  const boss=(await query("SELECT p.operator_id,p.name,o.active,o.roles FROM boss_approval_principals p JOIN operators o ON o.id=p.operator_id WHERE p.key='tony_tan'")).rows[0];
  assert.equal(boss.name,'Tony Tan');assert(boss.active&&boss.roles.includes('boss'));assert(r.recipients.includes(boss.operator_id));
  const commandId=crypto.randomUUID();sessionToken=crypto.randomBytes(32).toString('base64url');
  const hash=crypto.createHash('sha256').update(sessionToken).digest('hex');
  await withTransaction(async()=>{
   await query("INSERT INTO operator_sessions(token_hash,operator_id,expires_at) VALUES($1,$2,now()+interval '3 minutes')",[hash,boss.operator_id]);
   await audit('boss.test_approval.requested',{requestId:Number(r.id),commandId,effectiveOperatorId:boss.operator_id,sessionExpiresInSeconds:180});
  });
  const api=async(path,options={})=>{
   const response=await fetch('http://127.0.0.1:3000'+path,{...options,redirect:'error',signal:AbortSignal.timeout(45000),headers:{Authorization:'Bearer '+sessionToken,'Content-Type':'application/json'}});
   return {status:response.status,body:await response.json()};
  };
  const detail=await api('/api/boss/requests/'+r.id);assert.equal(detail.status,200);assert.equal(detail.body.orderId,orderId);assert.equal(detail.body.status,'pending');
  const result=await api('/api/boss/requests/'+r.id+'/decision',{method:'POST',body:JSON.stringify({action:'accept',expectedRevision:detail.body.revision,commandId})});
  await audit('boss.test_approval.endpoint_result',{requestId:Number(r.id),commandId,httpStatus:result.status,response:result.body});
  console.log(JSON.stringify({stage:'endpoint',path:'/api/boss/requests/'+r.id+'/decision',actor:'Tony Tan',test:true,emailRequested:false,commandId,...result}));
 }
 const current=await createBossApprovalNetSuite().read(orderId);assert.equal(current.tranid,tranid);assert.equal(current.customerId,customerId);
 const r=await latest();
 const commands=(await query('SELECT c.id,c.status,c.actor_name,c.last_error,c.remote_attempted_at,c.snapshot FROM boss_approval_commands c JOIN boss_approval_requests r ON r.id=c.request_id WHERE r.order_id=$1 ORDER BY c.created_at DESC',[orderId])).rows;
 const notices=(await query('SELECT e.kind,n.email_status,n.attempts,n.available_at::text,n.last_error FROM boss_approval_notifications n JOIN boss_approval_events e ON e.id=n.event_id JOIN boss_approval_requests r ON r.id=e.request_id WHERE r.order_id=$1 ORDER BY n.id',[orderId])).rows;
 console.log(JSON.stringify({stage:'readback',order:{id:current.orderId,tranid:current.tranid,status:current.status},request:r?{id:Number(r.id),status:r.status,revision:Number(r.revision),actor:r.actor_name,completedAt:r.completed_at,snapshot:r.snapshot}:null,commands:commands.map(({snapshot:_snapshot,...row})=>row),notices}));
 if(mode==='--verify'){
  assert.equal(current.status,'B');assert.equal(r.status,'approved');assert.equal(r.actor_name,'Tony Tan');
  assert.equal(commands.length,1);assert.equal(commands[0].status,'succeeded');assert.deepEqual(r.snapshot,commands[0].snapshot);
  assert.equal(notices.filter(n=>n.kind==='requested').length,3);assert.equal(notices.filter(n=>n.kind==='approved').length,3);
  assert(notices.every(n=>n.email_status==='pending'&&n.attempts===0&&n.available_at==='infinity'));
  const repo=createBossRepository(),inApp=[];
  for(const p of await repo.roster()){
   const actor={id:p.operatorId,roles:p.roles,active:p.active};const detail=await repo.detail(actor,r.id);assert.equal(detail.status,'approved');
   const result=await repo.notifications(actor);inApp.push({boss:p.name,approved:result.notifications.some(n=>n.requestId===Number(r.id)&&n.kind==='approved')});
  }
  assert(inApp.every(p=>p.approved));const audits=await listAudit({tranid,action:'boss.approval.approved'});assert.equal(audits.length,1);assert.deepEqual(audits[0].details.snapshot,r.snapshot);
  await audit('boss.test_approval.verified',{requestId:Number(r.id),commandId:commands[0].id,result:'approved',savedSnapshot:r.snapshot,emailsSent:0,heldEmailCount:notices.length,inAppRecipients:3});
  assert.equal(await active(),0);
  await withTransaction(async()=>{
   await query("SET LOCAL lock_timeout='5s'");await query(`DROP TRIGGER ${guard} ON boss_approval_notifications`);await query(`DROP FUNCTION ${guard}()`);
  });
  assert.equal(await guardInstalled(),false);
  console.log(JSON.stringify({verified:true,snapshotVerified:true,auditVerified:true,inApp,emailsSent:0,heldEmailCount:notices.length,temporaryGuardRemoved:true}));
 }
}finally{
 if(sessionToken){await logoutToken(sessionToken);console.log(JSON.stringify({testSessionRevoked:true}));}
 await closeDb();
}
