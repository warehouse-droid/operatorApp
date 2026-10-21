// User-authorized live endpoint test: SOB121951, Tony Tan, no email.
// Run through stdin in /app. No credentials are printed or saved.
import './src/config.js';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from './src/db.js';
import {writeAudit,logoutToken} from './src/auth-repository.js';
import {createBossApprovalNetSuite} from './src/netsuite.js';
const orderId=1036372,requestId=7,tranid='SOB121951';
const trigger='boss_test_sob121951_no_email',base='http://127.0.0.1:3000';
const submit=process.argv.includes('--submit');let token=null,guardCreated=false,responseKnown=false;
const active=async()=>Number((await query("SELECT count(*)::int AS count FROM boss_approval_commands WHERE request_id=$1 AND status IN ('queued','sending','uncertain')",[requestId])).rows[0].count);
async function audit(action,details){await writeAudit({actorType:'system',source:'assistant_maintenance',action,orderId,
 details:{tranid,requestId,test:true,automated:true,note:'TEST approval of SOB121951',authorizedAccount:'Tony Tan',emailRequested:false,...details}});}
async function cleanupGuard(){
 await withTransaction(async()=>{
  await query('SET LOCAL lock_timeout = \'5s\'');
  await query(`DROP TRIGGER IF EXISTS ${trigger} ON boss_approval_notifications`);
  await query(`DROP FUNCTION IF EXISTS ${trigger}()`);
 });
}
try{
 const request=(await query('SELECT id,order_id,status,revision,snapshot FROM boss_approval_requests WHERE id=$1',[requestId])).rows[0];
 assert.equal(Number(request?.order_id),orderId);assert.equal(request.snapshot.tranid,tranid);
 if(submit){
  assert.equal(request.status,'pending');assert.equal(await active(),0);
  const boss=(await query("SELECT p.operator_id,p.name,o.active,o.roles FROM boss_approval_principals p JOIN operators o ON o.id=p.operator_id WHERE p.key='tony_tan'")).rows[0];
  assert.equal(boss.name,'Tony Tan');assert(boss.active&&boss.roles.includes('boss'));
  const commandId=crypto.randomUUID();token=crypto.randomBytes(32).toString('base64url');
  const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
  await withTransaction(async()=>{
   await query('SET LOCAL lock_timeout = \'5s\'');
   // Hold only new notices for this request indefinitely, preserving in-app
   // visibility. They can never become due for the normal email worker.
   await query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
     IF EXISTS(SELECT 1 FROM boss_approval_events e WHERE e.id=NEW.event_id AND e.request_id=7) THEN
      NEW.available_at='infinity'::timestamptz;
      NEW.last_error='Email withheld: user-authorized automated test SOB121951; do not send.';
     END IF;
     RETURN NEW;
    END $$`);
   await query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON boss_approval_notifications FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
   // Administrative test session explicitly authorized for Tony Tan in chat.
   // Normal endpoint authentication and BOSS/owner/credit checks still apply.
   await query("INSERT INTO operator_sessions(token_hash,operator_id,expires_at) VALUES($1,$2,now()+interval '3 minutes')",[tokenHash,boss.operator_id]);
   await audit('boss.test_approval.requested',{commandId,effectiveOperatorId:boss.operator_id,sessionExpiresInSeconds:180});
  });guardCreated=true;
  const api=async(path,options={})=>{
   const response=await fetch(base+path,{...options,redirect:'error',signal:AbortSignal.timeout(45000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}});
   return {status:response.status,body:await response.json()};
  };
  const detail=await api('/api/boss/requests/'+requestId);assert.equal(detail.status,200);
  assert.equal(detail.body.orderId,orderId);assert.equal(detail.body.status,'pending');
  const body={action:'accept',expectedRevision:detail.body.revision,commandId};
  const result=await api('/api/boss/requests/'+requestId+'/decision',{method:'POST',body:JSON.stringify(body)});responseKnown=true;
  await audit('boss.test_approval.endpoint_result',{commandId,effectiveOperatorId:boss.operator_id,httpStatus:result.status,response:result.body});
  console.log(JSON.stringify({endpoint:'/api/boss/requests/7/decision',actor:'Tony Tan',test:true,emailRequested:false,commandId,...result}));
 }
 const current=await createBossApprovalNetSuite().read(orderId);
 const requestAfter=(await query('SELECT id,status,actor_name,completed_at,snapshot FROM boss_approval_requests WHERE id=$1',[requestId])).rows[0];
 const commands=(await query('SELECT id,status,last_error,remote_attempted_at FROM boss_approval_commands WHERE request_id=$1 ORDER BY created_at DESC',[requestId])).rows;
 const notices=(await query("SELECT e.kind,n.email_status,n.attempts,n.available_at::text,n.last_error FROM boss_approval_notifications n JOIN boss_approval_events e ON e.id=n.event_id WHERE e.request_id=$1 AND e.kind<>'requested' ORDER BY n.id",[requestId])).rows;
 console.log(JSON.stringify({order:{id:current.orderId,tranid:current.tranid,status:current.status},request:requestAfter,commands,decisionNotices:notices}));
 if(!submit&&await active()===0){await cleanupGuard();console.log(JSON.stringify({emailGuardRemoved:true}));}
}finally{
 if(token){await logoutToken(token);console.log(JSON.stringify({testSessionRevoked:true}));}
 if(guardCreated&&responseKnown&&await active()===0){await cleanupGuard();console.log(JSON.stringify({emailGuardRemoved:true}));}
 await closeDb();
}
