import { fail,uuid,isAdmin,required } from '../../public/field-sales/domain.js';

// External changes are never silently overwritten. An admin reviews exact live
// hashes, adopts them as the next revision's baseline, and leaves an audit trail.
export async function publicationState(db,id,transport) {
  if(!transport){throw fail('The NetSuite estimate integration is not configured.',409);}
  const links=(await db.query('SELECT * FROM field_sales_estimates WHERE quote_id=$1 ORDER BY company',[uuid(id)])).rows;
  const states=[];
  for(const link of links){const remote=await transport('lookup',{externalId:link.external_id});states.push({company:link.company,externalId:link.external_id,...remote});}
  return states;
}
export async function reconcilePublication(db,actor,p,transport) {
  if(!isAdmin(actor)){throw fail('An admin must review changed NetSuite estimates.',403);}
  const reason=required(p.reason,'Reconciliation reason',2000);
  const quote=(await db.query('SELECT * FROM field_sales_quotes WHERE id=$1 FOR UPDATE',[uuid(p.id)])).rows[0];
  if(!quote){throw fail('Quote not found.',404);}
  if(Number(p.revision)!==quote.revision){throw fail('The quote changed. Review its latest revision.',409);}
  const busy=await db.query(`SELECT 1 FROM field_sales_posting_jobs WHERE quote_id=$1 AND state IN ('pending','working','uncertain')`,[quote.id]);
  if(busy.rowCount){throw fail('Wait for active publication attempts before reconciling.',409);}
  const states=await publicationState(db,quote.id,transport);
  if(!Array.isArray(p.states)||states.length!==p.states.length){throw fail('Review every linked estimate before continuing.',409);}
  for(const remote of states) {
    const reviewed=p.states.find(s=>s.company===remote.company);
    if(!reviewed||Boolean(reviewed.found)!==Boolean(remote.found)||reviewed.remoteHash!==remote.remoteHash||reviewed.internalId!==remote.internalId){throw fail('NetSuite changed since your review. Review again.',409);}
    if(remote.locked){throw fail('A linked estimate was converted. It cannot be revised from Field Sales.',409);}
    if(remote.found) {
      await db.query(`UPDATE field_sales_estimates SET netsuite_id=$3,reference=$4,remote_hash=$5,closed=$6 WHERE quote_id=$1 AND company=$2`,[quote.id,remote.company,remote.internalId,remote.reference||'',remote.remoteHash,Boolean(remote.closed)]);
    } else {
      await db.query('UPDATE field_sales_estimates SET netsuite_id=null,reference=null,remote_hash=null,synced_revision=0,closed=false WHERE quote_id=$1 AND company=$2',[quote.id,remote.company]);
    }
  }
  await db.query(`UPDATE field_sales_posting_jobs SET state='superseded',updated_at=now() WHERE quote_id=$1 AND state='attention'`,[quote.id]);
  await db.query(`INSERT INTO field_sales_audit(actor_id,action,target_id,detail) VALUES($1,'quote.reconcile',$2,$3)`,[actor.id,quote.id,JSON.stringify({states,reason})]);
  return {reconciled:true,states};
}
