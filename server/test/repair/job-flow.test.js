import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {createRepairRepository} from '../../src/repair/repository.js';
import * as d from '../../public/repair/domain.js';
import {fixture,startedAction} from './fixture.js';
import fc from 'fast-check';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
after(closeDb);
const repo=createRepairRepository();
const actor=role=>({id:role,role,roles:[role],yardLocationIds:[1]});
const office=actor('repair_office'),tech=actor('repair_technician'),driver=actor('driver'),dispatch=actor('dispatcher');
const cmd=revision=>({commandId:randomUUID(),revision});
const scenario=fn=>withTransaction(fn,{rollback:true});
async function create(){const id=randomUUID();await query("INSERT INTO repair_vehicles(id,netsuite_id,company,customer_id,alias,data) VALUES($1,$2,'MBT','7973','Flow truck',$3)",[id,Date.now()+Math.floor(Math.random()*1e6),{equipmentType:'truck'}]);return repo.create(driver,{...cmd(),vehicleId:id,meter:'10',meterUnit:'km',condition:'out_of_service',defect:'Broken pump'});}
async function approved(){let job=await create();job=await startedAction(repo,tech,job.id,{...cmd(job.revision),action:'inspection_complete',done:'Pump failed',nextStep:'Replace pump'});const q=await repo.quote(office,job.id,{...cmd(job.revision),lines:[{id:'pump',kind:'part',description:'Pump',quantity:'3',unitPrice:'100'}]});await repo.decide(dispatch,job.id,{...cmd(),quoteId:q.id,decisions:[{id:'pump',status:'approved'}]});return repo.get(office,job.id);}
async function part(){return repo.savePart(office,{name:'Flow pump',sku:randomUUID(),tracked:true});}
async function requested(){const job=await approved(),p=await part();const req=await repo.requestParts(tech,job.id,{...cmd(job.revision),quoteLineId:'pump',partId:p.id,description:'Pump',quantity:'3'});return {job:await repo.get(office,job.id),p,req};}
const order=(job,req,p)=>({...cmd(job.revision),vendorId:'12821',vendorName:'Test supplier',eta:'2026-12-01',purchaseDate:'2026-10-27',lines:[{partRequestId:req.id,quantity:'3',unitPrice:'80',taxBps:1300,partId:p.id}]});
test('separate request and parts stages preserve completed-until-received and declined safety hold',()=>{
 assert.equal(typeof d.workflowStage,'function');
 const job={status:'queuing',receipt:'none',data:{inspectionComplete:false}};
 assert.equal(d.workflowStage(job),'queue_for_inspection');job.data.inspectionComplete=true;job.data.phase='quote_needed';assert.equal(d.workflowStage(job),'wait_for_quote');
 job.quote={status:'pending'};assert.equal(d.workflowStage(job),'wait_for_approval');job.quote.status='decided';job.data.phase='approved';assert.equal(d.workflowStage(job),'queue_for_repair');
 job.partRequests=[{status:'requested'}];assert.equal(d.workflowStage(job),'queue_for_repair');assert.equal(d.partsStage(job),'wait_for_po');job.partRequests[0].status='ordered';assert.equal(d.workflowStage(job),'queue_for_repair');assert.equal(d.partsStage(job),'wait_for_parts');job.partRequests[0].status='received';assert.equal(d.workflowStage(job),'queue_for_repair');
 job.status='completed';job.receipt='pending';assert.equal(d.workflowStage(job),'completed');job.receipt='accepted';job.outcome='declined';job.condition='out_of_service';assert.equal(d.workflowStage(job),'closed');assert.equal(d.fleetBlocked([job]),true);
 job.receipt='rejected';job.status='re_inspect';assert.equal(d.workflowStage(job),'queue_for_inspection');
});
test('office places a local PO for Team requests and invoices the received stock record',()=>scenario(async()=>{
 const {job,p,req}=await requested();assert.equal(job.partsStatus,'wait_for_po');
 const input=order(job,req,p);await assert.rejects(repo.issuePurchaseOrder(tech,job.id,input),/access/i);
 const po=await repo.issuePurchaseOrder(office,job.id,input);assert.match(po.data.poNumber,/^PO-\d+$/);assert.equal(po.status,'ordered');assert.equal(po.invoiceRef,'');assert.equal(po.data.eta,'2026-12-01');
 assert.deepEqual(await repo.issuePurchaseOrder(office,job.id,input),po);assert.equal((await repo.get(tech,job.id)).partsStatus,'wait_for_parts');
 assert.equal((await repo.get(tech,job.id)).purchaseOrders,undefined,'technicians cannot read PO costs');assert.equal((await repo.list(tech)).find(x=>x.id===job.id).partsStatus,'wait_for_parts');
 assert.equal(Number((await query('SELECT count(*) FROM repair_postings WHERE purchase_id=$1',[po.id])).rows[0].count),0,'issuing a local PO never queues a Vendor Bill');
 await assert.rejects(repo.completePurchase(office,po.id,cmd(po.revision)),/invoice/i);
 await assert.rejects(repo.updatePurchaseOrderEta(office,po.id,{...cmd(po.revision+2),eta:'2026-12-02'}),/changed/i);
 const updated=await repo.updatePurchaseOrderEta(office,po.id,{...cmd(po.revision),eta:'2026-12-02'});assert.equal(updated.data.eta,'2026-12-02');
 const receipt={...cmd(),quantity:'3'};await repo.receivePurchase(tech,po.id,po.lines[0].id,receipt);await repo.receivePurchase(tech,po.id,po.lines[0].id,receipt);
 assert.equal((await repo.parts()).find(x=>x.id===p.id).onHandMilli,3000);assert.equal((await repo.get(tech,job.id)).stage,'queue_for_repair');
 const received=await repo.getPurchase(office,po.id);const invoice={...cmd(received.revision),invoiceRef:'INV-'+randomUUID(),purchaseDate:'2026-10-27',lines:[{id:po.lines[0].id,unitPrice:'85',taxBps:1300}]};
 const invoiced=await repo.recordPurchaseInvoice(office,po.id,invoice);assert.equal(invoiced.id,po.id);assert.equal(invoiced.lines[0].receivedMilli,3000);assert.equal(invoiced.lines[0].unitMinor,8500);assert.deepEqual(await repo.recordPurchaseInvoice(office,po.id,invoice),invoiced);
 await assert.rejects(repo.completePurchase(office,po.id,cmd(invoiced.revision)),/receipt.*photo/i);
 for(const kind of ['receipt','purchase_photo'])await repo.addAttachment(office,{purchaseId:po.id,kind,filename:kind+'.jpg',mimeType:'image/jpeg',byteSize:10,sha256:'test',storageKey:randomUUID()});
 const complete=await repo.completePurchase(office,po.id,cmd(invoiced.revision));assert.equal(complete.status,'completed');assert.equal((await repo.parts()).find(x=>x.id===p.id).onHandMilli,3000);assert.equal(Number((await query("SELECT count(*) FROM repair_postings WHERE purchase_id=$1 AND kind='bill'",[po.id])).rows[0].count),1);
}));
test('PO races, excess quantity, wrong scope and requester role cannot purchase parts',async()=>{
 const {job,p,req}=await requested();const input=order(job,req,p);
 await assert.rejects(repo.issuePurchaseOrder(driver,job.id,input),/access/i);
 await assert.rejects(repo.issuePurchaseOrder(office,job.id,{...input,commandId:randomUUID(),lines:[{...input.lines[0],quantity:'4',surplusReason:'Surplus is forbidden on local orders'}]}),/quantity|exceed|surplus/i);
 const other=await approved();await assert.rejects(repo.issuePurchaseOrder(office,other.id,{...input,...cmd(other.revision)}),/job|request/i);
 const results=await Promise.allSettled([repo.issuePurchaseOrder(office,job.id,input),repo.issuePurchaseOrder(office,job.id,{...input,commandId:randomUUID()})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const purchase=results.find(r=>r.status==='fulfilled').value;
 await assert.rejects(repo.purchase(office,{...cmd(),vendorId:'12821',invoiceRef:randomUUID(),purchaseDate:'2026-10-27',lines:[{...input.lines[0],category:'job_part',requestId:job.id,description:'Duplicate invoice'}]}),/local PO|existing purchase order/i);
 assert.equal(Number((await query('SELECT count(*) FROM repair_purchase_lines WHERE part_request_id=$1',[req.id])).rows[0].count),1);
 await assert.rejects(repo.receivePurchase(tech,purchase.id,purchase.lines[0].id,{...cmd(),quantity:'4'}),/exceeds/i);
});
test('editing issued and returned quantities conserves stock with audit, replay and stale guards',()=>scenario(async()=>{
 let job=await approved();const p=await part();await repo.adjustStock(office,{...cmd(),partId:p.id,quantity:'20',direction:'add',reason:'Opening stock'});
 job=await repo.usePart(tech,job.id,{...cmd(job.revision),partId:p.id,quantity:'5',quoteLineId:'pump',kind:'issue',description:'Initial issue'});
 job=await repo.get(office,job.id);const usage=job.usages[0];
 for(const qty of [3,7,4,9,2,6]){const change={...cmd(job.revision),quantity:String(qty),description:'Corrected count '+qty,reason:'Physical count'};await repo.editPartUsage(office,job.id,usage.id,change);await repo.editPartUsage(office,job.id,usage.id,change);job=await repo.get(office,job.id);assert.equal(Number(job.usages[0].quantity_milli),qty*1000);assert.equal((await repo.parts()).find(x=>x.id===p.id).onHandMilli,(20-qty)*1000);assert.ok(job.history.some(e=>e.kind==='part_usage_corrected'));}
 await assert.rejects(repo.editPartUsage(office,job.id,usage.id,{...cmd(job.revision-1),quantity:'1',reason:'Count'}),/changed/i);
 await assert.rejects(repo.editPartUsage(driver,job.id,usage.id,{...cmd(job.revision),quantity:'1',reason:'Count'}),/access/i);
 await assert.rejects(repo.editPartUsage(tech,job.id,usage.id,{...cmd(job.revision),quantity:'21',reason:'Count'}),/stock/i);
 job=await repo.usePart(tech,job.id,{...cmd(job.revision),partId:p.id,quantity:'2',quoteLineId:'pump',kind:'return'});job=await repo.get(office,job.id);
 await assert.rejects(repo.editPartUsage(tech,job.id,usage.id,{...cmd(job.revision),quantity:'1',reason:'Count'}),/return|used/i);
 const returned=job.usages.find(x=>x.kind==='return');await repo.editPartUsage(tech,job.id,returned.id,{...cmd(job.revision),quantity:'3',reason:'Count',description:'Third unused pump'});assert.equal((await repo.parts()).find(x=>x.id===p.id).onHandMilli,17000);
}));
test('register-during-intake validates first and retains separate stable master/request commands',async()=>{
 let registrations=0;const seen=[];const f=await fixture({directoryFactory:()=>({register:async(_actor,input)=>{registrations++;seen.push(input);return {vehicleId:f.vehicle};}})});
 try{const body={...cmd(),masterCommandId:randomUUID(),newEquipment:{recordType:'vehicle',company:'MBT',name:'New truck'},meter:'12',meterUnit:'km',defect:'Inspect brakes',condition:'out_of_service'};
 assert.equal((await f.request('repair_office','/jobs',{...body,defect:''})).status,400);assert.equal(registrations,0);
 assert.equal((await f.request('driver','/jobs',body)).status,403);assert.equal(registrations,0);
 const first=await f.request('repair_office','/jobs',body);assert.equal(first.status,200,JSON.stringify(first.data));assert.equal(first.data.vehicleId,f.vehicle);assert.equal(seen[0].commandId,body.masterCommandId);
 const again=await f.request('repair_office','/jobs',body);assert.equal(again.status,200);assert.equal(again.data.id,first.data.id);assert.ok(seen.every(x=>x.commandId===body.masterCommandId));
 assert.equal((await f.request('repair_office','/jobs',{...body,commandId:body.masterCommandId})).status,400);
 }finally{await f.close();}
});
test('partial local POs can cover the remaining requested quantity without overordering',()=>scenario(async()=>{
 const {job,p,req}=await requested(),input=order(job,req,p);input.lines[0].quantity='1';const first=await repo.issuePurchaseOrder(office,job.id,input);
 const pending=await repo.get(office,job.id);assert.equal(pending.partsStatus,'wait_for_po');
 const second=await repo.issuePurchaseOrder(office,job.id,{...input,...cmd(pending.revision),lines:[{...input.lines[0],quantity:'2'}]});assert.notEqual(first.id,second.id);assert.equal((await repo.get(office,job.id)).partsStatus,'wait_for_parts');
 await repo.receivePurchase(tech,first.id,first.lines[0].id,{...cmd(),quantity:'1'});assert.equal((await repo.get(office,job.id)).partsStatus,'wait_for_parts');await repo.receivePurchase(tech,second.id,second.lines[0].id,{...cmd(),quantity:'2'});assert.equal((await repo.get(office,job.id)).stage,'queue_for_repair');
}));

test('property: arbitrary issue corrections conserve opening stock and replay cannot move it twice',async()=>{
 await fc.assert(fc.asyncProperty(fc.array(fc.integer({min:1,max:20}),{minLength:2,maxLength:8}),async quantities=>scenario(async()=>{
  let job=await approved();const p=await part();await repo.adjustStock(office,{...cmd(),partId:p.id,quantity:'20',direction:'add',reason:'Opening balance'});
  job=await repo.usePart(tech,job.id,{...cmd(job.revision),partId:p.id,quantity:'1',quoteLineId:'pump',kind:'issue'});job=await repo.get(tech,job.id);const usage=job.usages[0];
  for(const quantity of quantities){const input={...cmd(job.revision),quantity:String(quantity),reason:'Physical recount',description:'Corrected usage'};await repo.editPartUsage(tech,job.id,usage.id,input);await repo.editPartUsage(tech,job.id,usage.id,input);job=await repo.get(tech,job.id);const stock=(await repo.parts()).find(x=>x.id===p.id).onHandMilli;assert.equal(stock+Number(job.usages[0].quantity_milli),20000);assert.equal(stock,(20-quantity)*1000);}
 })),{numRuns:12,seed:20261027});
});
test('local PO PDF is downloadable by office and hidden from workshop/requester accounts',async()=>{
 const f=await fixture();try{
  let job=await f.repo.create(f.actors.driver,{...cmd(),vehicleId:f.vehicle,meter:'1',meterUnit:'km',defect:'PDF job',condition:'can_operate'});job=await startedAction(f.repo,f.actors.repair_technician,job.id,{...cmd(job.revision),action:'inspection_complete',done:'Inspected'});
  const q=await f.repo.quote(f.actors.repair_office,job.id,{...cmd(job.revision),lines:[{id:'p',kind:'part',description:'PDF part',quantity:'1',unitPrice:'10'}]});await f.repo.decide(f.actors.dispatcher,job.id,{...cmd(),quoteId:q.id,decisions:[{id:'p',status:'approved'}]});job=await f.repo.get(f.actors.repair_office,job.id);
  const request=await f.repo.requestParts(f.actors.repair_technician,job.id,{...cmd(job.revision),quoteLineId:'p',description:'PDF part',quantity:'1'});job=await f.repo.get(f.actors.repair_office,job.id);
  const response=await f.request('repair_office',`/jobs/${job.id}/purchase-orders`,{...cmd(job.revision),vendorId:'12821',eta:'2026-12-01',purchaseDate:'2026-10-27',lines:[{partRequestId:request.id,quantity:'1',unitPrice:'10'}]});assert.equal(response.status,200);
  for(const role of ['repair_office','repair_technician','driver']){const pdf=await fetch(f.base+`/api/repair/purchases/${response.data.id}/po.pdf`,{headers:{Authorization:'Bearer '+role}});assert.equal(pdf.status,role==='repair_office'?200:403);if(pdf.status===200){assert.match(pdf.headers.get('content-type'),/application\/pdf/);assert.equal((await pdf.text()).slice(0,4),'%PDF');}}
 }finally{await f.close();}
});
test('one job retains independent POs across successive repair stages and ETAs',()=>scenario(async()=>{
 const {job,p,req}=await requested();let first=await repo.issuePurchaseOrder(office,job.id,order(job,req,p));await repo.receivePurchase(tech,first.id,first.lines[0].id,{...cmd(),quantity:'3'});
 let current=await repo.get(office,job.id);current=await repo.action(tech,job.id,{...cmd(current.revision),action:'start_repair'});
 const secondRequest=await repo.requestParts(tech,job.id,{...cmd(current.revision),quoteLineId:'pump',partId:p.id,description:'Additional pump during repair',quantity:'1'});current=await repo.get(office,job.id);assert.equal(current.partsStatus,'wait_for_po');assert.equal(current.purchaseOrders.length,1);
 let second=await repo.issuePurchaseOrder(office,job.id,{...order(current,secondRequest,p),vendorId:'12822',vendorName:'Second supplier',eta:'2026-12-10',lines:[{partRequestId:secondRequest.id,quantity:'1',unitPrice:'85'}]});
 assert.equal(second.data.jobNumber,job.number);assert.equal(second.data.jobId,job.id);
 first=await repo.getPurchase(office,first.id);await repo.updatePurchaseOrderEta(office,first.id,{...cmd(first.revision),eta:'2026-12-03'});
 current=await repo.get(office,job.id);assert.equal(current.data.eta,'2026-12-10');assert.equal(current.purchaseOrders.length,2);assert.equal(current.partsStatus,'wait_for_parts');assert.equal(current.purchaseOrders.find(x=>x.id===first.id).data.eta,'2026-12-03');assert.equal(current.purchaseOrders.find(x=>x.id===second.id).data.eta,'2026-12-10');
 second=await repo.getPurchase(office,second.id);await repo.receivePurchase(tech,second.id,second.lines[0].id,{...cmd(),quantity:'1'});current=await repo.get(office,job.id);assert.equal(current.stage,'queue_for_repair');assert.equal(current.purchaseOrders.length,2);assert.equal((await repo.parts()).find(x=>x.id===p.id).onHandMilli,4000);
}));
