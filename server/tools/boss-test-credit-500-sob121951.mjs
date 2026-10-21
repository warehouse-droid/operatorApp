// User's final instruction: CAD 500 for customer 8444, for test SOB121951.
// Run through stdin in /app with --set. Leaves the test email guard in place
// until the application approval attempt has finished and been verified.
import assert from 'node:assert/strict';
import {config} from './src/config.js';
import {query,withTransaction,closeDb} from './src/db.js';
import {writeAudit} from './src/auth-repository.js';
import {createBossApprovalNetSuite} from './src/netsuite.js';
import {getNetSuiteM2mAccessToken,isNetSuiteM2mActive} from './src/netsuite-m2m-runtime.js';
import {enqueueDelayedStatusRefresh} from './src/netsuite-delayed-status-refresh-repository.js';
const orderId=1036372,customerId=8444,requestId=7,creditLimit=500;
const guard='boss_test_sob121951_credit_no_email';
try{
 assert(process.argv.includes('--set'),'Explicit --set is required.');
 const snapshot=await createBossApprovalNetSuite().read(orderId);
 assert.equal(snapshot.tranid,'SOB121951');assert.equal(snapshot.customerId,customerId);assert.equal(snapshot.currency,'CAD');assert.equal(snapshot.status,'A');
 const request=(await query('SELECT status,order_id FROM boss_approval_requests WHERE id=$1',[requestId])).rows[0];
 assert.equal(Number(request.order_id),orderId);assert.equal(request.status,'pending');
 assert.equal(Number((await query("SELECT count(*)::int AS count FROM boss_approval_commands WHERE request_id=$1 AND status IN ('queued','sending','uncertain')",[requestId])).rows[0].count),0);
 assert.equal(config.netsuite.directAccessEnabled,true);assert.equal(await isNetSuiteM2mActive(),true);
 const target=new URL(config.netsuite.restBaseUrl.replace(/\/$/,'')+'/record/v1/customer/'+customerId);
 assert.equal(target.protocol,'https:');assert(target.hostname.endsWith('.suitetalk.api.netsuite.com'));assert.equal(target.pathname,'/services/rest/record/v1/customer/8444');
 const token=await getNetSuiteM2mAccessToken();
 const rest=async(method='GET',body)=>{
  const response=await fetch(target,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const text=await response.text();if(!response.ok){throw new Error('NetSuite REST '+response.status+': '+text.slice(0,2000));}
  return {status:response.status,data:text?JSON.parse(text):null};
 };
 const before=(await rest()).data;assert.equal(Number(before.id),customerId);assert.equal(before.companyName,'Vendor Sample ( Internal Use Only )');
 await withTransaction(async()=>{
  await query("SET LOCAL lock_timeout='5s'");
  await query(`CREATE FUNCTION ${guard}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF EXISTS(SELECT 1 FROM boss_approval_events e WHERE e.id=NEW.event_id AND e.request_id=7) THEN
    NEW.available_at='infinity'::timestamptz;
    NEW.last_error='Email withheld: user-authorized automated test SOB121951; do not send.';
   END IF; RETURN NEW; END $$`);
  await query(`CREATE TRIGGER ${guard} BEFORE INSERT ON boss_approval_notifications FOR EACH ROW EXECUTE FUNCTION ${guard}()`);
  await writeAudit({actorType:'system',source:'assistant_maintenance',action:'boss.test_approval.credit_limit_requested',orderId,
   details:{test:true,automated:true,tranid:'SOB121951',customerId,creditLimit,currency:'CAD',emailRequested:false,authorization:'Final user instruction: 500'}});
 });
 console.log(JSON.stringify({before:{customerId,customerName:before.companyName,creditLimit:before.creditLimit??null,currency:'CAD'},requestedCreditLimit:creditLimit,emailGuardInstalled:true}));
 let patchStatus=null,patchError=null;
 if(Number(before.creditLimit)!==creditLimit){
  try{patchStatus=(await rest('PATCH',{creditLimit})).status;}catch(error){patchError=error.message;}
 }
 const after=(await rest()).data;assert.equal(Number(after.id),customerId);
 await writeAudit({actorType:'system',source:'assistant_maintenance',action:'boss.test_approval.credit_limit_result',orderId,
  details:{test:true,automated:true,tranid:'SOB121951',customerId,beforeCreditLimit:before.creditLimit??null,afterCreditLimit:after.creditLimit??null,currency:'CAD',patchStatus,patchError,emailRequested:false}});
 console.log(JSON.stringify({patchStatus,patchError,afterCreditLimit:after.creditLimit??null}));
 assert.equal(Number(after.creditLimit),creditLimit,'Credit limit did not persist; do not retry blindly.');
 const job=await enqueueDelayedStatusRefresh({orderType:'sales_order',netsuiteOrderId:orderId,tranid:'SOB121951',availableAt:new Date(Date.now()+10000)});
 console.log(JSON.stringify({creditLimitConfirmed:true,refreshJob:{id:job.jobId,status:job.status,availableAt:job.availableAt}}));
}finally{await closeDb();}
