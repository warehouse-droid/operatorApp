import {randomUUID} from 'node:crypto';
import * as d from '../../public/repair/domain.js';
import {worChildren} from './wor-lines.js';

/** Local readiness and durable, explicitly authorized financial posting leases. */
export function attachManualPosting(c){
 const {api,query,one,raw,revision,command,event,requestRow}=c;
 const office=actor=>d.requireAllowed(d.canViewCosts(actor));
 async function snapshot(id){
  const child=await raw(id),job=requestRow(await one('SELECT * FROM repair_requests WHERE id=$1',[child.requestId]));
  const [jobs,quotes,work,usages,purchases,issues,tasks,settings]=await Promise.all([
   query('SELECT id,status,outcome,data FROM repair_jobs WHERE request_id=$1 ORDER BY sequence',[job.id]),
   query("SELECT * FROM repair_quotes WHERE request_id=$1 AND status<>'superseded' ORDER BY scope_number,version",[job.id]),
   query('SELECT * FROM repair_work_entries WHERE request_id=$1 ORDER BY created_at,id',[job.id]),
   query("SELECT u.*,p.name,(SELECT l.unit_minor FROM repair_purchase_lines l JOIN repair_purchases po ON po.id=l.purchase_id WHERE l.job_id=u.job_id AND l.part_id=u.part_id AND l.received_milli>0 AND po.invoice_ref<>'' ORDER BY po.created_at DESC LIMIT 1) AS unit_cost_minor FROM repair_part_usages u LEFT JOIN repair_parts p ON p.id=u.part_id WHERE u.request_id=$1 ORDER BY u.id",[job.id]),
   query('SELECT DISTINCT p.id,p.created_at FROM repair_purchases p JOIN repair_purchase_lines l ON l.purchase_id=p.id WHERE l.request_id=$1 ORDER BY p.created_at',[job.id]),
   query("SELECT id FROM repair_issues WHERE request_id=$1 AND status='reported'",[job.id]),
   query("SELECT * FROM repair_postings WHERE request_id=$1 AND (payload->>'manual'='true' OR state IN ('working','uncertain')) ORDER BY created_at DESC,id DESC",[job.id]),
   one('SELECT data FROM repair_settings')]);
  return {job,child,jobs:jobs.rows,quotes:quotes.rows,work:work.rows,usages:usages.rows.map(row=>({...row,quoteLineId:row.quote_line_id,partId:row.part_id,unitCostMinor:Number(row.unit_cost_minor||0),quantityMilli:Number(row.quantity_milli)})),purchases:await Promise.all(purchases.rows.map(p=>api.getPurchase({role:'repair_office'},p.id))),issues:issues.rows,tasks:tasks.rows,settings:settings.data};
 }
 function billBlockers(p){const result=[];if(p.lines.some(l=>l.category==='job_part'&&l.receivedMilli<l.quantityMilli))result.push('Receive every ordered part.');if(!p.invoiceRef?.trim()||p.status==='ordered')result.push('Record the supplier invoice.');if(!p.attachments.some(a=>a.kind==='receipt'))result.push('Attach the original supplier invoice / receipt.');if(!p.attachments.some(a=>a.kind==='purchase_photo'))result.push('Attach a purchase photo.');return result;}
 function state(s,type,blockers,purchase){
  const task=s.tasks.find(p=>p.payload.documentType===type&&(!purchase||p.purchase_id===purchase.id));
  const posted=type==='bill'?purchase?.data.billId:s.job.data[`${type}PostedAt`];
  return {status:task?.state==='working'?'posting':task&&['uncertain','attention'].includes(task.state)?task.state:posted?'posted':blockers.length?'not_ready':'ready',blockers,taskId:task?.id,error:task?.error||null,ref:type==='bill'?purchase.data.billRef:s.job.data[`${type}Ref`]||null};
 }
 function present(s){
  const blockers=[];if(s.tasks.some(p=>p.payload.manual!==true&&['working','uncertain'].includes(p.state)))blockers.push('Reconcile the earlier NetSuite posting before posting final documents.');
  if(s.job.status!=='completed')blockers.push('Complete every repair job.');
  if(s.job.receipt!=='accepted')blockers.push('Confirm the single equipment receipt for this request.');
  if(s.jobs.some(j=>!['completed','cancelled'].includes(j.status))||s.issues.length)blockers.push('Resolve every open job and reported issue.');
  if(s.quotes.some(q=>q.status!=='decided')||s.jobs.some(j=>j.data.quoteNeeded))blockers.push('Accept or reject every quote.');
  const inspectionHours=s.work.filter(w=>w.phase==='inspection').reduce((n,w)=>n+Number(w.data.hoursMilli||0),0);
  if(!inspectionHours)blockers.push('Review actual inspection hours.');
  for(const job of s.jobs.filter(j=>j.outcome==='repaired'))if(!s.work.some(w=>w.job_id===job.id&&w.phase==='repair'&&Number(w.data.hoursMilli)>0))blockers.push('Review actual repair hours for every completed repair job.');
  if(!d.isOther(s.job)&&!s.job.data.vehicle.netsuiteId)blockers.push('Link a verified NetSuite vehicle master for the WOR.');
  if(!s.job.data.vehicle.customerId)blockers.push('Verify the NetSuite equipment owner.');
  if(s.job.data.equipmentReconciliation)blockers.push('Reconcile the corrected equipment and its existing NetSuite records.');
  const approved=s.quotes.flatMap(q=>q.lines).filter(l=>l.decision==='approved');
  if(approved.some(l=>!l.itemId))blockers.push('Map every approved quote line to a NetSuite item.');
  try{worChildren(s.job,s.settings.mappings,s.quotes.flatMap(q=>q.lines.map(line=>({...line,jobId:q.job_id}))),s.usages,s.work);}catch(error){blockers.push(error.message);}
  const wor=state(s,'wor',[...new Set(blockers)]),sos=s.job.company==='MBR'?{status:'not_required',blockers:[]} :state(s,'sos',[...new Set([...blockers,...(!s.job.data.worPostedAt?['Post the completed WOR first so SOS can link to it.']:[])])]);
  const bills=s.purchases.map(p=>({id:p.id,revision:p.revision,number:p.data.poNumber||p.number,stage:d.purchaseStage(p),...state(s,'bill',billBlockers(p),p)}));
  return {quoteItems:s.quotes.flatMap(q=>q.lines.filter(l=>l.decision==='approved').map(l=>({id:l.id,itemId:l.itemId,description:l.description,kind:l.kind,jobId:q.job_id}))),mode:'manual',enabled:s.settings.postingEnabled===true,wor,sos,bills,ready:!blockers.length&&bills.every(p=>!p.blockers.length),parts:s.usages.map(u=>({id:u.id,jobId:u.job_id,description:u.description||u.name,kind:u.kind,quantityMilli:u.quantityMilli,technician:u.data.technician||null,repairItemId:u.data.repairItemId||'',revision:u.data.officeRevision||0})),workforce:s.work.map(w=>({id:w.id,jobId:w.job_id,phase:w.phase,actor:w.actor,technician:w.data.technician||w.actor,performers:w.data.performers||[],quoteLineId:w.data.quoteLineId||'',hoursMilli:Number(w.data.hoursMilli||0),hourlyCostMinor:Number(w.data.hourlyCostMinor||0),done:w.data.done||'',revision:w.data.officeRevision||0})),workforceEditable:!s.job.data.worPostedAt&&!s.tasks.some(p=>(p.payload.documentType==='wor'&&['working','uncertain','attention'].includes(p.state)||p.payload.manual!==true&&['working','uncertain'].includes(p.state)))};
 }
 api.postingStatus=async(actor,id)=>{office(actor);return present(await snapshot(id));};
 api.correctWorkforce=async(actor,id,input)=>{office(actor);return command(actor,`actual_workforce:${id}`,input,async()=>{
  const s=await snapshot(id),view=present(s);revision(s.child,input);if(!view.workforceEditable)throw d.fail('Reconcile the WOR before changing its posted or in-progress actual labour.',409);
  const entry=await one('SELECT * FROM repair_work_entries WHERE id=$1 AND request_id=$2 FOR UPDATE',[d.uuid(input.entryId),s.job.id]);if(!entry)throw d.fail('Work entry not found.',404);
  if((entry.data.officeRevision||0)!==input.entryRevision)throw d.fail('Actual labour changed. Refresh before saving.',409);
  const reason=d.text(input.reason,'Labour correction reason'),hoursMilli=String(input.hours)==='0'?0:d.quantity(input.hours),hourlyCostMinor=d.money(input.hourlyCost),technician=d.text(input.technician,'Technician',200);
  const data={...entry.data,hoursMilli,hourlyCostMinor,technician,officeRevision:(entry.data.officeRevision||0)+1};
  if(input.technicianIds!==undefined){data.performers=await c.selectTechnicians(input.technicianIds);data.technician=data.performers.map(p=>p.name).join(' / ');}else if(technician!==entry.data.technician)data.performers=[];
  if(input.quoteLineId){const quote=s.quotes.find(q=>q.job_id===entry.job_id&&q.lines.some(l=>l.id===input.quoteLineId&&l.kind==='labor'&&l.decision==='approved'));if(!quote)throw d.fail('Choose the approved repair item on this job.');data.quoteLineId=input.quoteLineId;}
  const target=entry.job_id===s.child.id?s.child:await raw(entry.job_id,true);
  await query('UPDATE repair_work_entries SET data=$2 WHERE id=$1',[entry.id,data]);await query('UPDATE repair_jobs SET revision=revision+1 WHERE id=$1',[target.id]);
  await event(actor,target,'actual_labour_corrected',{entryId:entry.id,previous:entry.data,current:data,reason});return {ok:true};
 });};
 api.correctActualParts=async(actor,id,input)=>{office(actor);return command(actor,`actual_parts:${id}`,input,async()=>{
  const s=await snapshot(id);revision(s.child,input);if(!present(s).workforceEditable)throw d.fail('Reconcile the WOR before changing its posted or in-progress parts.',409);
  const usage=await one('SELECT * FROM repair_part_usages WHERE id=$1 AND request_id=$2 FOR UPDATE',[d.uuid(input.usageId),s.job.id]);if(!usage)throw d.fail('Parts usage not found.',404);if((usage.data.officeRevision||0)!==input.usageRevision)throw d.fail('Parts attribution changed. Refresh before saving.',409);
  const reason=d.text(input.reason,'Parts attribution correction reason'),technician=(await c.selectTechnicians([input.technicianId]))[0],data={...usage.data,technician,officeRevision:(usage.data.officeRevision||0)+1};
  if(input.repairItemId){const ids=s.quotes.filter(q=>q.job_id===usage.job_id).flatMap(q=>q.lines.filter(l=>l.kind==='part'&&l.decision==='approved').map(l=>l.itemId));if(!ids.includes(input.repairItemId)&&!(ids.length===0&&input.repairItemId==='10555'))throw d.fail('Choose the parts repair item on this job.');data.repairItemId=d.reference(input.repairItemId);}
  await query('UPDATE repair_part_usages SET data=$2 WHERE id=$1',[usage.id,data]);const target=usage.job_id===s.child.id?s.child:await raw(usage.job_id,true);await query('UPDATE repair_jobs SET revision=revision+1 WHERE id=$1',[target.id]);await event(actor,target,'actual_parts_corrected',{usageId:usage.id,previous:usage.data,current:data,reason});return {ok:true};
 });};
 api.beginManualPosting=async(actor,id,input)=>{office(actor);return command(actor,`manual_post:${id}`,input,async()=>{
  await query("UPDATE repair_postings SET state='uncertain',error='Posting lease expired. Reconcile NetSuite before retrying.',lease_token=NULL WHERE state='working' AND lease_until<now() AND payload->>'manual'='true'");
  const type=d.choice(input.documentType,['wor','sos','bill'],'document'),s=await snapshot(id),view=present(s);revision(s.child,input);
  if(!s.settings.postingEnabled)throw d.fail('Manual NetSuite posting is disabled in Repair settings.',409);
  const purchase=type==='bill'?s.purchases.find(p=>p.id===input.purchaseId):null,doc=type==='bill'?view.bills.find(p=>p.id===input.purchaseId):view[type];
  if(!doc)throw d.fail('Purchase is not attached to this repair request.',404);
  if(purchase&&purchase.revision!==input.purchaseRevision)throw d.fail('Purchase changed. Refresh before posting its Bill.',409);
  if(doc.status!=='ready')throw d.fail(doc.blockers.join(' ')||'This document is already posted or requires reconciliation.',409);
  if(s.tasks.some(p=>p.state==='working'))throw d.fail('Another document is being posted for this request.',409);
  if(type==='bill')await query("UPDATE repair_purchases SET status='completed',revision=revision+1 WHERE id=$1",[purchase.id]);
  const taskId=randomUUID(),token=randomUUID(),payload={manual:true,documentType:type,authorizedBy:d.actorKey(actor),requestRevision:s.job.revision,revision:s.child.revision,quoteIds:s.quotes.map(q=>q.id),workIds:s.work.map(w=>({id:w.id,revision:w.data.officeRevision||0})),executing:false};
  let task;
  if(type==='bill')task=await one("UPDATE repair_postings SET request_id=$2,state='working',payload=$3,attempt=attempt+1,lease_token=$4,lease_until=now()+interval '5 minutes',error=NULL WHERE purchase_id=$1 AND kind='bill' AND state='pending' RETURNING *",[purchase.id,s.job.id,payload,token]);
  if(!task)task=await one("INSERT INTO repair_postings(id,request_id,purchase_id,kind,state,payload,attempt,lease_token,lease_until) VALUES($1,$2,$3,$4,'working',$5,1,$6,now()+interval '5 minutes') RETURNING *",[taskId,s.job.id,purchase?.id||null,type==='bill'?'bill':'work_update',payload,token]);
  await event(actor,s.child,'manual_post_requested',{postingId:task.id,documentType:type,purchaseId:purchase?.id});return {id:task.id,token:task.lease_token};
 });};
 api.beginManualBill=async(actor,id,input)=>{office(actor);return command(actor,`manual_bill:${id}`,input,async()=>{
  const settings=await one('SELECT data FROM repair_settings');if(!settings.data.postingEnabled)throw d.fail('Manual NetSuite posting is disabled in Repair settings.',409);
  const p=await api.getPurchase(actor,id);revision(p,input);const blockers=billBlockers(p);if(blockers.length)throw d.fail(blockers.join(' '),409);if(p.data.billId)throw d.fail('This supplier invoice is already posted.',409);
  await query("UPDATE repair_postings SET state='uncertain',error='Posting lease expired. Reconcile NetSuite before retrying.',lease_token=NULL WHERE purchase_id=$1 AND state='working' AND lease_until<now()",[id]);
  let task=await one("SELECT * FROM repair_postings WHERE purchase_id=$1 AND kind='bill' FOR UPDATE",[id]);if(task&&task.state!=='pending')throw d.fail('Bill is being posted or requires reconciliation.',409);
  const token=randomUUID(),payload={manual:true,documentType:'bill',authorizedBy:d.actorKey(actor),purchaseRevision:p.revision,executing:false};
  const parents=[...new Set(p.lines.map(l=>l.requestId).filter(Boolean))];const parent=parents.length===1?parents[0]:null;
  if(task)task=await one("UPDATE repair_postings SET request_id=$2,state='working',payload=$3,attempt=attempt+1,lease_token=$4,lease_until=now()+interval '5 minutes',error=NULL WHERE id=$1 RETURNING *",[task.id,parent,payload,token]);
  else task=await one("INSERT INTO repair_postings(id,request_id,purchase_id,kind,state,payload,attempt,lease_token,lease_until) VALUES($1,$2,$3,'bill','working',$4,1,$5,now()+interval '5 minutes') RETURNING *",[randomUUID(),parent,id,payload,token]);
  await query("UPDATE repair_purchases SET status='completed',revision=revision+1 WHERE id=$1",[id]);await event(actor,null,'manual_bill_requested',{postingId:task.id,purchaseId:id});return {id:task.id,token};
 });};
 api.manualSnapshot=snapshot;
 api.manualBillBlockers=billBlockers;
}
