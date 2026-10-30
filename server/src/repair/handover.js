import {randomBytes} from 'node:crypto';
import * as d from '../../public/repair/domain.js';
import {hash,requestRow,vehicleRow} from './repository.js';

export function attachHandover(c){
 const {api,query,one,command,raw,revision,save,event,notify,transaction}=c;
 const scopeTypes={control:['forklift','loader'],dispatch:['truck']};
 function scopeAccess(actor,scope){d.choice(scope,Object.keys(scopeTypes),'assignment screen');d.requireAllowed(d.has(actor,'admin',scope==='control'?'yard_manager':'dispatcher'));return scopeTypes[scope];}
 const recipient=job=>job.data.recipient||`${job.requesterType}:${job.requesterId}`;
 async function people(scope){return (await query(scope==='control'?"SELECT id::text AS id,display_name AS name FROM operators WHERE active AND 'operator'=ANY(roles) ORDER BY display_name":"SELECT id::text AS id,name FROM dispatch_drivers WHERE active ORDER BY name")).rows;}
 api.equipmentAssignments=async(actor,scope)=>{
  const types=scopeAccess(actor,scope),staff=await people(scope);
  const equipment=(await query("SELECT * FROM repair_vehicles WHERE active AND company<>'EXTERNAL' ORDER BY alias,plate")).rows.map(vehicleRow);
  const requests=(await query("SELECT r.*,j.revision AS action_revision FROM repair_requests r JOIN repair_jobs j ON j.id=r.id WHERE r.vehicle_id=ANY($1::uuid[]) AND r.status<>'cancelled' AND r.receipt<>'accepted' AND r.company IN ('MBBS','MBT') AND r.data->>'equipmentType'=ANY($2::text[]) ORDER BY r.created_at DESC",[equipment.map(v=>v.id),types])).rows;
  return {people:staff,equipment:equipment.filter(v=>types.includes(v.equipmentType)||requests.some(r=>r.vehicle_id===v.id)).map(v=>({id:v.id,plate:v.plate,alias:v.alias,serial:v.serial,equipmentType:v.equipmentType,company:v.company,requests:requests.filter(r=>r.vehicle_id===v.id).map(r=>({id:r.id,number:r.number,revision:r.action_revision,status:r.status,receipt:r.receipt,condition:r.condition,recipient:recipient(requestRow(r))}))}))};
 };
 api.assignReceipt=async(actor,id,input)=>{
  const types=scopeAccess(actor,input.scope);
  return command(actor,`receipt-assignment:${id}`,input,async()=>{
   const source=await raw(id,true),job=source.requestId===source.id?source:await raw(source.requestId,true);revision(job,input);
   d.requireAllowed(['MBBS','MBT'].includes(job.company)&&types.includes(job.data.equipmentType));
   if(job.parentStatus==='cancelled'||job.receipt==='accepted')throw d.fail('This request is closed.',409);
   const person=(await people(input.scope)).find(p=>p.id===String(input.recipientId));if(!person)throw d.fail('Choose an active '+(input.scope==='control'?'Operator.':'Driver.'));
   const previous=recipient(job);job.data.recipient=`${input.scope==='control'?'staff':'driver'}:${person.id}`;
   job.data.delegationReason='Receipt assigned from '+input.scope;
   await event(actor,job,'receipt_assignment',{previous,recipient:job.data.recipient,equipmentId:job.vehicleId});
   const saved=await save(job);if(saved.receipt==='pending')await notify(job.data.recipient,job,'receipt_assigned',`${job.requestNumber}: equipment is ready for you to receive.`);
   return {id:job.requestId,revision:saved.revision,recipient:job.data.recipient};
  });
 };
 async function access(token,{receiptAction=false}={}){
  if(typeof token!=='string'||!/^[\w-]{43}$/u.test(token))throw d.fail('Confirmation link not found.',404);
  const row=await one("SELECT * FROM repair_requests WHERE data->'handoverAccess'->>'hash'=$1",[hash(token)]);
  if(!row)throw d.fail('Confirmation link not found.',404);
  const job=requestRow(row),link=job.data.handoverAccess;
  if(new Date(link.expiresAt)<=new Date())throw d.fail('This confirmation link has expired.',410);
  const available=job.status==='completed'&&['pending','accepted'].includes(job.receipt)||receiptAction&&job.status==='re_inspect'&&job.receipt==='rejected';
  if(job.company!=='EXTERNAL'||!available||link.completedAt!==job.data.completedAt)throw d.fail('Confirmation link not found.',404);
  return {job,actor:{id:'customer-'+hash(token),role:'repair_recipient',requestId:job.id,tokenHash:hash(token)}};
 }
 api.verifyHandoverActor=async(actor,id)=>{
  const row=await one('SELECT * FROM repair_requests WHERE id=$1',[d.uuid(id)]),link=row?.data?.handoverAccess;
  d.requireAllowed(actor.role==='repair_recipient'&&actor.requestId===id&&link?.hash===actor.tokenHash&&new Date(link.expiresAt)>new Date()&&link.completedAt===row.data.completedAt);
 };
 api.handoverLink=async(actor,id)=>{
  d.requireAllowed(d.canViewCosts(actor)||d.canWorkshop(actor));
  return transaction(async()=>{
   const source=await raw(id),job=await raw(source.requestId,true);
   if(job.company!=='EXTERNAL'||job.parentStatus!=='completed'||job.receipt!=='pending')throw d.fail('Complete every job before providing a customer confirmation link.',409);
   const token=randomBytes(32).toString('base64url'),link={hash:hash(token),expiresAt:new Date(Date.now()+30*86400000).toISOString(),completedAt:job.requestCompletedAt};
   await query("UPDATE repair_requests SET data=jsonb_set(data,'{handoverAccess}',$2::jsonb),revision=revision+1 WHERE id=$1",[job.requestId,link]);
   await event(actor,job,'customer_handover_link',{expiresAt:link.expiresAt});return {token,expiresAt:link.expiresAt};
  });
 };
 api.handoverView=async(actor,id)=>{
  const source=await raw(id),job=source.requestId===source.id?source:await raw(source.requestId);
  d.requireAllowed(d.canReceive(actor,{...job,id:job.requestId})||d.canViewCosts(actor)||d.canWorkshop(actor));
  if(actor.role==='repair_recipient')await api.verifyHandoverActor(actor,job.requestId);
  if(job.parentStatus!=='completed'||!['pending','accepted'].includes(job.receipt))throw d.fail('This request is not ready for receipt.',409);
  return {job:{id:job.requestId,number:job.requestNumber,equipment:job.data.vehicle.plate||job.data.vehicle.alias,defect:job.data.defect},revision:job.revision,receipt:job.receipt,completedAt:job.requestCompletedAt,work:(await query("SELECT data->>'done' AS done FROM repair_work_entries WHERE request_id=$1 AND phase='repair' ORDER BY created_at",[job.requestId])).rows};
 };
 api.receipts=async actor=>{
  const rows=(await query("SELECT * FROM repair_requests WHERE status='completed' AND receipt='pending' AND data->>'recipient'=$1 AND requester_type||':'||requester_id<>$1 ORDER BY updated_at DESC",[d.actorKey(actor)])).rows;
  return rows.map(requestRow).filter(job=>d.canReceive(actor,job)).map(job=>({id:job.id,number:job.number,equipment:job.data.vehicle.plate||job.data.vehicle.alias}));
 };
 api.publicHandover=async token=>{const {job,actor}=await access(token);return api.handoverView(actor,job.id);};
 api.handoverActor=async token=>(await access(token)).actor;
 api.receivePublic=async(token,input)=>{const {job,actor}=await access(token,{receiptAction:true});await api.action(actor,job.id,{...input,action:'receive'});return {ok:true,decision:input.decision};};
}
