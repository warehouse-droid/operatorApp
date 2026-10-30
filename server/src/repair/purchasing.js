import {randomUUID} from 'node:crypto';
import * as d from '../../public/repair/domain.js';
import {date} from './repository.js';
export function attachPurchasing(c){
 const {api,query,one,raw,revision,mutable,command,event,notify,save,posting,requireApproved}=c;
 const office=actor=>d.requireAllowed(d.canViewCosts(actor));
 async function refreshPartsEta(job){
  job.data.eta=(await one("SELECT max(coalesce(p.data->>'eta',r.eta::text)) AS eta FROM repair_purchase_lines l JOIN repair_purchases p ON p.id=l.purchase_id LEFT JOIN repair_part_requests r ON r.id=l.part_request_id WHERE l.job_id=$1 AND l.received_milli<l.quantity_milli",[job.id])).eta;
 }
 c.refreshPartsEta=refreshPartsEta;
 function partsWritable(job){if(job.receipt==='pending')throw d.fail('Awaiting formal receipt. Reject the repair before changing parts or resuming work.',409);mutable(job);}
 api.partRequests=async actor=>{d.requireAllowed(d.canViewCosts(actor)||d.canWorkshop(actor));return (await query("SELECT p.*,(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'filename',a.filename,'mime_type',a.mime_type)),'[]'::jsonb) FROM repair_attachments a WHERE a.part_request_id=p.id) AS attachments,(SELECT coalesce(sum(l.quantity_milli),0) FROM repair_purchase_lines l WHERE l.part_request_id=p.id) AS ordered_milli,j.number,r.number AS request_number,v.plate,v.alias AS equipment_alias FROM repair_part_requests p JOIN repair_jobs j ON j.id=p.job_id JOIN repair_requests r ON r.id=p.request_id JOIN repair_vehicles v ON v.id=r.vehicle_id WHERE p.status IN ('requested','approved','ordered') ORDER BY p.created_at LIMIT 300")).rows;};
 async function incomingParts(id=null,parent=false){
  const rows=(await query(`SELECT l.id,l.purchase_id AS "purchaseId",l.part_request_id AS "partRequestId",coalesce(nullif(p.data->>'poNumber',''),p.number) AS "poNumber",p.data->>'eta' AS eta,l.job_id AS "jobId",j.request_id AS "requestId",j.number AS "jobNumber",r.number AS "requestNumber",l.part_id AS "partId",l.description,l.quantity_milli,l.received_milli,r.data->'vehicle'->>'alias' AS equipment
   FROM repair_purchase_lines l JOIN repair_purchases p ON p.id=l.purchase_id JOIN repair_jobs j ON j.id=l.job_id JOIN repair_requests r ON r.id=j.request_id
   WHERE l.category='job_part' AND ${id?(parent?'l.request_id=$1':'l.job_id=$1'):'l.received_milli<l.quantity_milli'} ORDER BY p.created_at,l.id`,id?[d.uuid(id)]:[])).rows;
  return rows.map(({quantity_milli,received_milli,...row})=>({...row,quantityMilli:Number(quantity_milli),receivedMilli:Number(received_milli)}));
 }
 c.incomingFor=incomingParts;
 api.incomingParts=async actor=>{d.requireAllowed(d.canWorkshop(actor)||d.canViewCosts(actor));return incomingParts();};
 api.parts=async()=> (await query('SELECT p.*,coalesce(sum(m.quantity_milli),0) AS on_hand FROM repair_parts p LEFT JOIN repair_stock_movements m ON m.part_id=p.id WHERE p.active GROUP BY p.id ORDER BY p.name')).rows.map(row=>({id:row.id,sku:row.sku,name:row.name,unit:row.unit,tracked:row.tracked,onHandMilli:Number(row.on_hand)}));
 api.savePart=async(actor,input)=>{office(actor);return one('INSERT INTO repair_parts(id,sku,name,unit,tracked) VALUES($1,$2,$3,$4,$5) RETURNING *',[randomUUID(),d.text(input.sku,'SKU',100),d.text(input.name,'Part name',200),d.text(input.unit||'each','Unit',30),input.tracked===true]);};
 api.requestParts=async(actor,id,input)=>{d.requireAllowed(d.canWorkshop(actor),'Repair Team raises parts requests. Office places a local PO directly.');return command(actor,`request_parts:${id}`,input,async()=>{
  const job=await raw(id,true);revision(job,input);partsWritable(job);const quote=input.quoteLineId?await requireApproved(job,d.text(input.quoteLineId,'Quote line',80)):null;
  if(input.partId&&!await one('SELECT id FROM repair_parts WHERE id=$1 AND active',[d.uuid(input.partId)]))throw d.fail('Part not found.',404);
  const result=await one('INSERT INTO repair_part_requests(id,request_id,quote_id,quote_line_id,part_id,description,quantity_milli,created_by,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[randomUUID(),job.requestId,quote?.id||null,input.quoteLineId||null,input.partId||null,d.text(input.description,'Part description'),d.quantity(input.quantity),d.actorKey(actor),job.id]);
  await refreshPartsEta(job);await save(job);await event(actor,job,'parts_requested',{partId:input.partId,description:input.description});await notify('role:repair_office',job,'purchase_request',`${job.number}: parts approval needed`);return result;
 });};
 api.approveParts=async(actor,id,input)=>{office(actor);return command(actor,`approve_parts:${id}`,input,async()=>{
  const row=await one('SELECT * FROM repair_part_requests WHERE id=$1 FOR UPDATE',[d.uuid(id)]);if(!row)throw d.fail('Parts request not found.',404);
  const job=await raw(row.job_id||row.request_id,true);mutable(job);if(!['requested','approved'].includes(row.status))throw d.fail('This parts request can no longer be changed.',409);
  const status=d.choice(input.status,['approved','rejected'],'parts decision');if(status==='approved'&&row.quote_id){const quote=await requireApproved(job,row.quote_line_id);if(quote.id!==row.quote_id)throw d.fail('Parts request refers to an earlier quote; request the part against the current quote.',409);}
  const eta=date(input.eta,true);const result=await one('UPDATE repair_part_requests SET status=$2,eta=$3,approved_by=$4 WHERE id=$1 RETURNING *',[id,status,eta,d.actorKey(actor)]);
  job.data.eta=eta;await save(job);await event(actor,job,'parts_decided',{id,status,eta});await notify('role:repair_technician',job,'parts',`${job.number}: parts ${status}${eta?`; ETA ${eta}`:''}`);return result;
 });};
 async function createPurchase(actor,input,order=null){
  if(!Array.isArray(input.lines)||!input.lines.length||input.lines.length>100)throw d.fail('Enter between 1 and 100 purchase lines.');
  const id=randomUUID();await query('INSERT INTO repair_purchases(id,vendor_id,invoice_ref,purchase_date,created_by,data,status) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,d.reference(input.vendorId),order?'':d.text(input.invoiceRef,'Supplier invoice number',100),date(input.purchaseDate),d.actorKey(actor),{vendorName:d.text(input.vendorName||'','Supplier name',300,false),...order},order?'ordered':'draft']);
  for(const originalLine of input.lines){const line={...originalLine};
   const category=d.choice(line.category,['general','job_part'],'purchase category'),qty=d.quantity(line.quantity);
   if(category==='general'&&(line.requestId||line.partId||line.partRequestId))throw d.fail('General expenses do not have job usage or stock records.');
   if(category==='job_part'){
    const request=line.partRequestId?await one('SELECT * FROM repair_part_requests WHERE id=$1 FOR UPDATE',[d.uuid(line.partRequestId)]):null;
    const job=await raw(line.jobId||request?.job_id||line.requestId,true);partsWritable(job);line.jobId=job.id;line.requestId=job.requestId;
    if(!request){
     if(!order)throw d.fail('Place a local purchase order from the repair job.',409);
     const quote=await requireApproved(job,line.quoteLineId||undefined);line.quoteId=quote.id;
     if(line.partId&&!await one('SELECT id FROM repair_parts WHERE id=$1 AND active',[d.uuid(line.partId)]))throw d.fail('Part not found.',404);
    }else{
     if(request.request_id!==job.requestId||request.job_id!==job.id||!(order?['requested','approved','ordered']:['approved','ordered']).includes(request.status)||String(request.part_id||'')!==String(line.partId||''))throw d.fail('An approved parts request matching this job and part is required.',409);
     const quote=await requireApproved(job,request.quote_line_id||undefined);if(request.quote_id&&quote.id!==request.quote_id)throw d.fail('Parts request refers to an earlier quote.',409);
     if(!order&&await one("SELECT p.id FROM repair_purchase_lines l JOIN repair_purchases p ON p.id=l.purchase_id WHERE l.part_request_id=$1 AND p.data ? 'poNumber' LIMIT 1",[request.id]))throw d.fail('Record the invoice on the existing local PO instead of creating another purchase.',409);
     const bought=Number((await one('SELECT coalesce(sum(quantity_milli),0) AS total FROM repair_purchase_lines WHERE part_request_id=$1',[request.id])).total);
     if(bought+qty>Number(request.quantity_milli)){
      if(order)throw d.fail('PO quantity exceeds the remaining requested quantity.',409);
      const part=line.partId&&await one('SELECT tracked FROM repair_parts WHERE id=$1',[line.partId]);if(!part?.tracked)throw d.fail('Surplus purchases require a stock-tracked part.');d.text(line.surplusReason,'Reason for surplus purchase');
     }
     await query("UPDATE repair_part_requests SET status='ordered',eta=coalesce($2::date,eta),approved_by=coalesce(approved_by,$3) WHERE id=$1",[request.id,order?.eta||null,d.actorKey(actor)]);
    }
    await event(actor,job,'purchase_recorded',{purchaseId:id});
   }
   await query('INSERT INTO repair_purchase_lines(id,purchase_id,request_id,part_request_id,part_id,category,description,quantity_milli,unit_minor,tax_bps,account_id,data,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[randomUUID(),id,line.requestId||null,line.partRequestId||null,line.partId||null,category,d.text(line.description,'Purchase description'),qty,d.money(line.unitPrice),d.integer(line.taxBps??1300,'Tax rate',0,10000),d.reference(line.accountId||'2211'),{surplusReason:d.text(line.surplusReason||'','Surplus reason',2000,false),quoteId:line.quoteId||null,quoteLineId:line.quoteLineId||null,...order?{orderedUnitMinor:d.money(line.unitPrice),orderedTaxBps:d.integer(line.taxBps??1300,'Tax rate',0,10000)}:{}},line.jobId||null]);
  }
  return api.getPurchase(actor,id);
 }
 c.createPurchase=createPurchase;c.partsWritable=partsWritable;c.moveStock=moveStock;
 api.purchase=async(actor,input)=>{office(actor);return command(actor,'purchase',input,()=>createPurchase(actor,input));};
 api.getPurchase=async(actor,id)=>{office(actor);const row=await one('SELECT * FROM repair_purchases WHERE id=$1',[d.uuid(id)]);if(!row)throw d.fail('Purchase not found.',404);
  const lines=(await query('SELECT * FROM repair_purchase_lines WHERE purchase_id=$1 ORDER BY id',[id])).rows.map(r=>({id:r.id,requestId:r.request_id,jobId:r.job_id,partRequestId:r.part_request_id,partId:r.part_id,category:r.category,description:r.description,quantityMilli:Number(r.quantity_milli),receivedMilli:Number(r.received_milli),unitMinor:Number(r.unit_minor),taxBps:r.tax_bps,accountId:r.account_id,...r.data}));
  const attachments=(await query('SELECT id,kind,filename,created_at FROM repair_attachments WHERE purchase_id=$1 ORDER BY created_at',[id])).rows;
  const postings=(await query('SELECT id,kind,state,error,result,created_at FROM repair_postings WHERE purchase_id=$1 ORDER BY created_at',[id])).rows;
  const result={id:row.id,number:row.number,vendorId:row.vendor_id,invoiceRef:row.invoice_ref,purchaseDate:row.purchase_date instanceof Date?row.purchase_date.toISOString().slice(0,10):String(row.purchase_date).slice(0,10),status:row.status,revision:row.revision,data:row.data,lines,attachments,postings};return {...result,billReady:api.manualBillBlockers?.(result).length===0,stage:row.data.poNumber?d.purchaseStage(result):null,billState:postings.find(p=>p.kind==='bill')?.state||null};
 };
 api.purchases=async actor=>{office(actor);const rows=(await query(`SELECT p.id,p.number,p.vendor_id,p.invoice_ref,p.purchase_date,p.status,p.data,
  (SELECT coalesce(sum(quantity_milli),0) FROM repair_purchase_lines WHERE purchase_id=p.id) AS ordered_qty,
  (SELECT coalesce(sum(received_milli),0) FROM repair_purchase_lines WHERE purchase_id=p.id) AS received_qty,
  (SELECT state FROM repair_postings WHERE purchase_id=p.id AND kind='bill' ORDER BY created_at DESC LIMIT 1) AS bill_state
  FROM repair_purchases p ORDER BY created_at DESC LIMIT 200`)).rows;
  return rows.map(({ordered_qty,received_qty,bill_state,...row})=>({...row,stage:row.data.poNumber?d.purchaseStage({data:row.data,invoiceRef:row.invoice_ref,lines:[{quantityMilli:Number(ordered_qty),receivedMilli:Number(received_qty)}],postings:bill_state?[{kind:'bill',state:bill_state}]:[]}):null,billState:bill_state}));
 };
 api.completePurchase=async(actor,id,input)=>{office(actor);return command(actor,`complete_purchase:${id}`,input,async()=>{
  const row=await one('SELECT * FROM repair_purchases WHERE id=$1 FOR UPDATE',[d.uuid(id)]);if(!row)throw d.fail('Purchase not found.',404);revision(row,input);
  if(row.status==='ordered'||!row.invoice_ref.trim())throw d.fail('Record the supplier invoice before completing the purchase.');
  if(row.data.poNumber&&Number((await one('SELECT count(*) FROM repair_purchase_lines WHERE purchase_id=$1 AND received_milli<quantity_milli',[id])).count))throw d.fail('Receive all PO parts through Repair Team before posting the Bill.',409);
  if(row.status==='completed')throw d.fail('This purchase is already completed.',409);
  const kinds=(await query('SELECT kind,mime_type FROM repair_attachments WHERE purchase_id=$1',[id])).rows;
  if(!kinds.some(r=>r.kind==='receipt')||!kinds.some(r=>r.kind==='purchase_photo'&&r.mime_type.startsWith('image/')))throw d.fail('Attach the original receipt and a purchase photo before completing the purchase.');
  await query("UPDATE repair_purchases SET status='completed',revision=revision+1 WHERE id=$1",[id]);await posting(null,'bill',{},id);await event(actor,null,'purchase_completed',{purchaseId:id});return api.getPurchase(actor,id);
 });};
 async function moveStock(actor,{partId,jobId=null,lineId=null,kind,qty,reason=''}){
  const part=await one('SELECT * FROM repair_parts WHERE id=$1 AND active FOR UPDATE',[d.uuid(partId)]);if(!part)throw d.fail('Part not found.',404);if(!part.tracked)return;
  const balance=Number((await one('SELECT coalesce(sum(quantity_milli),0) AS qty FROM repair_stock_movements WHERE part_id=$1',[partId])).qty);if(balance+qty<0)throw d.fail('Insufficient stock for this issue.',409);
  const job=jobId?await raw(jobId):null;await query('INSERT INTO repair_stock_movements(id,part_id,request_id,purchase_line_id,kind,quantity_milli,actor,reason,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),partId,job?.requestId||null,lineId,kind,qty,d.actorKey(actor),reason,jobId]);
  return {id:partId,onHandMilli:balance+qty};
 }
 api.receivePurchase=async(actor,id,lineId,input)=>{d.requireAllowed(d.canWorkshop(actor));return command(actor,`receive_purchase:${id}:${lineId}`,input,async()=>{
  const purchase=await one('SELECT * FROM repair_purchases WHERE id=$1 FOR UPDATE',[d.uuid(id)]);if(!purchase)throw d.fail('Purchase not found.',404);
  const line=await one('SELECT * FROM repair_purchase_lines WHERE id=$1 AND purchase_id=$2 FOR UPDATE',[d.uuid(lineId),d.uuid(id)]);if(!line)throw d.fail('Purchase line not found.',404);
  if(input.expectedReceivedMilli!==undefined&&d.integer(input.expectedReceivedMilli,'Previously received quantity')!==Number(line.received_milli))throw d.fail('The received quantity changed. Refresh before receiving more parts.',409);
  const qty=d.quantity(input.quantity);if(Number(line.received_milli)+qty>Number(line.quantity_milli))throw d.fail('Receipt exceeds the purchased quantity.',409);
  if(line.category==='general')throw d.fail('General expenses do not have a stock receipt.');
  const stock=line.part_id?await moveStock(actor,{partId:line.part_id,jobId:line.job_id,lineId,kind:'receipt',qty}):null;
  await query('UPDATE repair_purchase_lines SET received_milli=received_milli+$2 WHERE id=$1',[lineId,qty]);
  let partRequest=null;if(line.part_request_id){const received=Number((await one('SELECT sum(received_milli) AS qty FROM repair_purchase_lines WHERE part_request_id=$1',[line.part_request_id])).qty);
   partRequest=await one("UPDATE repair_part_requests SET status=CASE WHEN quantity_milli<=$2 THEN 'received' ELSE status END WHERE id=$1 RETURNING id,status",[line.part_request_id,received]);
  }
  await query('UPDATE repair_purchases SET revision=revision+1 WHERE id=$1',[id]);
  let job=await raw(line.job_id||line.request_id,true);
  if(!['completed','cancelled'].includes(job.status)&&job.receipt!=='accepted'&&job.receipt!=='pending'){
   const pending=await one("SELECT count(*) FROM repair_part_requests WHERE job_id=$1 AND status IN ('requested','approved','ordered')",[job.id]);
   if(job.status==='waiting_for_parts'&&!Number(pending.count))job.status=job.data.phase==='repair'?'in_progress':'queuing';
   await refreshPartsEta(job);job=await save(job);
  }
  const receipt={id,lineId,receivedMilli:Number(line.received_milli)+qty,quantityMilli:Number(line.quantity_milli),localReceipt:{partRequest,stock,job:{id:job.id,revision:job.revision,status:job.status,eta:job.data.eta}}};
  await event(actor,job,'parts_received',{purchaseId:id,partId:line.part_id,quantityMilli:qty});await notify('role:repair_office',job,'parts_received',`${job.number}: parts received by Repair Team`);return d.canViewCosts(actor)?{...await api.getPurchase(actor,id),...receipt}:receipt;
 });};
 api.usePart=async(actor,id,input)=>{d.requireAllowed(d.canWorkshop(actor)||d.canViewCosts(actor));return command(actor,`use_part:${id}`,input,async()=>{
  const job=await raw(id,true);revision(job,input);partsWritable(job);await requireApproved(job,input.quoteLineId?d.text(input.quoteLineId,'Quote line',80):undefined);
  const kind=d.choice(input.kind||'issue',['issue','return'],'parts movement'),qty=d.quantity(input.quantity),partId=d.uuid(input.partId);
  if(d.canViewCosts(actor)&&!d.canWorkshop(actor))d.text(input.reason,'Correction reason');
  if(kind==='return'){const used=Number((await one("SELECT coalesce(sum(CASE kind WHEN 'issue' THEN quantity_milli ELSE -quantity_milli END),0) AS qty FROM repair_part_usages WHERE job_id=$1 AND part_id=$2 AND quote_line_id IS NOT DISTINCT FROM $3",[id,partId,input.quoteLineId||null])).qty);if(qty>used)throw d.fail('Cannot return more parts than this job used.',409);}
  await moveStock(actor,{partId,jobId:id,kind,qty:kind==='issue'?-qty:qty,reason:input.reason||''});
  await query('INSERT INTO repair_part_usages(id,request_id,part_id,quote_line_id,kind,quantity_milli,description,actor,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),job.requestId,partId,input.quoteLineId||null,kind,qty,d.text(input.description||'','Description',2000,false),d.actorKey(actor),job.id]);
  await event(actor,job,`part_${kind}`,{partId,quantityMilli:qty,reason:input.reason||''});return save(job);
 });};
 api.adjustStock=async(actor,input)=>{office(actor);return command(actor,'adjust_stock',input,async()=>{
  const qty=d.quantity(input.quantity)*(input.direction==='remove'?-1:1);await moveStock(actor,{partId:input.partId,kind:'adjustment',qty,reason:d.text(input.reason,'Adjustment reason')});await event(actor,null,'stock_adjustment',{partId:input.partId,quantityMilli:qty,reason:input.reason});return {ok:true};
 });};
}
