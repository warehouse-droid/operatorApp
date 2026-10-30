import {createHash,randomUUID} from 'node:crypto';
import {query as dbQuery,withTransaction} from '../db.js';
import * as d from '../../public/repair/domain.js';
import {createRepairJobs,workJobRow} from './jobs.js';
import {attachQuotes} from './quotes.js';
import {attachActions} from './actions.js';
import {attachPurchasing} from './purchasing.js';
import {attachPurchaseOrders} from './purchase-orders.js';
import {attachHandover} from './handover.js';
import {localPartsCommand,lockRepairScope,commandScope} from './locking.js';
import {attachManualPosting} from './manual-posting.js';
import {AUTO_QUOTE_APPROVER,quoteApprovalPolicy,updateQuoteApprovalPolicy,automaticQuoteCategory} from './quote-approval-policy.js';
export const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const requestRow=r=>r&&({id:r.id,number:r.number,vehicleId:r.vehicle_id,company:r.company,requesterType:r.requester_type,requesterId:r.requester_id,yardId:r.yard_id,status:r.status,condition:r.condition,priority:r.priority,receipt:r.receipt,outcome:r.outcome,inspectionFeeMinor:Number(r.inspection_fee_minor),inspectionTaxBps:r.inspection_tax_bps,revision:r.revision,data:r.data,createdAt:r.created_at,updatedAt:r.updated_at});
export const vehicleRow=r=>r&&({id:r.id,netsuiteId:r.netsuite_id?String(r.netsuite_id):null,machineId:r.machine_id&&String(r.machine_id),dispatchTruckId:r.dispatch_truck_id,company:r.company,customerId:r.customer_id,plate:r.plate,alias:r.alias,serial:r.serial,...r.data,equipmentType:r.data?.equipmentType||d.equipmentType(r.data?.netSuiteVehicleType)});
export function date(value,optional=false){if(optional&&!value)return null;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/u.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw d.fail('Enter a valid date.');return value;}
export function createRepairRepository({query=dbQuery,transaction=withTransaction}={}) {
 const api={};
 const one=async(sql,params)=>(await query(sql,params)).rows[0];
 const jobs=createRepairJobs({query,one,requestRow,notify,posting});
 const raw=jobs.raw;
 function revision(job,input){if(job.revision!==input.revision)throw d.fail('This repair changed. Refresh before saving; your input has not been applied.',409,'REPAIR_STALE');}
 function mutable(job){if(job.status==='cancelled'||job.status==='completed'||(job.receipt==='accepted'&&job.outcome==='repaired'))throw d.fail('This repair is closed.',409);}
 async function command(actor,kind,input,fn){
  d.uuid(input.commandId);const key=d.actorKey(actor),digest=hash(JSON.stringify(canonical({kind,input})));
  return transaction(async()=>{
   if(!localPartsCommand(kind))await query("SELECT pg_advisory_xact_lock(hashtext('dispatch_fleet_planning_mutation'))");
   await query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${key}:${input.commandId}`]);
   const old=await one('SELECT digest,result FROM repair_commands WHERE actor=$1 AND command_id=$2',[key,input.commandId]);
   if(old){if(old.digest!==digest)throw d.fail('This command was already saved with different content.',409);return old.result;}
   await lockRepairScope(query,commandScope(kind,input));
   const result=await fn();await query('INSERT INTO repair_commands(actor,command_id,kind,payload,digest,result) VALUES($1,$2,$3,$4,$5,$6)',[key,input.commandId,kind,input,digest,result]);return result;
  });
 }
 async function event(actor,job,kind,data={}){await query('INSERT INTO repair_events(request_id,actor,kind,data,job_id) VALUES($1,$2,$3,$4,$5)',[job?.requestId||job?.id||null,d.actorKey(actor),kind,data,job?.requestId?job.id:null]);}
 async function notify(recipient,job,kind,message){if(recipient)await query('INSERT INTO repair_notifications(id,recipient,request_id,kind,message) VALUES($1,$2,$3,$4,$5)',[randomUUID(),recipient,job?.requestId||job?.id||null,kind,message]);}
 const save=jobs.save;
 async function posting(job,kind,payload={},purchaseId=null){await query('INSERT INTO repair_postings(id,request_id,purchase_id,kind,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[randomUUID(),job?.requestId||job?.id||null,purchaseId,kind,payload]);}
 const currentQuote=job=>one('SELECT * FROM repair_quotes WHERE job_id=$1 ORDER BY version DESC LIMIT 1',[job.id]);
 const activeQuotes=async job=>(await query("SELECT * FROM repair_quotes WHERE job_id=$1 AND status<>'superseded' ORDER BY scope_number,version",[job.id])).rows;
 async function requireApproved(job,lineId){const quotes=await activeQuotes(job),quote=quotes.find(q=>q.status==='decided'&&q.lines.some(line=>line.decision==='approved'&&(!lineId||line.id===lineId)));if(!quote)throw d.fail('An approved quote line is required before repair work or parts purchases.',409);return quote;}
 function publicRequest(actor,job){const result=structuredClone(job);delete result.data.handoverAccess;if(!d.canViewCosts(actor)&&!d.canApprove(actor,job)){delete result.inspectionFeeMinor;delete result.inspectionTaxBps;}return result;}
 const c={api,query,one,transaction,jobs,raw,revision,mutable,command,event,notify,save,posting,currentQuote,activeQuotes,requireApproved,publicRequest,requestRow};
 attachHandover(c);
 api.settings=async actor=>{d.requireAllowed(d.canViewCosts(actor));const row=await one('SELECT * FROM repair_settings');return {...row.data,quoteAutoApproval:quoteApprovalPolicy(row.data.quoteAutoApproval),revision:row.revision};};
 api.configure=async(actor,input)=>{d.requireAllowed(d.canViewCosts(actor));return command(actor,'settings',input,async()=>{
  const row=await one('SELECT * FROM repair_settings FOR UPDATE');revision(row,input);const data={...row.data};
  if(input.quoteAutoApproval!==undefined){d.requireAllowed(d.has(actor,'admin'));data.quoteAutoApproval=updateQuoteApprovalPolicy(input.quoteAutoApproval,row.data.quoteAutoApproval);}
  if(input.inspectionFee!==undefined)data.inspectionFeeMinor=d.money(input.inspectionFee);
  if(input.taxBps!==undefined)data.taxBps=d.integer(input.taxBps,'Tax rate',0,10000);
  if(input.postingEnabled!==undefined||input.mappings){d.requireAllowed(d.has(actor,'admin'));if(input.postingEnabled!==undefined)data.postingEnabled=input.postingEnabled===true;
   if(input.mappings)for(const key of Object.keys(data.mappings)){if(input.mappings[key]!==undefined)data.mappings[key]=key==='mbbsCustomerId'&&!input.mappings[key]?'':d.reference(input.mappings[key]);}}
  await query('UPDATE repair_settings SET data=$1,revision=revision+1,updated_by=$2,updated_at=now()',[data,d.actorKey(actor)]);await event(actor,null,'settings_changed');
  if(input.quoteAutoApproval!==undefined)await event(actor,null,'quote_approval_policy_changed',{previous:quoteApprovalPolicy(row.data.quoteAutoApproval),current:data.quoteAutoApproval,settingsRevision:row.revision+1});
  return {...data,quoteAutoApproval:quoteApprovalPolicy(data.quoteAutoApproval),revision:row.revision+1};
 });};
 api.directoryMappings=async()=>(await one('SELECT data FROM repair_settings')).data.mappings;
 api.vehicles=async(actor,search='')=>{const company=d.has(actor,'driver')?'MBT':d.has(actor,'operator')&&!d.canViewCosts(actor)&&!d.canWorkshop(actor)?'MBBS':null;return (await query(`SELECT * FROM repair_vehicles WHERE active AND ($1::text IS NULL OR company=$1) AND (NOT $3 OR coalesce(data->>'equipmentType','unknown') IN ('unknown','forklift','loader')) AND concat_ws(' ',plate,alias,serial,data->>'netSuiteVehicleType',data->>'equipmentType',data->>'masterName',data->>'masterDisplayName',data->>'machineName',data->>'machineAlias',data->>'machineSerial',data->>'model',data->>'manufacturer') ILIKE $2 ORDER BY alias,plate LIMIT 200`,[company,`%${d.text(search,'Search',100,false)}%`,company==='MBBS'])).rows.map(vehicleRow);};
 api.create=async(actor,input)=>publicRequest(actor,await command(actor,'create',input,async()=>{
  d.validateIntake(input);
  const vehicle=vehicleRow(await one('SELECT * FROM repair_vehicles WHERE id=$1 AND active',[d.uuid(input.vehicleId)]));if(!vehicle)throw d.fail('Choose a registered vehicle.',404);if(!vehicle.customerId)throw d.fail('This equipment has no verified owner. Ask the office to update its NetSuite master.',409);
  d.requireAllowed(d.canViewCosts(actor)||(vehicle.company==='MBT'&&d.has(actor,'driver'))||(vehicle.company==='MBBS'&&d.has(actor,'operator')));
  const yardId=input.yardId?d.integer(Number(input.yardId),'Yard',1):null;
  if(vehicle.company==='MBBS'&&!yardId)throw d.fail('Choose the responsible yard.');
  if(vehicle.company==='MBBS'&&!d.canViewCosts(actor))d.requireAllowed((actor.operatorYardLocationIds||actor.yardLocationIds||[]).map(Number).includes(yardId));
  const settings=(await one('SELECT data FROM repair_settings')).data;
  const meter=String(input.meter??'');if(!/^\d{1,9}(?:\.\d{1,2})?$/u.test(meter))throw d.fail('Enter the odometer or hour meter reading.');
  const equipmentType=d.choice(input.equipmentType||vehicle.equipmentType,d.EQUIPMENT_TYPES,'equipment type');
  if(d.has(actor,'operator')&&!d.canViewCosts(actor)&&!d.canWorkshop(actor)){
   if(!['forklift','loader'].includes(equipmentType)||!['unknown','forklift','loader'].includes(vehicle.equipmentType))throw d.fail('Operators can report only forklifts and loaders.');
   if(input.meterUnit!=='hours')throw d.fail('Operator repairs use hour-meter readings in hours.');
  }
  const equipmentTypeConfirmed=equipmentType!=='unknown'&&equipmentType===vehicle.equipmentType;
  const data={vehicle,equipmentType,equipmentTypeConfirmed,originalEquipment:{vehicleId:vehicle.id,equipmentType},meter,meterUnit:d.choice(input.meterUnit,['km','hours'],'meter unit'),defect:d.text(input.defect,'Defect description'),inspectionComplete:false,phase:'inspection'};
  const job=requestRow(await one(`INSERT INTO repair_requests(id,vehicle_id,company,requester_type,requester_id,yard_id,condition,priority,inspection_fee_minor,inspection_tax_bps,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[randomUUID(),vehicle.id,vehicle.company,actor.role==='driver'?'driver':'staff',String(actor.id),yardId,d.choice(input.condition,d.CONDITIONS,'operating condition'),input.priority==='urgent'?'urgent':'normal',settings.inspectionFeeMinor,settings.taxBps,data]));
  await jobs.initialize(job);
  await event(actor,job,'created',{condition:job.condition});await posting(job,'inspection');await notify('role:repair_technician',job,'new',`${job.number}: new inspection`);await notify('role:repair_office',job,'new',`${job.number}: new repair request`);
  if(job.condition==='out_of_service')await notify(d.quoteRecipient(job)||'role:repair_office',job,'hold',`${job.number}: ${vehicle.plate||vehicle.alias} is out of service; review today's assignments.`);return raw(job.id);
 }));
 function project(actor,job,quotes,parts,incoming=[]){job.incomingParts=incoming;job.stage=d.workflowStage({...job,quotes,partRequests:parts});job.requestStatus=job.stage;job.partsStatus=d.partsStage({...job,quotes,partRequests:parts,incomingParts:incoming});return publicRequest(actor,job);}
 async function childViews(actor,parents){
  const rows=(await query(`SELECT j.*,(SELECT coalesce(jsonb_agg(jsonb_build_object('quantityMilli',l.quantity_milli,'receivedMilli',l.received_milli)),'[]'::jsonb) FROM repair_purchase_lines l JOIN repair_purchases po ON po.id=l.purchase_id WHERE l.job_id=j.id AND l.category='job_part') AS incoming_summary,(SELECT coalesce(jsonb_agg(jsonb_build_object('status',q.status,'hasApproved',EXISTS(SELECT 1 FROM jsonb_array_elements(q.lines) l WHERE l->>'decision'='approved'))),'[]'::jsonb) FROM repair_quotes q WHERE q.job_id=j.id AND q.status<>'superseded') AS quotes_summary,(SELECT coalesce(jsonb_agg(jsonb_build_object('status',p.status,'quantity_milli',p.quantity_milli,'ordered_milli',(SELECT coalesce(sum(l.quantity_milli),0) FROM repair_purchase_lines l WHERE l.part_request_id=p.id))),'[]'::jsonb) FROM repair_part_requests p WHERE p.job_id=j.id) AS parts_summary FROM repair_jobs j WHERE j.request_id=ANY($1::uuid[]) ORDER BY j.sequence`,[parents.map(p=>p.id)])).rows;
  return rows.map(row=>project(actor,workJobRow(parents.find(p=>p.id===row.request_id),row),row.quotes_summary,row.parts_summary,row.incoming_summary));
 }
 api.get=async(actor,id,{requestView=false}={})=>{
  const job=await raw(id);d.requireAllowed(d.canRead(actor,job));const result=publicRequest(actor,job),parent=requestRow(await one('SELECT * FROM repair_requests WHERE id=$1',[job.requestId]));
  const rows=await Promise.all([currentQuote(job),query('SELECT id,kind,filename,mime_type,byte_size,caption,created_at FROM repair_attachments WHERE job_id=$1 OR (job_id IS NULL AND request_id=$1) ORDER BY created_at',[id]),query('SELECT * FROM repair_work_entries WHERE job_id=$1 ORDER BY created_at',[id]),query(`SELECT p.*,(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'filename',a.filename,'mime_type',a.mime_type)),'[]'::jsonb) FROM repair_attachments a WHERE a.part_request_id=p.id) AS attachments,(SELECT coalesce(sum(quantity_milli),0) FROM repair_purchase_lines l WHERE l.part_request_id=p.id) AS ordered_milli FROM repair_part_requests p WHERE job_id=$1 ORDER BY created_at`,[id]),query('SELECT * FROM repair_part_usages WHERE job_id=$1 ORDER BY created_at',[id]),query('SELECT actor,kind,data,created_at FROM repair_events WHERE request_id=$1 AND (job_id=$2 OR job_id IS NULL) ORDER BY id',[job.requestId,id])]);
  const financial=d.canViewCosts(actor)||d.canApprove(actor,job),quotes=await activeQuotes(job),allQuotes=(await query("SELECT * FROM repair_quotes WHERE request_id=$1 AND status<>'superseded' ORDER BY scope_number,version",[job.requestId])).rows;
  const present=q=>q&&({id:q.id,jobId:q.job_id,requestId:q.request_id,version:q.version,scopeId:q.scope_id,scopeNumber:q.scope_number,scopeRevision:q.scope_revision,title:q.title,status:q.status,autoApproved:q.decided_by===AUTO_QUOTE_APPROVER,lines:q.lines.map(line=>financial?line:Object.fromEntries(Object.entries(line).filter(([key])=>!['unitMinor','amountMinor','taxMinor','taxBps'].includes(key))))});
  result.quote=present(rows[0]);result.quotes=quotes.map(present);if(financial&&result.quote)result.totals=d.totals(quotes.flatMap(q=>q.lines),job.sequence===1?job.inspectionFeeMinor:0,job.inspectionTaxBps);
  [result.attachments,result.work,result.partRequests,result.usages,result.history]=rows.slice(1).map(row=>row.rows);
  result.incomingParts=await c.incomingFor(id);Object.assign(result,project(actor,job,quotes,result.partRequests,result.incomingParts));
  result.workJobs=await childViews(actor,[parent]);result.issues=(await query('SELECT * FROM repair_issues WHERE request_id=$1 ORDER BY created_at',[parent.id])).rows;
  const allParts=(await query(`SELECT p.*,(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'filename',a.filename,'mime_type',a.mime_type)),'[]'::jsonb) FROM repair_attachments a WHERE a.part_request_id=p.id) AS attachments,(SELECT coalesce(sum(quantity_milli),0) FROM repair_purchase_lines l WHERE l.part_request_id=p.id) AS ordered_milli FROM repair_part_requests p WHERE request_id=$1`,[parent.id])).rows;
  result.request=project(actor,parent,allQuotes,allParts,await c.incomingFor(parent.id,true));if(financial)result.request.totals=d.totals(allQuotes.flatMap(q=>q.lines),parent.inspectionFeeMinor,parent.inspectionTaxBps);
  if(d.canViewCosts(actor))result.purchaseOrders=await api.jobPurchaseOrders(actor,id);
  result.permissions={office:d.canViewCosts(actor),technician:d.canWorkshop(actor),approve:d.canApprove(actor,job),condition:d.canChangeCondition(actor,job),receive:d.canReceive(actor,{...job,id:job.requestId})};
  if(d.canViewCosts(actor)){result.autoApproveQuote=Boolean(automaticQuoteCategory((await one('SELECT data FROM repair_settings')).data,job));result.postings=(await query('SELECT id,kind,state,error,result,created_at FROM repair_postings WHERE request_id=$1 ORDER BY created_at',[parent.id])).rows;result.postingStatus=await api.postingStatus(actor,id);}
  if(id===parent.id&&(requestView||d.has(actor,'driver','operator')&&!d.canViewCosts(actor)&&!d.canWorkshop(actor))){Object.assign(result,publicRequest(actor,result.request),{revision:job.revision});result.partRequests=allParts;result.work=(await query('SELECT * FROM repair_work_entries WHERE request_id=$1 ORDER BY created_at',[parent.id])).rows;result.attachments=(await query('SELECT id,kind,filename,mime_type,byte_size,caption,created_at FROM repair_attachments WHERE request_id=$1 ORDER BY created_at',[parent.id])).rows;}
  if(!d.canViewCosts(actor)){
   const stripCost=data=>Object.fromEntries(Object.entries(data||{}).filter(([key])=>key!=='hourlyCostMinor'));
   result.work=result.work.map(entry=>({...entry,data:stripCost(entry.data)}));
   result.history=result.history.map(entry=>entry.kind==='actual_labour_corrected'?{...entry,data:{...entry.data,previous:stripCost(entry.data.previous),current:stripCost(entry.data.current)}}:entry);
  }
  return result;
 };
 api.list=async(actor,filters={})=>{
  const all=d.canViewCosts(actor)||d.canWorkshop(actor)||d.has(actor,'dispatcher');const own=d.actorKey(actor);
  const rows=(await query(`SELECT *, (SELECT coalesce(jsonb_agg(jsonb_build_object('number',po.data->>'poNumber','stage',CASE WHEN po.data ? 'billId' THEN 'bill_posted' WHEN NOT EXISTS(SELECT 1 FROM repair_purchase_lines l WHERE l.purchase_id=po.id AND l.received_milli<l.quantity_milli) THEN CASE WHEN btrim(po.invoice_ref)<>'' THEN 'invoice_updated' ELSE 'parts_received' END ELSE 'po_placed' END)),'[]'::jsonb) FROM repair_purchases po WHERE po.data ? 'poNumber' AND EXISTS(SELECT 1 FROM repair_purchase_lines l WHERE l.purchase_id=po.id AND l.request_id=repair_requests.id)) AS purchase_summary, (SELECT coalesce(jsonb_agg(jsonb_build_object('quantityMilli',l.quantity_milli,'receivedMilli',l.received_milli)),'[]'::jsonb) FROM repair_purchase_lines l JOIN repair_purchases po ON po.id=l.purchase_id WHERE l.request_id=repair_requests.id AND l.category='job_part') AS incoming_summary, (SELECT coalesce(jsonb_agg(jsonb_build_object('status',q.status,'hasApproved',EXISTS(SELECT 1 FROM jsonb_array_elements(q.lines) l WHERE l->>'decision'='approved'))),'[]'::jsonb) FROM repair_quotes q WHERE q.request_id=repair_requests.id AND q.status<>'superseded') AS quote_summary, (SELECT coalesce(jsonb_agg(jsonb_build_object('status',p.status,'quantity_milli',p.quantity_milli,'ordered_milli',(SELECT coalesce(sum(l.quantity_milli),0) FROM repair_purchase_lines l WHERE l.part_request_id=p.id))),'[]'::jsonb) FROM repair_part_requests p WHERE p.request_id=repair_requests.id) AS parts_summary FROM repair_requests WHERE ($1 OR requester_type||':'||requester_id=$2 OR ($3 AND company='MBR') OR yard_id=ANY($4::bigint[])) AND (NOT $5 OR requester_type||':'||requester_id=$2) AND ($6::text IS NULL OR status=$6) AND concat_ws(' ',number,data->'vehicle'->>'plate',data->'vehicle'->>'alias',data->>'defect') ILIKE $7 AND (NOT $8 OR (status<>'cancelled' AND receipt<>'accepted')) ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END,updated_at DESC LIMIT 200`,[all,own,d.has(actor,'mbr_sales'),d.has(actor,'yard_manager')?(actor.yardLocationIds||[]):[],filters.mine===true,filters.status?d.choice(filters.status,d.STAGES,'status'):null,`%${d.text(filters.search||'','Search',100,false)}%`,filters.active===true])).rows;
  if(filters.workJobs===true)return (await childViews(actor,rows.map(requestRow))).filter(d.teamJobOpen);
  return rows.map(row=>{const job=requestRow(row);const view={...job,quotes:row.quote_summary,partRequests:row.parts_summary,incomingParts:row.incoming_summary};job.stage=d.workflowStage(view);job.requestStatus=job.stage;job.partsStatus=d.partsStage(view);if(d.canViewCosts(actor))job.purchaseOrders=row.purchase_summary;return publicRequest(actor,job);}).filter(job=>!filters.stage||job.stage===d.choice(filters.stage,d.WORKFLOW_STAGES,'stage'));
 };
 function recipients(actor){return [d.actorKey(actor),...['repair_office','repair_technician','dispatcher','mbr_sales'].filter(role=>d.has(actor,role)||role==='repair_office'&&d.has(actor,'admin')).map(role=>`role:${role}`),...(d.has(actor,'yard_manager')?(actor.yardLocationIds||[]).map(id=>`yard:${id}`):[])];}
 api.notifications=async actor=>(await query('SELECT id,request_id,kind,message,read_at,created_at FROM repair_notifications WHERE recipient=ANY($1) ORDER BY created_at DESC LIMIT 100',[recipients(actor)])).rows;
 api.readNotification=async(actor,id)=>{await query('UPDATE repair_notifications SET read_at=coalesce(read_at,now()) WHERE id=$1 AND recipient=ANY($2)',[d.uuid(id),recipients(actor)]);return {ok:true};};
 api.authorizeEvidence=async(actor,input)=>{
  if(input.purchaseId){d.requireAllowed(d.canViewCosts(actor));await api.getPurchase(actor,input.purchaseId);return null;}
  const job=await raw(input.requestId);
  d.requireAllowed((input.kind==='handover'&&d.canReceive(actor,{...job,id:job.requestId}))||(d.canRead(actor,job)&&(d.canViewCosts(actor)||d.canWorkshop(actor)||d.isOwner(actor,job))));
  if(input.kind==='part_request'||input.partRequestId){d.requireAllowed(d.canWorkshop(actor)||d.canViewCosts(actor));const part=await one('SELECT job_id FROM repair_part_requests WHERE id=$1',[d.uuid(input.partRequestId)]);if(input.kind!=='part_request'||!part||part.job_id!==job.id)throw d.fail('Choose the parts request from this repair job.',409);}
  if(input.kind==='work')d.requireJobStarted(job);
  if(actor.role==='repair_recipient'){await api.verifyHandoverActor(actor,job.requestId);if(job.receipt!=='pending')throw d.fail('This receipt is already confirmed.',409);}
  return job;
 };
 api.addAttachment=async(actor,input)=>{
  const job=await api.authorizeEvidence(actor,input);
  const kind=d.choice(input.kind,input.purchaseId?['receipt','purchase_photo']:['defect','work','handover','part_request'],'attachment type');
  return one('INSERT INTO repair_attachments(id,request_id,purchase_id,kind,filename,mime_type,byte_size,sha256,storage_key,caption,created_by,job_id,part_request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,filename,kind',[input.id||randomUUID(),job?.requestId||null,input.purchaseId||null,kind,d.text(input.filename,'Filename',200),input.mimeType,d.integer(input.byteSize,'File size',1,10485760),input.sha256,input.storageKey,d.text(input.caption||'','Caption',1000,false),d.actorKey(actor),job?.id||null,input.partRequestId||null]);
 };
 api.attachment=async(actor,id)=>{const row=await one('SELECT * FROM repair_attachments WHERE id=$1',[d.uuid(id)]);if(!row)throw d.fail('Attachment not found.',404);if(row.purchase_id)d.requireAllowed(d.canViewCosts(actor));else d.requireAllowed(d.canRead(actor,await raw(row.request_id)));return row;};
 api.searchAttachments=async(actor,filters={})=>{d.requireAllowed(d.canViewCosts(actor));return (await query(`SELECT a.id,a.request_id,a.purchase_id,a.kind,a.filename,a.caption,a.created_at,r.number AS request_number,p.number AS purchase_number FROM repair_attachments a LEFT JOIN repair_requests r ON r.id=a.request_id LEFT JOIN repair_purchases p ON p.id=a.purchase_id WHERE concat_ws(' ',a.filename,a.caption,a.kind,r.number,r.data->'vehicle'->>'plate',r.data->'vehicle'->>'alias',p.number,p.vendor_id,p.data->>'vendorName',p.invoice_ref,p.purchase_date::text,(SELECT string_agg(concat_ws(' ',l.description,part.sku,part.name,linked.number,linked.data->'vehicle'->>'plate',linked.data->'vehicle'->>'alias'),' ') FROM repair_purchase_lines l LEFT JOIN repair_parts part ON part.id=l.part_id LEFT JOIN repair_requests linked ON linked.id=l.request_id WHERE l.purchase_id=p.id)) ILIKE $1 ORDER BY a.created_at DESC LIMIT 200`,[`%${d.text(filters.search||'','Search',100,false)}%`])).rows;};
 api.searchRecords=async(actor,filters={})=>{
  d.requireAllowed(d.canViewCosts(actor));
  return (await query(`SELECT 'repair' AS kind,r.id,r.number,r.status,r.updated_at AS "updatedAt",
   concat_ws(' · ',nullif(r.data->'vehicle'->>'plate','#'),r.data->'vehicle'->>'alias') AS title,r.data->>'defect' AS description,
   (SELECT count(*)::integer FROM repair_attachments a WHERE a.request_id=r.id) AS "attachmentCount"
   FROM repair_requests r WHERE concat_ws(' ',r.number,r.data->'vehicle'->>'plate',r.data->'vehicle'->>'alias',r.data->'vehicle'->>'serial',r.data->>'defect',r.created_at::date::text) ILIKE $1
   UNION ALL
   SELECT 'purchase',p.id,coalesce(p.data->>'poNumber',p.number),p.status,p.created_at,coalesce(p.data->>'vendorName',p.vendor_id),concat_ws(' · ',p.invoice_ref,p.purchase_date::text),
   (SELECT count(*)::integer FROM repair_attachments a WHERE a.purchase_id=p.id)
   FROM repair_purchases p WHERE concat_ws(' ',p.number,p.data->>'poNumber',p.vendor_id,p.data->>'vendorName',p.invoice_ref,p.purchase_date::text,
    (SELECT string_agg(concat_ws(' ',l.description,part.name,part.sku,r.number),' ') FROM repair_purchase_lines l LEFT JOIN repair_parts part ON part.id=l.part_id LEFT JOIN repair_requests r ON r.id=l.request_id WHERE l.purchase_id=p.id)) ILIKE $1
   ORDER BY "updatedAt" DESC LIMIT 100`,[`%${d.text(filters.search||'','Search',100,false)}%`])).rows;
 };
 api.dismissIssue=async(actor,id,input)=>{d.requireAllowed(d.canViewCosts(actor));return command(actor,`dismiss_issue:${id}`,input,async()=>{const issue=await one('SELECT * FROM repair_issues WHERE id=$1 FOR UPDATE',[d.uuid(id)]);if(!issue||issue.status!=='reported')throw d.fail('This issue is already resolved.',409);const reason=d.text(input.reason,'Reason for no additional repair');await query("UPDATE repair_issues SET status='dismissed',reason=$2 WHERE id=$1",[id,reason]);await event(actor,await raw(issue.source_job_id),'issue_dismissed',{issueId:id,reason});await jobs.rollup(issue.request_id);return {ok:true};});};
 attachQuotes(c);attachActions(c);attachPurchasing(c);attachPurchaseOrders(c);attachManualPosting(c);return api;
}
