import {randomUUID,randomBytes} from 'node:crypto';
import * as d from '../../public/repair/domain.js';
import {hash} from './repository.js';
import {AUTO_QUOTE_APPROVER,automaticQuoteCategory} from './quote-approval-policy.js';
const present=q=>({id:q.id,jobId:q.job_id,requestId:q.request_id,version:q.version,scopeId:q.scope_id,scopeNumber:q.scope_number,scopeRevision:q.scope_revision,title:q.title,status:q.status,autoApproved:q.decided_by===AUTO_QUOTE_APPROVER,lines:q.lines});
export function attachQuotes(c){
 const {api,query,one,raw,revision,mutable,command,event,notify,save,currentQuote,activeQuotes,jobs}=c;
 async function rejectJob(job,actor){job.status='completed';job.data.phase='quote_rejected';job.outcome='declined';job.data.completedBy=d.actorKey(actor);job.data.completedAt=(await one('SELECT now() AS now')).now.toISOString();}
 api.approvals=async actor=>{
  d.requireAllowed(d.has(actor,'yard_manager'),'Control repair approvals require Yard Manager authority for the responsible yard.');
  const yards=(actor.yardLocationIds||[]).map(Number).filter(Number.isSafeInteger);
  const rows=(await query(`SELECT q.id,q.version,q.title,q.lines,j.id AS job_id,j.number AS job_number,j.sequence,j.priority,j.data->>'defect' AS defect,
   r.id AS request_id,r.number AS request_number,r.company,r.yard_id,r.data,r.inspection_fee_minor,r.inspection_tax_bps
   FROM repair_quotes q JOIN repair_jobs j ON j.id=q.job_id JOIN repair_requests r ON r.id=j.request_id
   WHERE q.status='pending' AND j.status NOT IN ('completed','cancelled') AND r.status<>'cancelled' AND r.receipt<>'accepted'
   AND r.company IN ('MBBS','MBT') AND r.data->>'equipmentTypeConfirmed'='true' AND r.data->>'equipmentType' IN ('forklift','loader')
   AND r.yard_id=ANY($1::bigint[]) ORDER BY CASE j.priority WHEN 'urgent' THEN 0 ELSE 1 END,q.created_at LIMIT 200`,[yards])).rows;
  return rows.filter(row=>d.canApprove(actor,{company:row.company,yardId:row.yard_id,data:row.data})).map(row=>{
   const fee=row.sequence===1?Number(row.inspection_fee_minor):0;
   return {quoteId:row.id,version:row.version,title:row.title,jobId:row.job_id,jobNumber:row.job_number,requestId:row.request_id,requestNumber:row.request_number,yardId:Number(row.yard_id),priority:row.priority,defect:row.defect||row.data.defect,equipment:[row.data.vehicle?.plate,row.data.vehicle?.alias].filter(v=>v&&v!=='#').join(' · '),lines:row.lines,inspectionFeeMinor:fee,inspectionTaxBps:row.inspection_tax_bps,proposedTotals:d.totals(row.lines.map(line=>({...line,decision:'approved'})),fee,row.inspection_tax_bps)};
  });
 };
 api.quote=async(actor,id,input)=>{d.requireAllowed(d.canViewCosts(actor));return command(actor,`quote:${id}`,input,async()=>{
  const source=await raw(id,true);revision(source,input);const mode=d.choice(input.mode||((await activeQuotes(source)).length?'revision':'initial'),['initial','revision','additional'],'quote action');
  if(mode!=='additional')mutable(source);if(!source.data.inspectionComplete)throw d.fail('Complete the inspection before preparing a quote.',409);
  if(source.receipt==='pending'||source.receipt==='accepted')throw d.fail('Record formal receipt or rejection before revising this completed job.',409);
  const job=mode==='additional'?await jobs.additional(actor,source,input):source;
  const recipient=d.quoteRecipient(job);if(!recipient)throw d.fail('Confirm the equipment type and responsible yard before sending this quote for approval.',409);
  const lines=d.quoteLines(input.lines),old=await currentQuote(job),active=await activeQuotes(job);
  const target=mode==='revision'?active.find(q=>q.id===(input.quoteId||active.toSorted((a,b)=>b.version-a.version)[0]?.id)):null;
  if(mode==='revision'&&!target)throw d.fail('This quote is no longer current. Refresh before editing.',409);
  if(mode==='initial'&&active.length)throw d.fail('Add an additional quote or edit an existing quote.',409);
  const others=(await query("SELECT * FROM repair_quotes WHERE request_id=$1 AND status<>'superseded' AND id<>coalesce($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid)",[job.requestId,target?.id||null])).rows;
  if(lines.some(line=>others.some(q=>q.lines.some(other=>other.id===line.id))))throw d.fail('Quote line identifiers must be unique across active quotes. Add new lines for additional work.');
  d.totals([...others.flatMap(q=>q.lines),...lines.map(line=>({...line,decision:'approved'}))],job.inspectionFeeMinor,job.inspectionTaxBps);
  if(target)await query("UPDATE repair_quotes SET status='superseded',public_token_hash=NULL WHERE job_id=$1 AND scope_id=$2",[job.id,target.scope_id]);
  const settings=await one('SELECT data,revision FROM repair_settings FOR SHARE'),automatic=automaticQuoteCategory(settings.data,job);
  const approvedLines=automatic?d.decideLines(lines,lines.map(line=>({id:line.id,status:'approved',note:'Automatically approved by the repair quote policy.'}))):lines;
  const quoteId=randomUUID(),scopeNumber=job.sequence,version=Number((await one('SELECT coalesce(max(version),0)+1 AS number FROM repair_quotes WHERE request_id=$1',[job.requestId])).number);
  const quote=await one("INSERT INTO repair_quotes(id,request_id,job_id,version,status,lines,created_by,scope_id,scope_number,scope_revision,title,decided_by,decided_at) VALUES($1,$2,$3,$4,$11,$5,$6,$7,$8,$9,$10,$12,CASE WHEN $12::text IS NULL THEN NULL ELSE now() END) RETURNING *",[quoteId,job.requestId,job.id,version,JSON.stringify(approvedLines),d.actorKey(actor),job.id,scopeNumber,(old?.scope_revision||0)+1,d.text(input.title||target?.title||'','Quote title',200,false),automatic?'decided':'pending',automatic?AUTO_QUOTE_APPROVER:null]);
  job.data.phase=automatic?'approved':'quote_pending';job.data.quoteId=quote.id;if(automatic)job.outcome='repaired';await save(job);await event(actor,job,'quote_prepared',{version:quote.version,quoteId:quote.id,scopeNumber,scopeRevision:quote.scope_revision,mode});
  if(automatic){
   await event(actor,job,'quote_auto_approved',{quoteId:quote.id,category:automatic,settingsRevision:settings.revision,decidedBy:AUTO_QUOTE_APPROVER,scopeNumber,scopeRevision:quote.scope_revision});
   for(const target of ['role:repair_technician','role:repair_office'])await notify(target,job,'quote_approved',`${job.number}: quote ${scopeNumber}, revision ${quote.scope_revision} automatically approved`);
  }else await notify(recipient,job,'quote',`${job.number}: quote ${scopeNumber}, revision ${quote.scope_revision} needs approval`);return present(quote);
 });};
 api.decide=async(actor,id,input)=>{
  d.requireAllowed(d.canApprove(actor,await raw(id)));
  return command(actor,`decide:${id}`,input,async()=>{
   const job=await raw(id,true);mutable(job);d.requireAllowed(d.canApprove(actor,job));const quote=await one('SELECT * FROM repair_quotes WHERE id=$1 AND job_id=$2',[d.uuid(input.quoteId),id]);
   if(!quote||quote.status!=='pending')throw d.fail('This quote is no longer awaiting approval. Refresh to see its current revision.',409);
   if(actor.role==='repair_customer'&&(quote.public_token_hash!==actor.tokenHash||new Date(quote.public_expires_at)<=new Date()))throw d.fail('This quote link has expired.',410);
   const decisions=input.decisions===undefined?quote.lines.map(line=>({id:line.id,status:d.choice(input.decision,['approved','rejected'],'quote decision'),note:input.reason||''})):input.decisions;
   const lines=d.decideLines(quote.lines,decisions),others=(await activeQuotes(job)).filter(q=>q.id!==quote.id);
   d.totals([...others.flatMap(q=>q.lines),...lines],job.inspectionFeeMinor,job.inspectionTaxBps);
   await query("UPDATE repair_quotes SET lines=$2,status='decided',decided_by=$3,decided_at=now() WHERE id=$1",[quote.id,JSON.stringify(lines),d.actorKey(actor)]);
   const accepted=[...others.flatMap(q=>q.lines),...lines].some(line=>line.decision==='approved');
   job.data.phase=others.some(q=>q.status==='pending')?'quote_pending':accepted?'approved':'inspection_only';job.outcome=accepted?'repaired':'declined';if(!accepted&&!others.some(q=>q.status==='pending'))await rejectJob(job,actor);await save(job);
   await event(actor,job,'quote_decided',{version:quote.version,quoteId:quote.id,scopeNumber:quote.scope_number,decisions:lines.map(line=>({id:line.id,decision:line.decision,reason:line.decisionNote}))});
   await notify('role:repair_technician',job,lines.some(line=>line.decision==='approved')?'quote_approved':'quote_decided',`${job.number}: quote ${quote.scope_number} decisions saved`);await notify('role:repair_office',job,lines.some(line=>line.decision==='approved')?'quote_approved':'quote_decided',`${job.number}: quote ${quote.scope_number} decisions saved`);
   return present({...quote,status:'decided',lines});
  });
 };
 api.normalizeRejectedQuote=async(actor,input)=>{
  d.requireAllowed(d.has(actor,'admin'),'Administrative authority is required for historical quote correction.');
  return command(actor,'normalize_rejected_quote',input,async()=>{
   const job=await raw(d.uuid(input.jobId),true),quote=await one('SELECT * FROM repair_quotes WHERE id=$1 AND job_id=$2 FOR UPDATE',[d.uuid(input.quoteId),job.id]);
   if(job.requestId!==d.uuid(input.requestId)||!quote||quote.status!=='decided'||!quote.lines.some(l=>l.decision==='rejected')||!quote.lines.some(l=>l.decision==='approved'))throw d.fail('The target must be the specified job with a mixed decided quote.',409);
   if(job.data.quoteId!==quote.id||['completed','cancelled'].includes(job.status)||['pending','accepted'].includes(job.receipt))throw d.fail('The target job changed or is closed. Review it before correcting the quote.',409);
   const used=await one(`SELECT (SELECT count(*) FROM repair_work_entries WHERE job_id=$1 AND phase='repair')+(SELECT count(*) FROM repair_part_usages WHERE job_id=$1)+(SELECT count(*) FROM repair_purchase_lines WHERE job_id=$1)+(SELECT count(*) FROM repair_postings WHERE request_id=$2 AND kind<>'inspection') AS count`,[job.id,job.requestId]);
   if(Number(used.count))throw d.fail('Downstream work, parts usage, purchases or posting require review before correction.',409);
   const reason=d.text(input.reason,'Correction reason'),previousJob={status:job.status,outcome:job.outcome,phase:job.data.phase},note=quote.lines.find(l=>l.decision==='rejected'&&l.decisionNote)?.decisionNote||reason;
   const lines=quote.lines.map(line=>({...line,decision:'rejected',decisionNote:line.decisionNote||note}));
   await query('UPDATE repair_quotes SET lines=$2 WHERE id=$1',[quote.id,JSON.stringify(lines)]);await rejectJob(job,actor);await save(job);
   await event(actor,job,'quote_decision_corrected',{quoteId:quote.id,reason,previousLines:quote.lines,previousJob,decision:'rejected'});await notify('role:repair_office',job,'quote_decided',`${job.number}: whole quote rejected following correction`);
   return {quoteId:quote.id,jobId:job.id,requestId:job.requestId,decision:'rejected'};
  });
 };
 api.quoteLink=async(actor,id,quoteId)=>{d.requireAllowed(d.canViewCosts(actor));return c.transaction(async()=>{
  const job=await raw(id,true),quote=await one('SELECT * FROM repair_quotes WHERE job_id=$1 AND id=$2',[id,d.uuid(quoteId)]);if(job.company!=='EXTERNAL'||!quote||quote.status!=='pending')throw d.fail('Only a current customer quote can be shared.',409);
  const token=randomBytes(32).toString('base64url');await query("UPDATE repair_quotes SET public_token_hash=$2,public_expires_at=now()+interval '30 days' WHERE id=$1",[quoteId,hash(token)]);await event(actor,job,'quote_link_rotated',{version:quote.version,scopeNumber:quote.scope_number});return {token};
 });};
 api.publicQuote=async token=>{
  if(typeof token!=='string'||!/^[\w-]{43}$/u.test(token))throw d.fail('Quote not found.',404);
  const quote=await one('SELECT * FROM repair_quotes WHERE public_token_hash=$1',[hash(token)]);if(!quote)throw d.fail('Quote not found.',404);if(new Date(quote.public_expires_at)<=new Date())throw d.fail('This quote link has expired.',410);
  const job=await raw(quote.job_id),parent=await one('SELECT * FROM repair_requests WHERE id=$1',[job.requestId]);if(job.company!=='EXTERNAL'||quote.status==='superseded'||job.status==='cancelled')throw d.fail('Quote not found.',404);
  const all=(await query("SELECT * FROM repair_quotes WHERE request_id=$1 AND status<>'superseded'",[job.requestId])).rows,lines=all.flatMap(q=>q.lines),proposed=all.flatMap(q=>q.id===quote.id?q.lines.map(l=>({...l,decision:'approved'})):q.lines);
  return {job:{id:job.id,number:job.requestNumber,jobNumber:job.number,requestId:job.requestId,vehicle:job.data.vehicle.plate||job.data.vehicle.alias,defect:job.data.defect,inspectionFeeMinor:Number(parent.inspection_fee_minor),inspectionTaxBps:parent.inspection_tax_bps},quote:present(quote),totals:d.totals(lines,Number(parent.inspection_fee_minor),parent.inspection_tax_bps),proposedTotals:d.totals(proposed,Number(parent.inspection_fee_minor),parent.inspection_tax_bps),quoteCount:all.length};
 };
 api.quoteHistory=async(actor,id)=>{const job=await raw(id);d.requireAllowed(d.canViewCosts(actor)||d.canApprove(actor,job));return (await query('SELECT id,version,scope_number AS "scopeNumber",scope_revision AS "scopeRevision",title,status,lines,created_at,decided_at,decided_by FROM repair_quotes WHERE job_id=$1 ORDER BY version DESC',[id])).rows.map(q=>({...q,autoApproved:q.decided_by===AUTO_QUOTE_APPROVER}));};
}
