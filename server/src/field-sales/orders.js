import { randomUUID } from 'node:crypto';
import { digest } from './repository.js';
import { fail,text } from '../../public/field-sales/domain.js';

const permanent=message=>Object.assign(fail(message,409),{permanent:true});
export function verifyOrder(remote,p) {
 if(!/^[1-9]\d*$/.test(String(remote?.internalId||''))||remote.externalId!==p.externalId||remote.payloadHash!==p.payloadHash||remote.revision!==p.revision||remote.customerId!==p.customerNetsuiteId||remote.company!==p.company||remote.unmodified!==true){throw permanent('The Sales Order identity or accepted revision differs. Review the linked NetSuite order.');}
 for(const key of ['subtotalMinor','taxMinor','totalMinor']){if(!Number.isSafeInteger(remote.totals?.[key])||remote.totals[key]!==p.totals[key]){throw permanent(`NetSuite ${key} differs from the accepted quote. Review the linked Sales Order.`);}}
}
function verifyCustomer(c,p,expectedId) {
 if(!c?.found||!c.active||String(c.currencyId)!==String(p.config.currencyId)||String(c.internalId)!==String(expectedId)){throw permanent('The linked NetSuite customer is missing, inactive, or has a different identity or currency. Review the customer in NetSuite.');}
 if(p.config.customerSubsidiaries.some(id=>!(c.subsidiaries||[]).map(String).includes(String(id)))){throw permanent('The customer is not available to every required company subsidiary. Update its subsidiary memberships in NetSuite.');}
}
export function createOrderPublisher(repo,{transport,enabled=false}={}) {
 const db=repo.db;let running=false;
 async function claim(){return db.transaction(async()=>{
  const job=(await db.query(`SELECT * FROM field_sales_order_jobs WHERE (state IN ('pending','uncertain') AND next_attempt_at<=now()) OR (state='working' AND lease_until<now()) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
  if(!job){return null;}const token=randomUUID();
  await db.query("UPDATE field_sales_order_jobs SET state='working',lease_token=$2,lease_until=now()+interval '3 minutes',attempt=attempt+1,updated_at=now() WHERE id=$1",[job.id,token]);
  return {...job,lease_token:token,attempt:job.attempt+1};
 });}
 async function customer(p){return db.transaction(async()=>{
  // Keep the accepted mapping stable while validating the existing account.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`customer-account:${p.customerId}:${p.accountGroup}`]);
  const current=(await db.query('SELECT * FROM field_sales_customer_accounts WHERE customer_id=$1 AND account_group=$2 FOR UPDATE',[p.customerId,p.accountGroup])).rows[0];
  if(current?.netsuite_id!==p.linkedCustomerId){throw permanent('The customer link changed after confirmation. Review the accepted order intent.');}
  const remote=await transport('customer.lookup',p);verifyCustomer(remote,p,p.linkedCustomerId);
  await db.query('UPDATE field_sales_customer_accounts SET reference=$3,updated_at=now() WHERE customer_id=$1 AND account_group=$2',[p.customerId,p.accountGroup,text(remote.reference,250)]);
  return String(remote.internalId);
 });}
 async function remember(job,remote){
  if(remote?.internalId){await db.query('UPDATE field_sales_order_jobs SET netsuite_id=$3,reference=$4,result=$5,updated_at=now() WHERE id=$1 AND lease_token=$2',[job.id,job.lease_token,String(remote.internalId),text(remote.reference,100),JSON.stringify(remote)]);}
 }
 async function tick(){
  if(running||!enabled||!transport){return;}const settings=(await repo.settings()).data;
  if(!settings.enabled||!settings.salesOrderPostingEnabled){return;}running=true;let job;
  try {
   job=await claim();if(!job){return;}
   const p={...job.payload};p.payloadHash=digest(p);
   // Recover a committed order before validating today's catalog. A later item
   // change must not obscure an order already created from the accepted intent.
   p.customerNetsuiteId=job.customer_netsuite_id;
   if(p.linkedCustomerId&&p.customerNetsuiteId&&p.linkedCustomerId!==p.customerNetsuiteId){throw permanent('The saved order customer differs from the accepted customer link. Review the order in NetSuite.');}
   let remote=p.customerNetsuiteId?await transport('order.lookup',p):{found:false};
   if(!remote.found){
    if(!/^[1-9]\d*$/.test(String(p.linkedCustomerId||''))){throw permanent('Link an existing NetSuite customer on a new reviewed quote before creating this Sales Order. This legacy intent has no accepted customer link.');}
    await transport('order.preflight',p);
    p.customerNetsuiteId=await customer(p);
    const owned=await db.query('UPDATE field_sales_order_jobs SET customer_netsuite_id=$3 WHERE id=$1 AND lease_token=$2 RETURNING id',[job.id,job.lease_token,p.customerNetsuiteId]);
    if(!owned.rowCount){return;}
    remote=await transport('order.lookup',p);
    if(!remote.found){remote=await transport('order.create',p);}
   }
   await remember(job,remote);verifyOrder(remote,p);
   await db.query("UPDATE field_sales_order_jobs SET state='done',error=null,lease_token=null,lease_until=null,updated_at=now() WHERE id=$1 AND lease_token=$2",[job.id,job.lease_token]);
  } catch(error){
   if(!job){throw error;}
   await db.query(`UPDATE field_sales_order_jobs SET state=$3,error=$4,next_attempt_at=now()+($5::integer*interval '1 second'),lease_token=null,lease_until=null,updated_at=now() WHERE id=$1 AND lease_token=$2`,[job.id,job.lease_token,error.permanent||job.attempt>=5?'attention':'uncertain',text(error.message,2000),Math.min(900,30*2**Math.min(job.attempt,5))]);
  } finally {running=false;}
 }
 return {tick};
}
