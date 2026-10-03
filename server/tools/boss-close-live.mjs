// Read-only deployed adapter/history/email checks; --refresh only queues the
// normal ten-second status refresh for the two already-closed test orders.
import './src/config.js';
import assert from 'node:assert/strict';
import {query,closeDb} from './src/db.js';
import {createBossApprovalNetSuite} from './src/netsuite.js';
import {enqueueDelayedStatusRefresh} from './src/netsuite-delayed-status-refresh-repository.js';
const refresh=process.argv.includes('--refresh');
try{
 const remote=createBossApprovalNetSuite(),results=[];
 for(const [orderId,tranid] of [[1036373,'SOB121952'],[1036372,'SOB121951']]){
  const actual=await remote.read(orderId);assert.equal(actual.status,'H');assert.equal(actual.tranid,tranid);assert.equal(actual.customerId,8444);
  const history=(await query('SELECT r.id,r.status,r.snapshot,c.snapshot AS reviewed FROM boss_approval_requests r JOIN boss_approval_commands c ON c.request_id=r.id WHERE r.order_id=$1 AND c.status=$2',[orderId,'succeeded'])).rows;
  assert.equal(history.length,1);assert.equal(history[0].status,'approved');assert.deepEqual(history[0].snapshot,history[0].reviewed);
  const emails=(await query('SELECT e.kind,n.email_status,n.attempts,n.available_at::text FROM boss_approval_notifications n JOIN boss_approval_events e ON e.id=n.event_id JOIN boss_approval_requests r ON r.id=e.request_id WHERE r.order_id=$1',[orderId])).rows;
  assert.equal(emails.length,6);assert(emails.every(n=>n.email_status==='pending'&&n.attempts===0&&n.available_at==='infinity'||orderId===1036372&&n.kind==='requested'&&n.email_status==='sent'));
  const source=(await query('SELECT observed_status,phase,generation,enriched_generation,last_error FROM boss_approval_sources WHERE order_id=$1',[orderId])).rows[0];assert.equal(source.observed_status,'H');
  if(refresh){
   const job=await enqueueDelayedStatusRefresh({orderType:'sales_order',netsuiteOrderId:orderId,tranid,availableAt:new Date(Date.now()+10000)});
   results.push({tranid,status:actual.status,historyPreserved:true,noTestEmails:true,refreshJobId:job.jobId,availableAt:job.availableAt});
  }else{
   assert.equal(source.phase,'H');assert.equal(source.generation,source.enriched_generation);assert.equal(source.last_error,'');
   results.push({tranid,status:actual.status,historyPreserved:true,noTestEmails:true,source});
  }
 }
 assert.equal((await query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='boss_test_close_orders_no_email'")).rows[0].n,0);
 console.log(JSON.stringify({verified:true,orders:results,temporaryEmailGuardRemoved:true}));
}finally{await closeDb();}
