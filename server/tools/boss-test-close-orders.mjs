// Explicitly authorized REST closure of the two test orders. Credentials stay in memory.
import './src/config.js';
import assert from 'node:assert/strict';
import {config} from './src/config.js';
import {query,withTransaction,closeDb} from './src/db.js';
import {writeAudit} from './src/auth-repository.js';
import {suiteql} from './src/netsuite.js';
import {getNetSuiteM2mAccessToken} from './src/netsuite-m2m-runtime.js';
import {enqueueDelayedStatusRefresh} from './src/netsuite-delayed-status-refresh-repository.js';
const orders=[{id:1036373,tranid:'SOB121952'},{id:1036372,tranid:'SOB121951'}];
const guard='boss_test_close_orders_no_email';
const mode=process.argv.find(a=>['--inspect','--close','--verify'].includes(a))||'--inspect';
async function rest(order,method='GET',body){
 const url=new URL(config.netsuite.restBaseUrl.replace(/\/$/,'')+'/record/v1/salesOrder/'+order.id);
 assert.equal(url.protocol,'https:');assert(url.hostname.endsWith('.suitetalk.api.netsuite.com'));
 if(method==='GET'){url.searchParams.set('expandSubResources','true');}
 const response=await fetch(url,{method,redirect:'error',signal:AbortSignal.timeout(45000),headers:{Authorization:'Bearer '+await getNetSuiteM2mAccessToken(),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 const text=await response.text();assert(response.ok,'REST '+response.status+': '+text.slice(0,2000));
 return {status:response.status,data:text?JSON.parse(text):null};
}
async function read(order){
 let data;
 try{({data}=await rest(order));}catch(error){
  if(!/record has been locked by a user defined workflow/i.test(error.message)){throw error;}
  const headers=(await suiteql(`SELECT id,tranid,status,entity FROM transaction WHERE type='SalesOrd' AND id=${order.id}`)).items;
  assert.equal(headers.length,1);const h=headers[0];assert.equal(h.status,'H');
  const items=(await suiteql(`SELECT id,item,isclosed FROM transactionline WHERE transaction=${order.id} AND mainline='F' AND taxline='F' AND item IS NOT NULL ORDER BY id`)).items;
  data={id:h.id,tranId:h.tranid,entity:{id:h.entity},orderStatus:{id:h.status,refName:'Closed'},item:{items:items.map(l=>({line:Number(l.id),item:{id:l.item},isClosed:l.isclosed==='T'}))}};
  console.log(JSON.stringify({stage:'workflowLockedReadVerifiedBySuiteQL',tranid:order.tranid,status:h.status}));
 }
 assert.equal(Number(data.id),order.id);assert.equal(data.tranId,order.tranid);assert.equal(Number(data.entity?.id),8444);
 assert(Array.isArray(data.item?.items)&&data.item.items.length>0,'Expected expanded sales order item lines.');
 return data;
}
const lines=r=>r.item.items.map(l=>({line:l.line,item:l.item,quantity:l.quantity,isClosed:l.isClosed,isclosed:l.isclosed,quantityFulfilled:l.quantityFulfilled,quantityBilled:l.quantityBilled}));
async function installGuard(){await withTransaction(async()=>{
 await query("SET LOCAL lock_timeout='5s'");
 const sending=await query("SELECT n.id FROM boss_approval_notifications n JOIN boss_approval_events e ON e.id=n.event_id JOIN boss_approval_requests r ON r.id=e.request_id WHERE r.order_id=ANY($1::bigint[]) AND n.email_status='sending'",[orders.map(o=>o.id)]);assert.equal(sending.rows.length,0);
 await query(`CREATE OR REPLACE FUNCTION ${guard}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF EXISTS(SELECT 1 FROM boss_approval_events e JOIN boss_approval_requests r ON r.id=e.request_id WHERE e.id=NEW.event_id AND r.order_id IN (1036372,1036373)) THEN
   NEW.available_at='infinity'::timestamptz;NEW.last_error='Email withheld: authorized automated test order closure; do not send.';
  END IF; RETURN NEW; END $$`);
 await query(`DROP TRIGGER IF EXISTS ${guard} ON boss_approval_notifications`);
 await query(`CREATE TRIGGER ${guard} BEFORE INSERT ON boss_approval_notifications FOR EACH ROW EXECUTE FUNCTION ${guard}()`);
 await query("UPDATE boss_approval_notifications n SET available_at='infinity'::timestamptz,last_error='Email withheld: authorized automated test order closure; do not send.' FROM boss_approval_events e JOIN boss_approval_requests r ON r.id=e.request_id WHERE n.event_id=e.id AND r.order_id=ANY($1::bigint[]) AND n.email_status='pending'",[orders.map(o=>o.id)]);
});}
async function audit(order,action,details){await writeAudit({actorType:'system',source:'assistant_maintenance',action,orderId:order.id,details:{tranid:order.tranid,test:true,automated:true,emailRequested:false,...details}});}
try{
 if(mode==='--close'){await installGuard();}
 for(const order of orders){
  const before=await read(order);
  const history=(await query('SELECT id,status,snapshot,actor_name FROM boss_approval_requests WHERE order_id=$1 ORDER BY cycle',[order.id])).rows;
  console.log(JSON.stringify({stage:'before',tranid:order.tranid,id:order.id,status:before.orderStatus,lines:lines(before),history}));
  if(mode==='--close'){
   assert(['B','H'].includes(before.orderStatus.id),'Unexpected status; stop.');
   const active=await query("SELECT c.id FROM boss_approval_commands c JOIN boss_approval_requests r ON r.id=c.request_id WHERE r.order_id=$1 AND c.status IN ('queued','sending','uncertain')",[order.id]);assert.equal(active.rows.length,0);
   const items=before.item.items.filter(l=>l.isClosed!==true&&l.isclosed!==true).map(l=>({line:l.line,isClosed:true}));
   assert(items.every(l=>Number.isSafeInteger(l.line)&&l.line>0));assert.equal(new Set(items.map(l=>l.line)).size,items.length);
   await audit(order,'boss.test_close.requested',{beforeStatus:before.orderStatus.id,items,history,emailGuardInstalled:true});
   let patchStatus=null,patchError=null;
   if(items.length){try{patchStatus=(await rest(order,'PATCH',{item:{items}})).status;}catch(error){patchError=error.message;}}
   console.log(JSON.stringify({stage:'patchResponse',tranid:order.tranid,patchStatus,patchError}));
   await audit(order,'boss.test_close.patch_response',{patchStatus,patchError});
   const after=await read(order);
   await audit(order,'boss.test_close.result',{patchStatus,patchError,status:after.orderStatus,lines:lines(after)});
   console.log(JSON.stringify({stage:'closure',tranid:order.tranid,patchStatus,patchError,status:after.orderStatus,lines:lines(after)}));
   assert.equal(after.orderStatus.id,'H','Closure unconfirmed; do not repeat the mutation.');assert(after.item.items.every(l=>l.isClosed===true||l.isclosed===true));
   assert.deepEqual((await query('SELECT id,status,snapshot,actor_name FROM boss_approval_requests WHERE order_id=$1 ORDER BY cycle',[order.id])).rows,history,'Previous approval history must remain intact.');
   const job=await enqueueDelayedStatusRefresh({orderType:'sales_order',netsuiteOrderId:order.id,tranid:order.tranid,availableAt:new Date(Date.now()+10000)});
   console.log(JSON.stringify({stage:'refreshQueued',tranid:order.tranid,jobId:job.jobId,availableAt:job.availableAt}));
  }
  if(mode==='--verify'){
   assert.equal(before.orderStatus.id,'H');assert(before.item.items.every(l=>l.isClosed===true||l.isclosed===true));
   assert(history.every(r=>r.status==='approved'&&r.actor_name==='Tony Tan'));
   const notices=(await query('SELECT e.kind,n.email_status,n.attempts,n.available_at::text FROM boss_approval_notifications n JOIN boss_approval_events e ON e.id=n.event_id JOIN boss_approval_requests r ON r.id=e.request_id WHERE r.order_id=$1 ORDER BY n.id',[order.id])).rows;
   assert(notices.every(n=>n.email_status==='sent'&&order.id===1036372&&n.kind==='requested'||n.email_status==='pending'&&n.attempts===0&&n.available_at==='infinity'));
   const source=(await query('SELECT observed_status,phase,generation,enriched_generation FROM boss_approval_sources WHERE order_id=$1',[order.id])).rows[0];assert.equal(source.observed_status,'H');assert.equal(source.phase,'H');
   await audit(order,'boss.test_close.verified',{status:'H',historyPreserved:true,noClosureEmails:true,source});
   console.log(JSON.stringify({verified:true,tranid:order.tranid,historyPreserved:true,noClosureEmails:true,source,notices}));
  }
 }
 if(mode==='--verify'){await withTransaction(async()=>{await query("SET LOCAL lock_timeout='5s'");await query(`DROP TRIGGER IF EXISTS ${guard} ON boss_approval_notifications`);await query(`DROP FUNCTION IF EXISTS ${guard}()`);});console.log(JSON.stringify({temporaryEmailGuardRemoved:true}));}
}finally{await closeDb();}
