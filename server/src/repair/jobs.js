import {randomUUID} from 'node:crypto';
import * as d from '../../public/repair/domain.js';
const childKeys=['inspectionRequired','inspectionComplete','phase','defect','nextStep','assignedTechnician','performers','startedAt','startedBy','startedPhase','completedAt','completedBy','eta','quoteId'];
const parentKeys=['vehicle','equipmentType','equipmentTypeConfirmed','originalEquipment','equipmentReconciliation','accountingReview','conditionReason','recipient','delegationReason','handover','cancellationReason'];
export function workJobRow(parent,child){return {...parent,id:child.id,requestId:parent.id,requestNumber:parent.number,number:child.number,inspectionFeeMinor:child.sequence===1?parent.inspectionFeeMinor:0,requestCompletedAt:parent.data.completedAt,sequence:child.sequence,revision:child.revision,status:child.status,priority:child.priority,outcome:child.outcome,parentReceipt:parent.receipt,parentStatus:parent.status,data:{...parent.data,quoteNeeded:false,...child.data},createdAt:child.created_at,updatedAt:child.updated_at};}
export function createRepairJobs({query,one,requestRow,notify,posting}){
 const dataFor=job=>Object.fromEntries(childKeys.filter(key=>job.data[key]!==undefined).map(key=>[key,job.data[key]]));
 async function initialize(parent){await query('INSERT INTO repair_jobs(id,request_id,number,sequence,status,priority,outcome,data) VALUES($1,$1,$2,1,$3,$4,$5,$6)',[parent.id,parent.number+'-J01',parent.status,parent.priority,parent.outcome,{...dataFor(parent),inspectionRequired:true}]);}
 async function raw(id,lock=false){
  const child=await one(`SELECT * FROM repair_jobs WHERE id=$1 ${lock?'FOR UPDATE':''}`,[d.uuid(id)]);if(!child)throw d.fail('Repair job not found.',404);
  const parent=requestRow(await one(`SELECT * FROM repair_requests WHERE id=$1 ${lock?'FOR UPDATE':''}`,[child.request_id]));
  return workJobRow(parent,child);
 }
 async function rollup(id){
  const parent=requestRow(await one('SELECT * FROM repair_requests WHERE id=$1 FOR UPDATE',[id]));
  const children=(await query('SELECT * FROM repair_jobs WHERE request_id=$1 ORDER BY sequence',[id])).rows,openIssues=Number((await one("SELECT count(*) FROM repair_issues WHERE request_id=$1 AND status='reported'",[id])).count);
  const live=children.filter(j=>j.status!=='cancelled'),first=children[0],allComplete=live.length&&live.every(j=>j.status==='completed')&&!openIssues;
  parent.priority=children.some(j=>j.priority==='urgent')?'urgent':'normal';parent.data.inspectionComplete=first?.data.inspectionComplete===true;parent.data.quoteNeeded=openIssues>0;
  parent.outcome=live.some(j=>j.outcome==='declined')?'declined':'repaired';
  if(parent.status!=='cancelled'&&parent.receipt!=='accepted'){
   if(allComplete){parent.status='completed';parent.data.phase='awaiting_receipt';if(parent.receipt!=='pending'){parent.receipt='pending';parent.data.completedAt=(await one('SELECT now() AS now')).now.toISOString();if(parent.company==='MBR'){parent.receipt='accepted';parent.data.phase='completed';parent.data.handover={method:'repair_team',receiver:children.filter(j=>j.data.completedBy).sort((a,b)=>new Date(b.data.completedAt)-new Date(a.data.completedAt))[0]?.data.completedBy||'repair_team',at:parent.data.completedAt};}await posting(parent,'work_update');await notify(parent.company==='EXTERNAL'||parent.company==='MBR'?'role:repair_office':parent.data.recipient||`${parent.requesterType}:${parent.requesterId}`,parent,'completed',`${parent.number}: ${parent.company==='MBR'?'rental repair closed by Repair Team':parent.company==='EXTERNAL'?'all jobs complete; provide the customer confirmation link':'all repair jobs are complete. Inspect and receive the equipment.'}`);}}
   else {parent.status=live.some(j=>j.status==='re_inspect')?'re_inspect':live.some(j=>j.status==='in_progress')?'in_progress':'queuing';parent.data.phase=!parent.data.inspectionComplete?'inspection':openIssues?'quote_needed':'repair';if(parent.receipt==='pending')parent.receipt='none';}
  }
  await query('UPDATE repair_requests SET status=$2,receipt=$3,outcome=$4,priority=$5,data=$6,revision=revision+1,updated_at=now() WHERE id=$1',[id,parent.status,parent.receipt,parent.outcome,parent.priority,parent.data]);return parent;
 }
 async function save(job){
  const parent=requestRow(await one('SELECT * FROM repair_requests WHERE id=$1 FOR UPDATE',[job.requestId]));
  const changedAsset=job.vehicleId!==parent.vehicleId,changedScope=changedAsset||job.data.equipmentType!==parent.data.equipmentType||Number(job.yardId||0)!==Number(parent.yardId||0);
  for(const key of parentKeys)if(job.data[key]!==undefined)parent.data[key]=job.data[key];
  if(job.receipt!==job.parentReceipt)parent.receipt=job.receipt;
  if(job.data.cancellationReason){parent.status='cancelled';await query("UPDATE repair_jobs SET status='cancelled',revision=revision+1 WHERE request_id=$1",[parent.id]);}
  if(changedScope)await query(`UPDATE repair_jobs SET status=CASE WHEN $3 THEN 're_inspect' ELSE 'queuing' END,outcome='repaired',
   data=(data-'quoteId')||jsonb_build_object('phase',CASE WHEN $3 OR NOT coalesce((data->>'inspectionComplete')::boolean,false) THEN 'inspection' ELSE 'quote_needed' END)
    ||CASE WHEN $3 THEN '{"inspectionComplete":false,"inspectionRequired":true}'::jsonb ELSE '{}'::jsonb END,
   revision=revision+1,updated_at=now() WHERE request_id=$1 AND id<>$2 AND status<>'cancelled'`,[parent.id,job.id,changedAsset]);
  await query('UPDATE repair_requests SET vehicle_id=$2,yard_id=$3,condition=$4,receipt=$5,status=$6,data=$7 WHERE id=$1',[parent.id,job.vehicleId,job.yardId,job.condition,parent.receipt,parent.status,parent.data]);
  await query('UPDATE repair_jobs SET status=$2,priority=$3,outcome=$4,data=$5,revision=revision+1,updated_at=now() WHERE id=$1',[job.id,job.status,job.priority,job.outcome,dataFor(job)]);
  await rollup(parent.id);return raw(job.id);
 }
 async function additional(_actor,source,input){
  const parent=requestRow(await one('SELECT * FROM repair_requests WHERE id=$1 FOR UPDATE',[source.requestId]));
  if(parent.status==='cancelled'||['pending','accepted'].includes(parent.receipt))throw d.fail('This request is awaiting receipt or is closed.',409);
  if(!parent.data.inspectionComplete)throw d.fail('Complete the first job inspection before issuing additional job quotes.',409);
  const issue=input.issueId?await one('SELECT * FROM repair_issues WHERE id=$1 AND request_id=$2 FOR UPDATE',[d.uuid(input.issueId),parent.id]):null;
  if(input.issueId&&(!issue||issue.status!=='reported'))throw d.fail('This issue has already been resolved or belongs to another request.',409);
  const sequence=Number((await one('SELECT coalesce(max(sequence),0)+1 AS next FROM repair_jobs WHERE request_id=$1',[parent.id])).next),id=randomUUID();
  const defect=d.text(issue?.description||input.title||input.lines?.[0]?.description,'Additional repair problem');
  await query("INSERT INTO repair_jobs(id,request_id,number,sequence,status,priority,outcome,data) VALUES($1,$2,$3,$4,'queuing',$5,'repaired',$6)",[id,parent.id,`${parent.number}-J${String(sequence).padStart(2,'0')}`,sequence,source.priority,{inspectionRequired:false,inspectionComplete:true,phase:'quote_needed',defect}]);
  if(issue)await query("UPDATE repair_issues SET status='quoted',job_id=$2 WHERE id=$1",[issue.id,id]);return raw(id,true);
 }
 async function report(actor,job,input){await query('INSERT INTO repair_issues(id,request_id,source_job_id,description,created_by) VALUES($1,$2,$3,$4,$5)',[randomUUID(),job.requestId,job.id,d.text(input.done,'Additional problem'),d.actorKey(actor)]);await notify('role:repair_office',job,'additional_fault',`${job.requestNumber}: additional problem reported from ${job.number}; prepare a new job quote.`);}
 return {raw,save,initialize,rollup,additional,report};
}
