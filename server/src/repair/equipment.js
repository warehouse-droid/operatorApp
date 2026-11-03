import * as d from '../../public/repair/domain.js';
import {vehicleRow} from './repository.js';

export async function correctEquipment(c,actor,job,input){
 const {query,one,event,notify,save}=c;
 d.requireAllowed(d.canViewCosts(actor)||d.canWorkshop(actor));
 if(d.isOther(job))throw d.fail('Address repairs cannot be changed into equipment repairs.');
 const reason=d.text(input.reason,'Equipment correction reason');
 const vehicle=vehicleRow(await one('SELECT * FROM repair_vehicles WHERE id=$1 AND active',[d.uuid(input.vehicleId)]));
 if(!vehicle)throw d.fail('Choose a registered, active vehicle or machine.',404);
 if(vehicle.company!==job.company||vehicle.customerId!==job.data.vehicle.customerId)throw d.fail('Equipment correction must keep the same company and billing customer. Ask the office to review the account.',409);
 const type=d.choice(input.equipmentType,d.EQUIPMENT_TYPES.filter(value=>value!=='unknown'),'confirmed equipment type');
 const yardId=input.yardId?d.integer(Number(input.yardId),'Responsible yard',1):null;
 if(['MBT','MBBS'].includes(job.company)&&['forklift','loader'].includes(type)&&!yardId)throw d.fail('Choose the responsible yard for this machine.');
 const postings=(await query('SELECT id,state,attempt FROM repair_postings WHERE request_id=$1 ORDER BY id FOR UPDATE',[job.requestId||job.id])).rows;
 if(postings.some(posting=>posting.state==='working'))throw d.fail('A NetSuite posting is in progress. Wait before correcting equipment.',409);
 const previous={vehicleId:job.vehicleId,equipmentType:job.data.equipmentType||'unknown',yardId:job.yardId,vehicle:job.data.vehicle};
 const changedAsset=job.vehicleId!==vehicle.id;
 const changedScope=changedAsset||previous.equipmentType!==type||Number(job.yardId||0)!==Number(yardId||0);
 if(changedAsset&&(job.data.worId||job.data.sosId||job.data.manualLinks||postings.some(posting=>posting.attempt>0||posting.state!=='pending'))){
  job.data.equipmentReconciliation=true;
  await query("UPDATE repair_postings SET state='attention',error='Equipment was corrected after posting was attempted. Office must reconcile the existing WOR/SOS before further posting.' WHERE request_id=$1 AND state<>'done'",[job.requestId||job.id]);
 }
 job.data.originalEquipment||={vehicleId:job.vehicleId,equipmentType:previous.equipmentType};
 if(changedScope){
  await query("UPDATE repair_quotes SET status='superseded',public_token_hash=NULL WHERE request_id=$1",[job.requestId||job.id]);
  await query("UPDATE repair_part_requests SET status='rejected' WHERE request_id=$1 AND status IN ('requested','approved')",[job.requestId||job.id]);
  delete job.data.quoteId;job.data.phase=changedAsset?'inspection':job.data.inspectionComplete?'quote_needed':'inspection';
  job.status=changedAsset?'re_inspect':'queuing';job.receipt='none';job.outcome='repaired';
  if(changedAsset){job.data.inspectionComplete=false;await query("UPDATE repair_work_entries SET data=jsonb_set(data,'{vehicleId}',to_jsonb($2::text)) WHERE request_id=$1 AND NOT data ? 'vehicleId'",[job.requestId||job.id,job.vehicleId]);}
 }
 const oldRecipient=d.quoteRecipient(job);
 job.vehicleId=vehicle.id;job.yardId=yardId;job.data.vehicle=vehicle;job.data.equipmentType=type;job.data.equipmentTypeConfirmed=true;
 const current={vehicleId:vehicle.id,equipmentType:type,yardId,vehicle};
 await event(actor,job,'equipment_corrected',{previous,current,reason});
 const recipients=new Set([`${job.requesterType}:${job.requesterId}`,'role:repair_office','role:repair_technician',oldRecipient,d.quoteRecipient(job)].filter(Boolean));
 for(const recipient of recipients)await notify(recipient,job,'equipment_corrected',`${job.number}: equipment confirmed as ${vehicle.plate||vehicle.alias} (${type}).${job.condition==='out_of_service'?' This equipment is out of service.':''}${changedScope?' Previous quotes need review.':''}`);
 return save(job);
}
