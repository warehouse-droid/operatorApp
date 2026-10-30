import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,startedAction} from './fixture.js';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {createRepairWorker} from '../../src/repair/worker.js';
after(closeDb);
export const cmd=revision=>({commandId:randomUUID(),revision});
export async function approvedJob(f){
 let job=await f.repo.create(f.actors.driver,{...cmd(),vehicleId:f.vehicle,meter:'10',meterUnit:'km',defect:'Purchase flow pump',condition:'can_operate'});
 job=await startedAction(f.repo,f.actors.repair_technician,job.id,{...cmd(job.revision),action:'inspection_complete',done:'Pump needs replacing'});
 const quote=await f.repo.quote(f.actors.repair_office,job.id,{...cmd(job.revision),lines:[{id:'work',kind:'labor',description:'Repair pump',quantity:'1',unitPrice:'100'}]});
 await f.repo.decide(f.actors.dispatcher,job.id,{...cmd(),quoteId:quote.id,decisions:[{id:'work',status:'approved'}]});
 return f.repo.get(f.actors.repair_office,job.id);
}
export async function directPo(f,job,quantity='2'){
 const part=await f.repo.savePart(f.actors.repair_office,{sku:randomUUID(),name:'Purchased pump',tracked:true});
 const input={...cmd(job.revision),vendorId:'12821',vendorName:'Industrial supplier',purchaseDate:'2026-10-28',eta:'2026-12-01',lines:[{partId:part.id,description:'Replacement pump',quantity,unitPrice:'80',taxBps:1300}]};
 return {part,input,po:await f.repo.issuePurchaseOrder(f.actors.repair_office,job.id,input)};
}

test('office places a PO directly with no fabricated parts request and job-level parts status',async t=>{
 const f=await fixture();t.after(()=>f.close());const job=await approvedJob(f),{po,input}=await directPo(f,job);
 assert.match(po.data.poNumber,/^PO-/);assert.equal(po.stage,'po_placed');assert.equal(po.invoiceRef,'');assert.equal(po.lines[0].partRequestId,null);
 assert.equal(Number((await query('SELECT count(*) FROM repair_part_requests WHERE job_id=$1',[job.id])).rows[0].count),0);
 assert.deepEqual(await f.repo.issuePurchaseOrder(f.actors.repair_office,job.id,input),po);
 assert.equal((await f.repo.get(f.actors.repair_office,job.id)).partsStatus,'wait_for_parts');
 assert.equal((await f.repo.list(f.actors.driver,{mine:true})).find(r=>r.id===job.id).partsStatus,'wait_for_parts');
 assert.equal((await f.repo.list(f.actors.repair_technician,{workJobs:true})).find(r=>r.id===job.id).partsStatus,'wait_for_parts');
 assert.equal(Number((await query('SELECT count(*) FROM repair_postings WHERE purchase_id=$1',[po.id])).rows[0].count),0);
 await f.repo.action(f.actors.repair_technician,job.id,{...cmd((await f.repo.get(f.actors.repair_technician,job.id)).revision),action:'start_repair'});
 await assert.rejects(f.repo.action(f.actors.repair_technician,job.id,{...cmd((await f.repo.get(f.actors.repair_technician,job.id)).revision),action:'complete',done:'Too early'}),/parts|receive/i);
});

test('four PO steps enforce Team receipt, invoice order and one direct NetSuite Bill',()=>withTransaction(async()=>{
 const f=await fixture();try{
  await query('DELETE FROM repair_postings');const job=await approvedJob(f),{po,part}=await directPo(f,job);
  const invoice=revision=>({...cmd(revision),invoiceRef:'INV-'+randomUUID(),purchaseDate:'2026-10-28',lines:[{id:po.lines[0].id,unitPrice:'85',taxBps:1300}]});
  await assert.rejects(f.repo.recordPurchaseInvoice(f.actors.repair_office,po.id,invoice(po.revision)),/receive/i);
  await assert.rejects(f.repo.receivePurchase(f.actors.repair_office,po.id,po.lines[0].id,{...cmd(),quantity:'1'}),/access/i);
  const partial={...cmd(),quantity:'1',expectedReceivedMilli:0};const safe=await f.repo.receivePurchase(f.actors.repair_technician,po.id,po.lines[0].id,partial);
  assert.doesNotMatch(JSON.stringify(safe),/unitMinor|unit_minor|invoiceRef|vendorId/);await f.repo.receivePurchase(f.actors.repair_technician,po.id,po.lines[0].id,partial);
  assert.equal((await f.repo.parts()).find(p=>p.id===part.id).onHandMilli,1000);assert.equal((await f.repo.getPurchase(f.actors.repair_office,po.id)).stage,'po_placed');
  await assert.rejects(f.repo.receivePurchase(f.actors.repair_technician,po.id,po.lines[0].id,{...cmd(),quantity:'1',expectedReceivedMilli:0}),/changed|refresh/i);
  await assert.rejects(f.repo.recordPurchaseInvoice(f.actors.repair_office,po.id,invoice((await f.repo.getPurchase(f.actors.repair_office,po.id)).revision)),/receive/i);
  await f.repo.receivePurchase(f.actors.repair_technician,po.id,po.lines[0].id,{...cmd(),quantity:'1',expectedReceivedMilli:1000});
  let current=await f.repo.getPurchase(f.actors.repair_office,po.id);assert.equal(current.stage,'parts_received');
  const input=invoice(current.revision);current=await f.repo.recordPurchaseInvoice(f.actors.repair_office,po.id,input);assert.equal(current.stage,'invoice_updated');assert.equal(current.lines[0].orderedUnitMinor,8000);assert.equal(current.lines[0].orderedTaxBps,1300);assert.equal(current.lines[0].unitMinor,8500);assert.deepEqual(await f.repo.recordPurchaseInvoice(f.actors.repair_office,po.id,input),current);
  await assert.rejects(f.repo.completePurchase(f.actors.repair_office,po.id,cmd(current.revision)),/receipt.*photo|invoice.*photo/i);
  for(const kind of ['receipt','purchase_photo'])await f.repo.addAttachment(f.actors.repair_office,{purchaseId:po.id,kind,filename:'invoice-test.jpg',mimeType:'image/jpeg',byteSize:1,sha256:'test',storageKey:randomUUID()});
  const post=cmd(current.revision);current=await f.repo.completePurchase(f.actors.repair_office,po.id,post);assert.equal(current.stage,'invoice_updated');assert.equal(current.billState,'pending');await f.repo.completePurchase(f.actors.repair_office,po.id,post);
  assert.equal(Number((await query("SELECT count(*) FROM repair_postings WHERE purchase_id=$1 AND kind='bill'",[po.id])).rows[0].count),1);
  await query("DELETE FROM repair_postings WHERE kind<>'bill'");await query("UPDATE repair_settings SET data=jsonb_set(data,'{postingEnabled}','true')");const calls=[];
  const worker=createRepairWorker({repo:f.repo,enabled:()=>true,adapter:{bill:async purchase=>{assert.equal(purchase.lines[0].unitMinor,8500);assert.equal(purchase.lines[0].orderedUnitMinor,8000);calls.push(purchase.id);return {billId:'777',billRef:'BILL-777'};}}});
  assert.equal((await worker.tick()).state,'done');assert.equal((await worker.tick()).idle,true);assert.deepEqual(calls,[po.id]);
  current=await f.repo.getPurchase(f.actors.repair_office,po.id);assert.equal(current.stage,'bill_posted');assert.equal((await f.repo.parts()).find(p=>p.id===part.id).onHandMilli,2000);
 }finally{await f.close();}
},{rollback:true}));

test('incoming parts are visible and receivable by Team without invoice or PO costs',async t=>{
 const f=await fixture();t.after(()=>f.close());const job=await approvedJob(f),{po}=await directPo(f,job);
 const response=await fetch(f.base+'/api/repair/incoming-parts',{headers:{Authorization:'Bearer repair_technician'}});assert.equal(response.status,200);const rows=await response.json();
 const line=rows.find(r=>r.purchaseId===po.id);assert.equal(line.jobId,job.id);assert.equal(line.poNumber,po.data.poNumber);assert.equal(line.quantityMilli,2000);
 assert.doesNotMatch(JSON.stringify(line),/unitMinor|unit_minor|invoiceRef|invoice_ref|vendorId|vendor_id|taxBps/);
 for(const role of ['driver','operator'])assert.equal((await fetch(f.base+'/api/repair/incoming-parts',{headers:{Authorization:'Bearer '+role}})).status,403);
 assert.equal((await f.request('repair_technician',`/purchases/${po.id}`)).status,403);
 assert.equal((await f.request('repair_technician',`/purchases/${po.id}/invoice`,{...cmd(po.revision),invoiceRef:'test-forbidden'})).status,403);
 const receipt=await f.request('repair_technician',`/purchases/${po.id}/lines/${po.lines[0].id}/receive`,{...cmd(),quantity:'2',expectedReceivedMilli:0});assert.equal(receipt.status,200);assert.doesNotMatch(JSON.stringify(receipt.data),/unitMinor|invoiceRef/);
});

test('one Save applies job metadata atomically and preserves approvals on priority-only edits',async t=>{
 const f=await fixture();t.after(()=>f.close());let job=await approvedJob(f);const quoteId=job.quote.id;
 const input={...cmd(job.revision),action:'details',vehicleId:job.vehicleId,equipmentType:'truck',yardId:'',priority:'urgent',condition:'can_operate',reason:''};
 job=await f.repo.action(f.actors.repair_office,job.id,input);assert.equal(job.priority,'urgent');const view=await f.repo.get(f.actors.repair_office,job.id);assert.equal(view.quote.id,quoteId);assert.equal(view.quote.status,'decided');
 await assert.rejects(f.repo.action(f.actors.repair_office,job.id,{...input,...cmd(job.revision),priority:'normal',condition:'out_of_service'}),/reason/i);
 let current=await f.repo.get(f.actors.repair_office,job.id);assert.equal(current.priority,'urgent');assert.equal(current.condition,'can_operate');assert.equal(current.quote.status,'decided');
 current=await f.repo.action(f.actors.repair_office,job.id,{...input,...cmd(current.revision),priority:'normal',condition:'out_of_service',reason:'Unsafe pump'});assert.equal(current.priority,'normal');assert.equal(current.condition,'out_of_service');
 await assert.rejects(f.repo.action(f.actors.repair_office,job.id,{...input,...cmd(job.revision),condition:'can_operate'}),/changed|refresh/i);
 await assert.rejects(f.repo.action(f.actors.driver,job.id,{...input,...cmd(current.revision)}),/access/i);
});

test('combined Save corrects equipment and metadata together with one revision',async t=>{
 const f=await fixture();t.after(()=>f.close());let job=await approvedJob(f);const before=job.revision;
 job=await f.repo.action(f.actors.repair_office,job.id,{...cmd(before),action:'details',vehicleId:job.vehicleId,equipmentType:'forklift',yardId:'1',condition:'out_of_service',priority:'urgent',reason:'Verified this equipment is a forklift with unsafe hydraulics'});
 assert.equal(job.revision,before+1);assert.equal(job.priority,'urgent');assert.equal(job.condition,'out_of_service');assert.equal(job.data.equipmentType,'forklift');assert.equal(job.yardId,'1');
 const view=await f.repo.get(f.actors.repair_office,job.id);assert.equal(view.quote.status,'superseded');assert.equal(view.stage,'wait_for_quote');assert.equal(view.data.originalEquipment.equipmentType,'truck');assert.ok(view.history.some(e=>e.kind==='details_saved'));assert.ok(view.history.some(e=>e.kind==='equipment_corrected'));
});

test('parts requests can precede quotes and default parts usage has no scope or movement field',async t=>{
 const f=await fixture();t.after(()=>f.close());let job=await f.repo.create(f.actors.driver,{...cmd(),vehicleId:f.vehicle,meter:'1',meterUnit:'km',defect:'Inspect pump',condition:'can_operate'});
 const req=await f.repo.requestParts(f.actors.repair_technician,job.id,{...cmd(job.revision),description:'Inspecting pump seal',quantity:'1'});assert.equal(req.quote_id,null);assert.equal(req.quote_line_id,null);
 assert.ok((await f.repo.partRequests(f.actors.repair_office)).some(r=>r.id===req.id));
 await assert.rejects(f.repo.issuePurchaseOrder(f.actors.repair_office,job.id,{...cmd((await f.repo.get(f.actors.repair_office,job.id)).revision),vendorId:'12821',eta:'2026-12-01',purchaseDate:'2026-10-28',lines:[{partRequestId:req.id,quantity:'1',unitPrice:'1'}]}),/approved/i);
 job=await approvedJob(f);const part=await f.repo.savePart(f.actors.repair_office,{sku:randomUUID(),name:'Seal',tracked:true});await f.repo.adjustStock(f.actors.repair_office,{...cmd(),partId:part.id,direction:'add',quantity:'3',reason:'Opening test stock'});
 job=await f.repo.usePart(f.actors.repair_technician,job.id,{...cmd(job.revision),partId:part.id,quantity:'2',description:'Used seal on job'});const result=await f.repo.get(f.actors.repair_technician,job.id);assert.equal(result.usages[0].kind,'issue');assert.equal(result.usages[0].quote_line_id,null);assert.equal((await f.repo.parts()).find(p=>p.id===part.id).onHandMilli,1000);
});

test('parts request evidence cannot be attached to another job or relabelled as work',async t=>{
 const f=await fixture();t.after(()=>f.close());const jobs=[];for(let i=0;i<2;i++)jobs.push(await f.repo.create(f.actors.driver,{...cmd(),vehicleId:f.vehicle,meter:'1',meterUnit:'km',defect:'Photo boundary '+i,condition:'can_operate'}));
 const request=await f.repo.requestParts(f.actors.repair_technician,jobs[0].id,{...cmd(jobs[0].revision),description:'Photo boundary seal',quantity:'1'});
 for(const [job,kind] of [[jobs[1],'part_request'],[jobs[0],'work']]){
  const input={requestId:job.id,partRequestId:request.id,kind,filename:'boundary.png',mimeType:'image/png'};
  await assert.rejects(f.repo.authorizeEvidence(f.actors.repair_technician,input),/parts request from this repair job/i);
  const response=await fetch(f.base+'/api/repair/attachments?'+new URLSearchParams(input),{method:'POST',headers:{Authorization:'Bearer repair_technician','Content-Type':'application/octet-stream'},body:Buffer.from('not stored')});assert.equal(response.status,409);
 }
 assert.equal(Number((await query('SELECT count(*) FROM repair_attachments WHERE part_request_id=$1',[request.id])).rows[0].count),0);
 await assert.rejects(f.repo.requestParts(f.actors.repair_office,jobs[0].id,{...cmd((await f.repo.get(f.actors.repair_office,jobs[0].id)).revision),description:'Office must place PO',quantity:'1'}),/local PO/i);
});

test('Bill worker refuses an imported completed PO whose parts have not arrived',()=>withTransaction(async()=>{
 const f=await fixture();try{
  const {po}=await directPo(f,await approvedJob(f));await query('DELETE FROM repair_postings');await query("UPDATE repair_purchases SET status='completed',invoice_ref='IMPORTED-INVOICE' WHERE id=$1",[po.id]);await query("INSERT INTO repair_postings(id,purchase_id,kind) VALUES($1,$2,'bill')",[randomUUID(),po.id]);
  await query("UPDATE repair_settings SET data=jsonb_set(data,'{postingEnabled}','true')");let calls=0;const worker=createRepairWorker({repo:f.repo,enabled:()=>true,adapter:{bill:async()=>{calls++;return {billId:'must-not-post'};}}});
  const result=await worker.tick();assert.equal(result.state,'attention');assert.equal(calls,0);const saved=await f.repo.getPurchase(f.actors.repair_office,po.id);assert.equal(saved.stage,'po_placed');assert.equal(saved.billState,'attention');assert.match(saved.postings[0].error,/receive every PO part/i);
 }finally{await f.close();}
},{rollback:true}));
