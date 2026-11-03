import {fail,reference} from '../../public/repair/domain.js';
const ref=id=>({id:reference(id)});
export function performingTechnicians(data){
 const people=data?.performers;
 if(!Array.isArray(people)||!people.length||people.length>3||new Set(people.map(p=>p.id)).size!==people.length)throw fail('Map the performing technicians before posting WOR.',409);
 for(const person of people)reference(person.id);return people;
}
export function worItem(lines,entry,kind){
 const accepted=lines.filter(line=>line.decision==='approved'&&line.kind===kind),id=entry.data?.repairItemId;
 const quoted=entry.quoteLineId||entry.data?.quoteLineId,linked=quoted&&accepted.find(line=>line.id===quoted);
 if(linked&&linked.jobId&&entry.job_id&&linked.jobId!==entry.job_id)throw fail('The repair item belongs to another job.',409);
 const choices=accepted.filter(line=>!line.jobId||!entry.job_id||line.jobId===entry.job_id);
 if(id){if(!choices.some(line=>line.itemId===id)&&!(kind==='part'&&!choices.length&&id==='10555'))throw fail('Choose a repair item from this job’s approved quote.',409);return ref(id);}
 if(linked)return ref(linked.itemId);
 const ids=[...new Set(choices.map(line=>line.itemId))];
 if(ids.length>1)throw fail('Choose the quote repair item for the actual work or parts before posting WOR.',409);
 return ref(ids[0]||(kind==='part'?'10555':'10650'));
}
export function worChildren(job,mapping,lines,usages,work){
 const children=work.map(entry=>{
  const people=performingTechnicians(entry.data),line=lines.find(l=>l.id===entry.data.quoteLineId),hours=Number(entry.data.hoursMilli||0)/1000;
  return {type:'customrecord246',payload:{externalId:`repair-${job.id}-work-${entry.id}`,custrecord209:entry.phase==='inspection'?ref(mapping.inspectionItemId):worItem(lines,entry,'labor'),custrecord148:entry.phase==='inspection'?'Inspection':line?.description||'Actual repair work',custrecord149:ref(people[0].id),custrecord214:people[1]?ref(people[1].id):null,custrecord215:people[2]?ref(people[2].id):null,custrecord152:hours,custrecord156:hours,custrecord157:Number(entry.data.hourlyCostMinor||0)/100,custrecord154:true,custrecord155:new Date(entry.created_at).toISOString().slice(0,10),custrecord153:[entry.data.diagnosis,entry.data.done,entry.data.nextStep].filter(Boolean).join('\n').slice(0,3900),custrecord212:`${people.map(p=>p.name).join(' / ')} · ${job.number}`}};
 });
 const parts=new Map();
 for(const entry of usages){
  const technician=entry.data?.technician;if(!technician?.id)throw fail('Map the Used by technician for every parts usage before posting WOR.',409);reference(technician.id);
  const item=worItem(lines,entry,'part'),key=JSON.stringify([entry.job_id,entry.partId||entry.description,technician.id,item.id]);
  if(!parts.has(key))parts.set(key,{entry,item,technician,issued:0,returned:0});const group=parts.get(key);group[entry.kind==='return'?'returned':'issued']+=Number(entry.quantityMilli);
 }
 for(const {entry,item,technician,issued,returned} of parts.values()){
  if(returned>issued)throw fail('Returned parts exceed the quantity used by this technician.',409);
  children.push({type:'customrecord247',payload:{externalId:`repair-${job.id}-usage-${entry.id}`,custrecord160:item,custrecord161:entry.description||entry.name||'Parts used',custrecord162:issued/1000,custrecord167:returned/1000,custrecord169:(issued-returned)/1000,custrecord163:entry.unitCostMinor/100,custrecord170:entry.unitCostMinor/100,custrecord165:ref(technician.id),custrecord166:new Date(entry.created_at||job.createdAt).toISOString().slice(0,10)}});
 }
 return children;
}
export function verifyWorChild(record,payload){
 for(const [key,value] of Object.entries(payload)){
  if(['externalId','custrecord148','custrecord161','custrecord212','custrecord153','custrecord154','custrecord155','custrecord166'].includes(key))continue;
  if(value===null){if(record[key]?.id)throw fail('WOR technician references could not be verified.',409,'REPAIR_REMOTE_VERIFY');}
  else if(typeof value==='object'){if(String(record[key]?.id)!==value.id)throw fail('WOR item or technician reference could not be verified.',409,'REPAIR_REMOTE_VERIFY');}
  else if(typeof value==='number'&&(!Number.isFinite(Number(record[key]??0))||Math.abs(Number(record[key]??0)-value)>1e-9))throw fail('WOR actual quantities or prices could not be verified.',409,'REPAIR_REMOTE_VERIFY');
 }
}
