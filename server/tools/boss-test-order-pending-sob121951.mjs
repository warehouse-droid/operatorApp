// One-time, user-authorized test-order reset. Run through stdin in /app.
// Only --apply can write, only order 1036372 / SOB121951, and never retry PATCH.
import assert from 'node:assert/strict';
import {config} from './src/config.js';
import {query,closeDb} from './src/db.js';
import {getNetSuiteM2mAccessToken,isNetSuiteM2mActive} from './src/netsuite-m2m-runtime.js';
import {enqueueDelayedStatusRefresh} from './src/netsuite-delayed-status-refresh-repository.js';
import {writeAudit} from './src/auth-repository.js';
const orderId=1036372,tranid='SOB121951',apply=process.argv.includes('--apply');
const target=new URL(config.netsuite.restBaseUrl.replace(/\/$/,'')+'/record/v1/salesOrder/'+orderId);
const summary=order=>({id:Number(order.id),tranid:order.tranId,status:order.orderStatus?.id,statusName:order.orderStatus?.refName,lastModifiedDate:order.lastModifiedDate});
try{
 assert.equal(config.netsuite.directAccessEnabled,true);
 assert.equal(target.protocol,'https:');assert(target.hostname.endsWith('.suitetalk.api.netsuite.com'));
 assert.equal(target.pathname,'/services/rest/record/v1/salesOrder/1036372');assert.equal(await isNetSuiteM2mActive(),true);
 const token=await getNetSuiteM2mAccessToken();
 const request=async(method='GET',body)=>{
  const response=await fetch(target,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const text=await response.text();if(!response.ok){throw new Error('NetSuite REST '+response.status+': '+text.slice(0,2000));}
  return {status:response.status,data:text?JSON.parse(text):null};
 };
 const before=(await request()).data;
 assert.equal(Number(before.id),orderId);assert.equal(before.tranId,tranid);assert.equal(Number(before.entity?.id),8444);
 console.log(JSON.stringify({mode:apply?'apply':'check',before:summary(before)}));
 if(apply){
  assert(['A','B'].includes(before.orderStatus?.id),'Order is no longer Pending Approval/Pending Fulfillment; stop.');
  const active=await query("SELECT count(*)::int AS count FROM boss_approval_commands c JOIN boss_approval_requests r ON r.id=c.request_id WHERE r.order_id=$1 AND c.status IN ('queued','sending','uncertain')",[orderId]);
  assert.equal(active.rows[0].count,0,'An approval is in progress; stop.');
  let patchStatus=null,patchError=null;
  if(before.orderStatus.id==='B'){
   try{patchStatus=(await request('PATCH',{orderStatus:'A'})).status;}
   catch(error){patchError=error.message;}
  }
  console.log(JSON.stringify({patchStatus,patchError}));
  const after=(await request()).data;
  assert.equal(Number(after.id),orderId);assert.equal(after.tranId,tranid);
  await writeAudit({actorType:'system',source:'assistant_maintenance',action:'boss.test_order.reset_pending_approval',orderId,
   details:{tranid,authorization:'User requested direct REST reset of this test order',before:summary(before),after:summary(after),patchStatus,patchError}});
  const job=await enqueueDelayedStatusRefresh({orderType:'sales_order',netsuiteOrderId:orderId,tranid,availableAt:new Date(Date.now()+10000)});
  console.log(JSON.stringify({after:summary(after),refreshJob:{id:job.jobId,status:job.status,availableAt:job.availableAt},pendingConfirmed:after.orderStatus?.id==='A'}));
  if(after.orderStatus?.id!=='A'){process.exitCode=2;}
 }
 const requests=(await query('SELECT id,status,cycle,recipients,created_at FROM boss_approval_requests WHERE order_id=$1 ORDER BY cycle DESC',[orderId])).rows;
 const refresh=(await query("SELECT id,status,attempt_count,last_error,last_result,available_at,updated_at FROM netsuite_delayed_status_refresh_jobs WHERE order_type='sales_order' AND netsuite_order_id=$1 ORDER BY id DESC LIMIT 1",[orderId])).rows;
 const source=(await query('SELECT observed_status,observed_at,generation,enriched_generation,last_error FROM boss_approval_sources WHERE order_id=$1',[orderId])).rows;
 const notices=(await query('SELECT e.kind,n.email_status,count(*)::int AS count FROM boss_approval_notifications n JOIN boss_approval_events e ON e.id=n.event_id JOIN boss_approval_requests r ON r.id=e.request_id WHERE r.order_id=$1 GROUP BY e.kind,n.email_status',[orderId])).rows;
 console.log(JSON.stringify({requests,refresh,source,notices}));
}finally{await closeDb();}
