import {randomUUID} from 'node:crypto';
import * as d from '../../public/repair/domain.js';
import {date} from './repository.js';
import {correctEquipment} from './equipment.js';
export function attachActions(c){
 const {api,query,one,raw,revision,command,mutable,save,event,notify,posting,activeQuotes,requireApproved,publicRequest,jobs}=c;
 async function start(actor,job,input,phase){
  if(d.jobStarted(job,phase)&&job.data.performers?.length)throw d.fail('This phase is already started.',409);
  job.data.performers=await c.selectTechnicians(input.technicianIds);job.data.startedBy=d.actorKey(actor);job.data.startedAt=(await one('SELECT now() AS now')).now.toISOString();job.data.startedPhase=phase;job.data.assignedTechnician=d.actorKey(actor);job.status='in_progress';job.data.phase=phase;
 }
 async function entry(actor,job,input,phase){
  d.requireJobStarted(job,phase);
  const data={technician:actor.display_name||actor.name||String(actor.id),done:d.text(input.done,'Work performed'),diagnosis:d.text(input.diagnosis||'','Diagnosis',4000,false),nextStep:d.text(input.nextStep||'','Next step',4000,false),hoursMilli:!input.hours||String(input.hours)==='0'?0:d.quantity(input.hours),quoteLineId:input.quoteLineId||null};
  data.performers=structuredClone(job.data.performers||[]);if(data.performers.length)data.technician=data.performers.map(person=>person.name).join(' / ');data.startedAt=job.data.startedAt;data.startedBy=job.data.startedBy;
  if(phase==='repair'){await requireApproved(job,input.quoteLineId);if(!input.quoteLineId&&data.hoursMilli)throw d.fail('Choose the approved quote line for these hours.');}
  job.recordedWork=(await query('INSERT INTO repair_work_entries(id,request_id,phase,actor,data,job_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,request_id,job_id,phase,actor,data,created_at',[randomUUID(),job.requestId,phase,d.actorKey(actor),data,job.id])).rows[0];job.data.nextStep=data.nextStep;
 }
 async function receipt(actor,job,input){
  d.requireAllowed(d.canReceive(actor,{...job,id:job.requestId}));
  if(job.company==='EXTERNAL')await api.verifyHandoverActor(actor,job.requestId);
  if(job.status!=='completed'||job.receipt!=='pending')throw d.fail('This repair is not awaiting receipt.',409);
  const decision=d.choice(input.decision,['accepted','rejected'],'receipt decision');
  const ids=Array.isArray(input.attachmentIds)?input.attachmentIds.map(d.uuid):[];
  if(!ids.length)throw d.fail('Take a handover photo before confirming receipt.');
  const count=await one("SELECT count(*) FROM repair_attachments WHERE id=ANY($1::uuid[]) AND request_id=$2 AND kind='handover' AND mime_type LIKE 'image/%' AND created_by=$3 AND created_at>=$4::timestamptz",[ids,job.requestId,d.actorKey(actor),job.requestCompletedAt||job.data.completedAt||job.createdAt]);if(Number(count.count)!==new Set(ids).size)throw d.fail('A new handover photo taken by the receiving person is required.');
  const reason=d.text(input.reason||'',decision==='rejected'?'Rejection reason':'Receipt note',2000,decision==='rejected');
  const receiver=job.company==='EXTERNAL'?d.text(input.receiver,'Customer receiving the vehicle',200):d.actorKey(actor);
  job.receipt=decision;job.data.handover={decision,reason,receiver,attachmentIds:ids,at:new Date().toISOString()};
  if(decision==='rejected'){job.status='re_inspect';job.data.phase='re_inspect';job.data.inspectionComplete=false;await notify('role:repair_technician',job,'reinspect',`${job.number}: receipt rejected; re-inspection needed`);}
  await notify('role:repair_office',job,'receipt',`${job.number}: receipt ${decision}`);await posting(job,'work_update');
 }
 async function details(actor,job,input){
  d.requireAllowed(d.canViewCosts(actor)||d.canWorkshop(actor));
  if(job.status==='cancelled'||job.receipt==='accepted'&&job.outcome==='repaired')throw d.fail('This repair is closed.',409);
  const priority=d.choice(input.priority,['normal','urgent'],'priority'),condition=d.isOther(job)?job.condition:d.choice(input.condition,d.CONDITIONS,'operating condition');
  const equipmentType=d.choice(input.equipmentType||job.data.equipmentType,d.EQUIPMENT_TYPES,'equipment type'),vehicleId=input.vehicleId||job.vehicleId,yardId=input.yardId===undefined?job.yardId:input.yardId;
  const changedEquipment=vehicleId!==job.vehicleId||equipmentType!==job.data.equipmentType||Number(yardId||0)!==Number(job.yardId||0)||(!job.data.equipmentTypeConfirmed&&equipmentType!=='unknown');
  const changedCondition=condition!==job.condition,reason=d.text(input.reason||'','Reason for changes',4000,changedEquipment||changedCondition),previous={priority:job.priority,condition:job.condition};
  if(changedEquipment&&(job.status==='completed'||job.receipt==='pending'))throw d.fail('Awaiting formal receipt. Reject the repair before correcting equipment.',409);
  job.priority=priority;job.condition=condition;if(changedCondition)job.data.conditionReason=reason;
  const result=changedEquipment?await correctEquipment(c,actor,job,{...input,vehicleId,equipmentType,yardId,reason}):await save(job);
  await event(actor,result,'details_saved',{previous,current:{priority,condition},reason});
  if(changedCondition&&condition==='out_of_service')await notify(d.quoteRecipient(result)||'role:repair_office',result,'hold',`${result.number}: equipment is out of service; review assignments.`);
  return result;
 }
 api.action=async(actor,id,input)=>publicRequest(actor,await command(actor,`action:${id}`,input,async()=>{
  const job=await raw(id,true);d.requireAllowed(d.canRead(actor,job)||(input.action==='receive'&&d.canReceive(actor,{...job,id:job.requestId})));revision(job,input);
  if(!['details','condition','receive','delegate','complete_rental','cancel','priority'].includes(input.action))mutable(job);
  if(job.receipt==='pending'&&!['details','receive','condition','delegate','complete_rental','cancel','priority'].includes(input.action))throw d.fail('Awaiting formal receipt. Rejected repairs return to re-inspection.',409);
  const tech=()=>d.requireAllowed(d.canWorkshop(actor));const office=()=>d.requireAllowed(d.canViewCosts(actor));
  switch(input.action){
   case 'details':return details(actor,job,input);
   case 'equipment':return correctEquipment(c,actor,job,input);
   case 'condition':
    if(d.isOther(job))throw d.fail('Address repairs do not have an equipment operating condition.');
    d.requireAllowed(d.canChangeCondition(actor,job));if(job.status==='cancelled'||job.receipt==='accepted'&&job.outcome==='repaired')throw d.fail('This repair is closed.',409);
    job.condition=d.choice(input.condition,d.CONDITIONS,'operating condition');job.data.conditionReason=d.text(input.reason,'Reason');
    if(job.condition==='out_of_service')await notify(d.quoteRecipient(job)||'role:repair_office',job,'hold',`${job.number}: vehicle is out of service; review today's assignments.`);break;
   case 'inspection_start':tech();if(job.data.inspectionComplete&&job.status!=='re_inspect')throw d.fail('This inspection is already complete.',409);await start(actor,job,input,'inspection');break;
   case 'inspection_complete':tech();await entry(actor,job,input,'inspection');job.data.inspectionComplete=true;job.data.phase='quote_needed';job.status='queuing';await notify('role:repair_office',job,'quote_needed',`${job.number}: inspection finished; prepare a quote`);break;
   case 'start_repair':tech();await requireApproved(job);await start(actor,job,input,'repair');break;
   case 'report_fault':tech();await entry(actor,job,input,job.data.phase==='repair'?'repair':'inspection');await jobs.report(actor,job,input);break;
   case 'work':tech();await entry(actor,job,input,input.phase==='inspection'?'inspection':'repair');break;
   case 'waiting_for_parts':tech();await requireApproved(job);job.status='waiting_for_parts';job.data.eta=date(input.eta,true);job.data.nextStep=d.text(input.nextStep,'Next step');break;
   case 'complete':{
    tech();const quotes=await activeQuotes(job);if(job.data.quoteNeeded)throw d.fail('Prepare a quote for the additional reported problem before completing the job.',409);if(!job.data.inspectionComplete||!quotes.length||quotes.some(q=>q.status!=='decided'))throw d.fail('Inspection and quote decisions must be complete.',409);
    const pending=await one("SELECT (SELECT count(*) FROM repair_part_requests WHERE job_id=$1 AND status IN ('requested','approved','ordered'))+(SELECT count(*) FROM repair_purchase_lines WHERE job_id=$1 AND received_milli<quantity_milli) AS count",[id]);if(Number(pending.count))throw d.fail('Resolve outstanding parts requests and receive PO parts before completion.',409);
    await entry(actor,job,{...input,hours:input.hours||'0'},job.outcome==='repaired'?'repair':'inspection');
    job.status='completed';job.data.phase='completed';job.data.completedBy=d.actorKey(actor);job.data.completedAt=(await one('SELECT now() AS now')).now.toISOString();break;
   }
   case 'receive':await receipt(actor,job,input);break;
   case 'complete_rental':tech();if(job.company!=='MBR'||job.parentStatus!=='completed'||job.receipt!=='pending')throw d.fail('This rental repair is not ready to close.',409);job.receipt='accepted';job.data.handover={method:'repair_team',receiver:d.actorKey(actor),at:new Date().toISOString()};break;
   case 'delegate':{
    office();if(job.company==='EXTERNAL')throw d.fail('External equipment must be received through the customer confirmation link.');
    const type=d.choice(input.recipientType,['staff','driver'],'recipient type'),recipient=d.text(String(input.recipientId||''),'Recipient',100);
    const found=type==='driver'?await one('SELECT id FROM dispatch_drivers WHERE id::text=$1 AND active',[recipient]):await one("SELECT id FROM operators WHERE id::text=$1 AND active AND 'operator'=ANY(roles)",[recipient]);
    if(!found)throw d.fail('Choose an active driver or operator.');job.data.recipient=`${type}:${recipient}`;job.data.delegationReason=d.text(input.reason,'Reason');break;
   }
   case 'cancel':office();job.status='cancelled';job.data.cancellationReason=d.text(input.reason,'Cancellation reason');job.data.accountingReview=true;await notify('role:repair_office',job,'cancelled',`${job.number}: cancelled; review existing inspection charges`);break;
   case 'priority':d.requireAllowed(d.canViewCosts(actor)||d.canWorkshop(actor));job.priority=d.choice(input.priority,['normal','urgent'],'priority');break;
   case 'claim':tech();job.data.assignedTechnician=d.actorKey(actor);break;
   default:throw d.fail('Unknown repair action.');
  }
  await event(actor,job,input.action,{condition:job.condition,reason:input.reason||'',nextStep:job.data.nextStep||'',decision:input.decision||'',...['inspection_start','start_repair'].includes(input.action)?{performers:job.data.performers,startedAt:job.data.startedAt,startedBy:job.data.startedBy,phase:job.data.startedPhase}:{}});const saved=await save(job);return job.recordedWork?{...saved,recordedWork:job.recordedWork}:saved;
 }));
}
