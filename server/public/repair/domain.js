import {REPAIR_ADDRESSES,isOther} from './targets.js';
export {isOther};
/** @typedef {{id?:string|number,role?:string,roles?:string[],yardLocationIds?:(number|string)[],requestId?:string}} Actor */
/** @typedef {{id?:string,status:string,lines?:{decision:string}[],hasApproved?:boolean}} QuoteState */
/** @typedef {{id?:string,company?:string,requesterType?:string,requesterId?:string,yardId?:number|string|null,data?:{repairType?:string,address?:{label:string},recipient?:string,equipmentType?:string,equipmentTypeConfirmed?:boolean,inspectionComplete?:boolean,phase?:string,quoteNeeded?:boolean},condition?:string,status?:string,receipt?:string,outcome?:string,stage?:string,quote?:QuoteState|null,quotes?:QuoteState[],partsStatus?:string|null,partRequests?:{status:string,quantity_milli?:number|string,ordered_milli?:number|string}[],incomingParts?:{quantityMilli:number,receivedMilli:number}[]}} Job */
/** @typedef {{id:string,kind:string,description:string,itemId:string,quantityMilli:number,unitMinor:number,amountMinor:number,taxBps:number,taxMinor:number,decision:string,decisionNote?:string}} QuoteLine */
/** @typedef {{decision:string,amountMinor:number,taxMinor:number}} BillingLine */
export const STAGES = ['queuing','in_progress','waiting_for_parts','completed','re_inspect','cancelled'];
export const WORKFLOW_STAGES = ['queue_for_inspection','wait_for_quote','wait_for_approval','queue_for_repair','completed','closed'];
export const STAGE_LABELS = ['Queue for Inspection','Wait for Quote','Wait for Approval','Queue for Repair','Completed','Closed'];
export const PART_STAGES = ['not_requested','wait_for_po','wait_for_parts','ready','not_required'];
export const PART_LABELS = ['No parts requested','Wait for PO','Wait for Parts','Parts ready','No outstanding parts'];
/** @param {Job} job */
export function jobQuotes(job){return (job.quotes||[job.quote].filter(Boolean)).filter(q=>q&&q.status!=='superseded');}
/** @param {Job} job */
export function isRejectedJob(job){return job.outcome==='declined'&&['inspection_only','quote_rejected'].includes(job.data?.phase||'');}
/** @param {Job} job */
export function teamJobOpen(job){return !isRejectedJob(job)&&!['completed','cancelled'].includes(job.status||'')&&!['pending','accepted'].includes(job.receipt||'');}
/** @param {Job} job @param {string} [phase] */
export function jobStarted(job,phase=job.data?.inspectionComplete&&job.status!=='re_inspect'?'repair':'inspection'){return teamJobOpen(job)&&job.data?.phase===phase&&['in_progress','waiting_for_parts'].includes(job.status||'');}
/** @param {Job} job @param {string} [phase] */
export function requireJobStarted(job,phase){if(!jobStarted(job,phase))throw fail('Press Start Job before saving work, work photos or completing this phase.',409,'REPAIR_NOT_STARTED');}
/** @param {Job} job */
export function workflowStage(job) {
 if(job.receipt==='accepted'||job.status==='cancelled')return 'closed';
 if(job.status==='completed'||job.receipt==='pending')return 'completed';
 if(!job.data?.inspectionComplete||job.status==='re_inspect'||['inspection','re_inspect'].includes(job.data?.phase||''))return 'queue_for_inspection';
 const quotes=jobQuotes(job);
 if(job.data?.quoteNeeded)return 'wait_for_quote';
 if(quotes.some(q=>q?.status==='pending'))return 'wait_for_approval';
 if(!quotes.length||job.data?.phase==='quote_needed')return 'wait_for_quote';
 return 'queue_for_repair';
}
/** @param {Job} job */
export function partsStage(job){
 const parts=job.partRequests||[];
 if(parts.some(p=>['requested','approved'].includes(p.status)||(p.status==='ordered'&&Number(p.ordered_milli??p.quantity_milli)<Number(p.quantity_milli))))return 'wait_for_po';
 if(parts.some(p=>p.status==='ordered')||(job.incomingParts||[]).some(p=>p.receivedMilli<p.quantityMilli)||(!parts.length&&job.status==='waiting_for_parts'))return 'wait_for_parts';
 if(parts.some(p=>p.status==='received')||(job.incomingParts||[]).some(p=>p.receivedMilli>0))return 'ready';
 if(parts.length)return 'not_required';
 return jobQuotes(job).some(q=>q?.status==='decided'&&(q.hasApproved||q.lines?.some(l=>l.decision==='approved')))?'not_requested':null;
}
/** @param {Job} job */
export function stageLabel(job){return STAGE_LABELS[WORKFLOW_STAGES.indexOf(job.stage||workflowStage(job))]||'Queue for Inspection';}
/** @param {Job} job */
export function partsLabel(job){return PART_LABELS[PART_STAGES.indexOf(job.partsStatus||partsStage(job)||'')]||'';}
/** @param {{lines?:{quantityMilli:number,receivedMilli:number}[],invoiceRef?:string,data?:{billId?:string},postings?:{kind:string,state:string}[]}} purchase */
export function purchaseStage(purchase){
 if(purchase.data?.billId||purchase.postings?.some(p=>p.kind==='bill'&&p.state==='done'))return 'bill_posted';
 const lines=purchase.lines||[],received=Boolean(lines.length)&&lines.every(l=>l.receivedMilli>=l.quantityMilli);
 if(received&&purchase.invoiceRef?.trim())return 'invoice_updated';
 return received?'parts_received':'po_placed';
}
/** Validate before an external equipment registration can be attempted.
 * @param {{commandId?:unknown,meter?:unknown,meterUnit?:unknown,defect?:unknown,condition?:unknown,yardId?:unknown,equipmentType?:unknown,priority?:unknown,repairType?:unknown,addressChoice?:unknown,customAddress?:unknown,vehicleId?:unknown,newEquipment?:unknown}} input
 */
export function validateIntake(input){
 uuid(input.commandId);
 choice(input.repairType||'equipment',['equipment','other'],'repair type');
 if(input.repairType==='other'){if(input.vehicleId||input.newEquipment)throw fail('Others repairs use an address, not equipment registration.');repairAddress(input);text(input.defect,'Repair details');if(input.priority)choice(input.priority,['normal','urgent'],'priority');return;}
 if(!/^\d{1,9}(?:\.\d{1,2})?$/u.test(String(input.meter??'')))throw fail('Enter the odometer or hour meter reading.');
 choice(input.meterUnit,['km','hours'],'meter unit');text(input.defect,'Defect description');choice(input.condition,CONDITIONS,'operating condition');
 if(input.yardId)integer(Number(input.yardId),'Yard',1);
 if(input.equipmentType)choice(input.equipmentType,EQUIPMENT_TYPES,'equipment type');
 if(input.priority)choice(input.priority,['normal','urgent'],'priority');
}
export const CONDITIONS = ['can_operate','out_of_service'];
export const COMPANIES = ['MBT','MBBS','MBR','EXTERNAL'];
export const EQUIPMENT_TYPES = ['truck','forklift','loader','other','unknown'];
/** @param {{addressChoice?:unknown,customAddress?:unknown}} input */
export function repairAddress(input){
 const choice=String(input.addressChoice||'');
 if(choice==='custom')return {choice,label:text(input.customAddress,'Custom address',500),yardId:null};
 const address=REPAIR_ADDRESSES.find(row=>row.choice===choice);if(!address)throw fail('Choose a repair address.');return {...address};
}
/** @param {unknown} value */
export function equipmentType(value) {
 const name=typeof value==='string'?value.trim().toLowerCase().replace(/\s+/gu,' '):'';
 if(['truck','bin truck','cement truck','dump truck','flat truck','pickup truck'].includes(name))return 'truck';
 if(name==='forklift')return 'forklift';
 if(['loader','track loader','skid-steer loader','skid steer loader'].includes(name))return 'loader';
 return 'unknown';
}
/** @param {Job} job */
export function quoteRecipient(job) {
 if(isOther(job))return job.requesterType==='driver'?'role:dispatcher':job.yardId?`yard:${job.yardId}`:'role:repair_office';
 if(job.company==='MBR')return 'role:mbr_sales';
 if(job.company==='EXTERNAL')return 'role:repair_office';
 if(job.data?.equipmentTypeConfirmed!==true)return null;
 if(job.data.equipmentType==='truck')return 'role:dispatcher';
 if(['forklift','loader'].includes(job.data.equipmentType||'')&&job.yardId)return `yard:${job.yardId}`;
 return null;
}
export class RepairError extends Error {
 /** @param {string} message @param {number} [status] @param {string} [code] */
 constructor(message,status=400,code='REPAIR_INVALID') { super(message);this.status=status;this.code=code; }
}
/** @param {string} message @param {number} [status] @param {string} [code] */
export function fail(message,status=400,code='REPAIR_INVALID') { return new RepairError(message,status,code); }
/** @param {unknown} value @param {string} [label] @param {number} [maximum] @param {boolean} [required] */
export function text(value,label='Value',maximum=2000,required=true) {
 if(typeof value!=='string' || value.trim().length>maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw fail(`${label} is invalid.`);
 const result=value.trim();if(required&&!result) throw fail(`${label} is required.`);return result;
}
/** @template {string} T @param {unknown} value @param {T[]} values @param {string} label @returns {T} */
export function choice(value,values,label) { if(!values.includes(/** @type {T} */(value))) throw fail(`Choose a valid ${label}.`);return /** @type {T} */(value); }
/** @param {unknown} value @param {string} label @param {number} [min] @param {number} [max] @returns {number} */
export function integer(value,label,min=0,max=1_000_000_000_000) {
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max) throw fail(`${label} is outside the allowed range.`);return value;
}
/** @param {unknown} value @param {number} places @param {string} label @param {boolean} allowZero */
function decimal(value,places,label,allowZero) {
 const input=typeof value==='number'&&Number.isFinite(value)?String(value):value;
 if(typeof input!=='string'||!new RegExp(`^\\d{1,9}(?:\\.\\d{1,${places}})?$`,'u').test(input.trim())) throw fail(`Enter a valid ${label}.`);
 const [whole,fraction='']=input.trim().split('.');const result=Number(whole)*10**places+Number(fraction.padEnd(places,'0'));
 return integer(result,label,allowZero?0:1);
}
/** @param {unknown} value */
export function money(value) { return decimal(value,2,'amount with at most two decimal places',true); }
/** @param {unknown} value */
export function quantity(value) { return decimal(value,3,'positive quantity with at most three decimal places',false); }
/** @param {number} quantityMilli @param {number} unitMinor */
export function amount(quantityMilli,unitMinor) {
 return integer(Number((BigInt(quantityMilli)*BigInt(unitMinor)+500n)/1000n),'Line amount');
}
/** @param {number} amountMinor @param {number} bps */
export function tax(amountMinor,bps) { return integer(Number((BigInt(integer(amountMinor,'Tax base'))*BigInt(integer(bps,'Tax rate',0,10000))+5000n)/10000n),'Tax amount'); }
/** @param {unknown} input @returns {QuoteLine[]} */
export function quoteLines(input) {
 if(!Array.isArray(input)||!input.length||input.length>100) throw fail('Enter between 1 and 100 quote lines.');
 const seen=new Set();
 return input.map(row=>{
  if(!row||typeof row!=='object'||Array.isArray(row))throw fail('Each quote line must be an object.');
  const id=text(row.id,'Line identifier',80);if(!/^[A-Za-z0-9_-]+$/u.test(id)||['__proto__','constructor','prototype'].includes(id))throw fail('Invalid quote line identifier.');if(seen.has(id)) throw fail('Quote line identifiers must be unique.');seen.add(id);
  const quantityMilli=quantity(row.quantity),unitMinor=money(row.unitPrice),amountMinor=amount(quantityMilli,unitMinor);
  const taxBps=integer(row.taxBps??1300,'Tax rate',0,10000);
  return {id,kind:choice(row.kind,['labor','part'],'line type'),description:text(row.description,'Description'),
   itemId:reference(row.itemId||(row.kind==='labor'?'10650':'10555')),quantityMilli,unitMinor,amountMinor,taxBps,taxMinor:tax(amountMinor,taxBps),decision:'pending'};
 });
}
/** @param {unknown} value */
export function reference(value) { const v=String(value||'');if(!/^[1-9]\d{0,12}$/u.test(v)) throw fail('A valid NetSuite identifier is required.');return v; }
/** @param {unknown} value */
export function uuid(value) { if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) throw fail('A valid request identifier is required.');return value; }
/** @param {QuoteLine[]} lines @param {unknown} decisions @returns {QuoteLine[]} */
export function decideLines(lines,decisions) {
 if(!Array.isArray(decisions)||decisions.length!==lines.length) throw fail('Save one decision for every quote line.');
 const byId=new Map();for(const decision of decisions){
  if(!decision||typeof decision!=='object'||Array.isArray(decision))throw fail('Each quote decision must be an object.');
  if(byId.has(decision.id)||!lines.some(line=>line.id===decision.id)) throw fail('Quote decisions contain duplicate or unknown lines.');
  byId.set(decision.id,{decision:choice(decision.status,['approved','rejected'],'line decision'),decisionNote:text(decision.note||'','Decision note',1000,false)});
 }
 if(new Set([...byId.values()].map(value=>value.decision)).size!==1)throw fail('Accept or reject the entire quote. Mixed line decisions are not allowed.');
 return lines.map(line=>({...line,...byId.get(line.id)}));
}
/** @param {BillingLine[]} lines @param {number} feeMinor @param {number} [taxBps] @param {number} [billedInspectionMinor] */
export function totals(lines,feeMinor,taxBps=1300,billedInspectionMinor=0) {
 integer(feeMinor,'Inspection fee');integer(billedInspectionMinor,'Billed inspection');
 const approved=lines.filter(line=>line.decision==='approved');
 const repairMinor=integer(approved.reduce((sum,line)=>sum+line.amountMinor,0),'Repair total');
 const creditMinor=approved.length?feeMinor:0;
 const subtotalMinor=integer(feeMinor+repairMinor-creditMinor,'Subtotal');
 const taxMinor=approved.length?integer(approved.reduce((sum,line)=>sum+line.taxMinor,0),'Tax total'):tax(feeMinor,taxBps);
 return {inspectionMinor:feeMinor,repairMinor,creditMinor,subtotalMinor,taxMinor,totalMinor:integer(subtotalMinor+taxMinor,'Total'),remainingMinor:subtotalMinor-billedInspectionMinor};
}
/** @param {Actor|undefined|null} actor */
export function roles(actor) { return new Set([actor?.role,...(actor?.roles||[])].filter(Boolean)); }
/** @param {Actor|undefined|null} actor @param {...string} values */
export function has(actor,...values) { const granted=roles(actor);return values.some(value=>granted.has(value)); }
/** @param {Actor|undefined|null} actor */
export function actorKey(actor) { return `${actor?.role==='driver'?'driver':'staff'}:${String(actor?.id||'')}`; }
/** @param {Actor} actor @param {Job} job */
export function isOwner(actor,job) { return actorKey(actor)===`${job.requesterType}:${job.requesterId}`; }
/** @param {Actor} actor */
export function canViewCosts(actor) { return has(actor,'repair_office','admin'); }
/** @param {Actor} actor */
export function canWorkshop(actor) { return has(actor,'repair_technician'); }
/** @param {Actor} actor @param {Job} job */
export function canApprove(actor,job) {
 if(job.company==='MBR') return has(actor,'mbr_sales');
 if(job.company==='EXTERNAL')return actor?.role==='repair_customer'&&actor.requestId===job.id;
 const recipient=quoteRecipient(job);
 if(recipient==='role:repair_office'&&isOther(job))return canViewCosts(actor);
 if(recipient==='role:dispatcher')return has(actor,'dispatcher');
 if(recipient?.startsWith('yard:'))return has(actor,'yard_manager')&&(actor.yardLocationIds||[]).map(Number).includes(Number(job.yardId));
 return false;
}
/** @param {Actor} actor @param {Job} job */
export function canRead(actor,job) {
 if(canViewCosts(actor)||canWorkshop(actor)||has(actor,'dispatcher')||canApprove(actor,job)) return true;
 if(has(actor,'yard_manager')&&(actor.yardLocationIds||[]).map(Number).includes(Number(job.yardId))) return true;
 return isOwner(actor,job);
}
/** Receipt delegation grants only the handover view, never the full request.
 * @param {Actor} actor @param {Job} job */
export function canReceive(actor,job) {
 if(isOther(job))return actorKey(actor)===(job.data?.recipient||`${job.requesterType}:${job.requesterId}`);
 if(job.company==='EXTERNAL')return actor?.role==='repair_recipient'&&actor.requestId===job.id;
 if(job.company==='MBR')return false;
 const recipient=job.data?.recipient||`${job.requesterType}:${job.requesterId}`;
 const driver=job.data?.equipmentType==='truck'||job.company==='MBT'&&!['forklift','loader'].includes(job.data?.equipmentType||'');
 return actorKey(actor)===recipient&&(driver?actor.role==='driver':actor.role!=='driver'&&has(actor,'operator'));
}
/** @param {Actor} actor @param {Job} job */
export function canChangeCondition(actor,job) {
 return canViewCosts(actor)||canWorkshop(actor)||(isOwner(actor,job)&&has(actor,'driver','operator'));
}
/** @param {Job[]} jobs */
export function fleetBlocked(jobs) {
 return jobs.some(job=>job.condition==='out_of_service'&&job.status!=='cancelled'
  &&!(job.receipt==='accepted'&&job.outcome==='repaired'));
}
/** @param {boolean} allowed @param {string} [message] */
export function requireAllowed(allowed,message='You do not have access to this action.') {
 if(!allowed) throw fail(message,403,'REPAIR_FORBIDDEN');
}
