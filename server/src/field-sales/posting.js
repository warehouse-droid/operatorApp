import { randomUUID } from 'node:crypto';
import { digest } from './repository.js';
import { fail, text } from '../../public/field-sales/domain.js';

export function createQuotePublisher(repo,{transport,enabled=false}={}) {
  const db=repo.db;let running=false;
  async function claim() {
    return db.transaction(async()=>{
      const row=(await db.query(`SELECT * FROM field_sales_posting_jobs WHERE (state IN ('pending','uncertain') AND next_attempt_at<=now()) OR (state='working' AND lease_until<now()) ORDER BY created_at,company FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
      if(!row){return null;}
      const lease=randomUUID();
      await db.query(`UPDATE field_sales_posting_jobs SET state='working',lease_until=now()+interval '3 minutes',lease_token=$2,attempt=attempt+1,updated_at=now() WHERE id=$1`,[row.id,lease]);
      return {...row,lease_token:lease,attempt:row.attempt+1};
    });
  }
  function verify(remote,payload) {
    if(!remote?.internalId || remote.revision!==payload.revision || remote.payloadHash!==payload.payloadHash || remote.unmodified===false){throw Object.assign(fail('NetSuite estimate identity or revision does not match this publication.',409),{permanent:true});}
    if(Boolean(remote.closed)!==Boolean(payload.close)){throw Object.assign(fail('NetSuite estimate closure does not match the quote.',409),{permanent:true});}
    if(!payload.close){for(const key of ['subtotalMinor','taxMinor','totalMinor']) {
      if(Number(remote.totals?.[key])!==payload.totals[key]){throw Object.assign(fail(`NetSuite ${key} differs from the quote. Review taxes, units, or account workflows.`,409),{permanent:true});}
    }}
  }
  async function complete(job,remote) {
    await db.transaction(async()=>{
      const current=(await db.query('SELECT * FROM field_sales_posting_jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
      if(current.lease_token!==job.lease_token){return;}
      await db.query(`UPDATE field_sales_estimates SET netsuite_id=$3,reference=$4,remote_hash=$5,synced_revision=$6,closed=$7 WHERE quote_id=$1 AND company=$2 AND synced_revision<=$6`,[job.quote_id,job.company,String(remote.internalId),text(remote.reference,100),remote.remoteHash,job.revision,Boolean(remote.closed)]);
      await db.query(`UPDATE field_sales_posting_jobs SET state='done',result=$2,error=null,lease_until=null,lease_token=null,updated_at=now() WHERE id=$1`,[job.id,JSON.stringify(remote)]);
      await db.query(`UPDATE field_sales_quotes q SET published_revision=$2 WHERE q.id=$1 AND NOT EXISTS(SELECT 1 FROM field_sales_posting_jobs j WHERE j.quote_id=q.id AND j.revision=$2 AND j.state<>'done') AND COALESCE(q.published_revision,0)<=$2`,[job.quote_id,job.revision]);
    });
  }
  async function tick() {
    if(running||!enabled||!transport){return;}
    const settings=(await repo.settings()).data;if(!settings.enabled||!settings.postingEnabled){return;}
    running=true;let job;
    try {
      job=await claim();if(!job){return;}
      const payload={...job.payload,payloadHash:digest({...job.payload,expectedRemoteHash:undefined})};
      const observed=await transport('lookup',{externalId:payload.externalId,recover:payload});
      if(observed.found&&observed.payloadHash===payload.payloadHash&&observed.revision===job.revision) {
        verify(observed,payload);await complete(job,observed);return;
      }
      if(observed.found && (observed.unmodified===false && payload.expectedRemoteHash!==observed.remoteHash || observed.locked || observed.revision>job.revision || (payload.expectedRemoteHash && payload.expectedRemoteHash!==observed.remoteHash))){throw Object.assign(fail('NetSuite was changed outside Field Sales or is no longer editable.',409),{permanent:true});}
      if(observed.found&&!payload.expectedRemoteHash){throw Object.assign(fail('An unexpected existing estimate uses this external ID.',409),{permanent:true});}
      const pending=await db.query(`SELECT payload FROM field_sales_posting_jobs WHERE quote_id=$1 AND revision=$2 AND state<>'done'`,[job.quote_id,job.revision]);
      await transport('preflight',{estimates:pending.rows.map(r=>r.payload)});
      const remote=await transport('write',payload);
      verify(remote,payload);await complete(job,remote);
    } catch(error) {
      if(job){await db.query(`UPDATE field_sales_posting_jobs SET state=$3,error=$4,next_attempt_at=now()+($5::integer*interval '1 second'),lease_until=null,lease_token=null,updated_at=now() WHERE id=$1 AND lease_token=$2`,[job.id,job.lease_token,error.permanent||job.attempt>=5?'attention':'uncertain',text(error.message,2000),Math.min(900,30*2**Math.min(job.attempt,5))]);}
      else {throw error;}
    } finally {running=false;}
  }
  return {tick};
}
