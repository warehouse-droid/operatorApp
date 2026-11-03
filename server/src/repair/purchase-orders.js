import * as d from '../../public/repair/domain.js';
import {date} from './repository.js';
export function attachPurchaseOrders(c){
 const {api,query,one,raw,revision,command,event,notify,save,requireApproved,createPurchase,partsWritable,moveStock,refreshPartsEta}=c;
 const office=actor=>d.requireAllowed(d.canViewCosts(actor));
 api.jobPurchaseOrders=async(actor,id)=>{office(actor);const ids=(await query("SELECT DISTINCT p.id,p.created_at FROM repair_purchases p JOIN repair_purchase_lines l ON l.purchase_id=p.id WHERE l.job_id=$1 AND p.data ? 'poNumber' ORDER BY p.created_at",[id])).rows;return Promise.all(ids.map(row=>api.getPurchase(actor,row.id)));};
 api.issuePurchaseOrder=async(actor,id,input)=>{office(actor);return command(actor,`issue_purchase_order:${id}`,input,async()=>{
  const job=await raw(id,true);revision(job,input);partsWritable(job);await requireApproved(job);
  const eta=date(input.eta),purchaseDate=date(input.purchaseDate);
  if(!Array.isArray(input.lines)||!input.lines.length||input.lines.length>100)throw d.fail('Enter between 1 and 100 purchase lines.');
  const seen=new Set(),lines=[];
  for(const line of input.lines){
   if(!line.partRequestId){lines.push({...line,category:'job_part',requestId:job.requestId,jobId:id,accountId:'2211'});continue;}
   const request=await one('SELECT * FROM repair_part_requests WHERE id=$1 FOR UPDATE',[d.uuid(line.partRequestId)]);
   if(!request||request.job_id!==id||!['requested','approved','ordered'].includes(request.status)||seen.has(request.id))throw d.fail('Choose distinct outstanding parts requests from this job.',409);
   seen.add(request.id);lines.push({...line,category:'job_part',requestId:job.requestId,jobId:id,partId:request.part_id,description:request.description,accountId:'2211'});
  }
  const number=(await one("SELECT 'PO-'||lpad(nextval('repair_local_po_number_seq')::text,7,'0') AS number")).number;
  const po=await createPurchase(actor,{...input,purchaseDate,lines},{poNumber:number,eta,jobId:id,jobNumber:job.number,requestId:job.requestId,requestNumber:job.requestNumber,equipment:[job.data.vehicle.plate,job.data.vehicle.alias].filter(v=>v&&v!=='#').join(' · ')});
  await refreshPartsEta(job);const saved=await save(job);po.localJob={id:saved.id,revision:saved.revision,status:saved.status,eta:saved.data.eta};
  await event(actor,job,'local_po_issued',{purchaseId:po.id,poNumber:number,eta});await notify('role:repair_technician',job,'parts_ordered',`${job.number}: ${number} issued; ETA ${eta}`);return po;
 });};
 async function localOrder(id,input){const row=await one('SELECT * FROM repair_purchases WHERE id=$1 FOR UPDATE',[d.uuid(id)]);if(!row?.data?.poNumber)throw d.fail('Local purchase order not found.',404);revision(row,input);return row;}
 api.updatePurchaseOrderEta=async(actor,id,input)=>{office(actor);return command(actor,`po_eta:${id}`,input,async()=>{
  const row=await localOrder(id,input),eta=date(input.eta);
  const linked=(await query('SELECT DISTINCT job_id FROM repair_purchase_lines WHERE purchase_id=$1',[id])).rows;
  await query("UPDATE repair_purchases SET data=jsonb_set(data,'{eta}',to_jsonb($2::text)),revision=revision+1 WHERE id=$1",[id,eta]);
  await query("UPDATE repair_part_requests SET eta=$2 WHERE id IN (SELECT part_request_id FROM repair_purchase_lines WHERE purchase_id=$1) AND status='ordered'",[id,eta]);
  for(const link of linked){const job=await raw(link.job_id,true);if(!['completed','cancelled'].includes(job.status)&&job.receipt!=='accepted'){await refreshPartsEta(job);await save(job);}await event(actor,job,'po_eta_changed',{purchaseId:id,poNumber:row.data.poNumber,previous:row.data.eta,eta});await notify('role:repair_technician',job,'parts_eta',`${job.number}: ${row.data.poNumber} ETA ${eta}`);}
  return api.getPurchase(actor,id);
 });};
 api.recordPurchaseInvoice=async(actor,id,input)=>{office(actor);return command(actor,`po_invoice:${id}`,input,async()=>{
  const row=await localOrder(id,input);if(row.status==='completed'||row.data.billId)throw d.fail('The Bill is queued or posted. Reconcile it before changing the invoice.',409);
  const invoiceRef=d.text(input.invoiceRef,'Supplier invoice number',100),purchaseDate=date(input.purchaseDate);
  const lines=(await query('SELECT * FROM repair_purchase_lines WHERE purchase_id=$1 ORDER BY id FOR UPDATE',[id])).rows;
  if(lines.some(l=>Number(l.received_milli)<Number(l.quantity_milli)))throw d.fail('Receive all PO parts through Repair Team before updating the invoice.',409);
  if(!Array.isArray(input.lines)||input.lines.length!==lines.length||new Set(input.lines.map(l=>l.id)).size!==lines.length)throw d.fail('Supply the invoice cost for each PO line.');
  for(const line of input.lines){if(!lines.some(l=>l.id===line.id))throw d.fail('Invoice line does not belong to this purchase order.');await query("UPDATE repair_purchase_lines SET data=jsonb_build_object('orderedUnitMinor',unit_minor,'orderedTaxBps',tax_bps)||data,unit_minor=$2,tax_bps=$3 WHERE id=$1",[line.id,d.money(line.unitPrice),d.integer(line.taxBps??1300,'Tax rate',0,10000)]);}
  await query("UPDATE repair_purchases SET invoice_ref=$2,purchase_date=$3,status='draft',revision=revision+1 WHERE id=$1",[id,invoiceRef,purchaseDate]);
  await event(actor,null,'po_invoice_recorded',{purchaseId:id,poNumber:row.data.poNumber,invoiceRef});return api.getPurchase(actor,id);
 });};
 api.editPartUsage=async(actor,id,usageId,input)=>{d.requireAllowed(d.canWorkshop(actor)||d.canViewCosts(actor));return command(actor,`edit_part_usage:${id}:${usageId}`,input,async()=>{
  const job=await raw(id,true);revision(job,input);partsWritable(job);
  const usage=await one('SELECT * FROM repair_part_usages WHERE id=$1 AND job_id=$2 FOR UPDATE',[d.uuid(usageId),id]);if(!usage)throw d.fail('Parts usage not found for this job.',404);
  await requireApproved(job,usage.quote_line_id);
  const qty=d.quantity(input.quantity),reason=d.text(input.reason,'Correction reason'),description=d.text(input.description||'','Description',2000,false);
  const technician=await c.usageTechnician(job,input.technicianId,usage.data?.technician),data={...usage.data,technician,...input.repairItemId?{repairItemId:d.reference(input.repairItemId)}:{}};
  const sign=usage.kind==='issue'?1:-1,delta=(Number(usage.quantity_milli)-qty)*sign;
  const net=Number((await one("SELECT coalesce(sum(CASE kind WHEN 'issue' THEN quantity_milli ELSE -quantity_milli END),0) AS qty FROM repair_part_usages WHERE job_id=$1 AND part_id=$2 AND quote_line_id IS NOT DISTINCT FROM $3",[id,usage.part_id,usage.quote_line_id])).qty);
  if(net-delta<0)throw d.fail('Cannot return more parts than this job used.',409);
  if(delta)await moveStock(actor,{partId:usage.part_id,jobId:id,kind:'adjustment',qty:delta,reason});
  await query('UPDATE repair_part_usages SET quantity_milli=$2,description=$3,data=$4 WHERE id=$1',[usageId,qty,description,data]);
  await event(actor,job,'part_usage_corrected',{usageId,kind:usage.kind,partId:usage.part_id,previousQuantityMilli:Number(usage.quantity_milli),quantityMilli:qty,previousDescription:usage.description,description,previousTechnician:usage.data?.technician||null,technician,previousRepairItemId:usage.data?.repairItemId||null,repairItemId:data.repairItemId||null,reason});return save(job);
 });};
}
