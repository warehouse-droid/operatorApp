import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {fixture,startedAction} from './fixture.js';
import {query,closeDb} from '../../src/db.js';
after(closeDb);
test('HTTP intake, financial privacy, role approvals, secure original downloads and stale receipt',async()=>{
 const f=await fixture();try{
  assert.equal((await f.request('missing','/jobs')).status,401);
  const created=await f.request('driver','/jobs',{commandId:randomUUID(),vehicleId:f.vehicle,meter:'100',meterUnit:'km',defect:'Unsafe brakes',condition:'out_of_service'});assert.equal(created.status,200);const id=created.data.id;
  assert.equal(created.data.inspectionFeeMinor,undefined);assert.equal((await f.request('other',`/jobs/${id}`)).status,403);
  assert.equal((await f.request('driver','/settings')).status,403);assert.equal((await f.request('dispatcher','/purchases')).status,403);
  let job=await f.repo.get(f.actors.repair_technician,id);
  job=await startedAction(f.repo,f.actors.repair_technician,id,{commandId:randomUUID(),revision:job.revision,action:'inspection_complete',done:'Found worn brake pads'});
  const quote=await f.repo.quote(f.actors.repair_office,id,{commandId:randomUUID(),revision:job.revision,lines:[{id:'pad',kind:'part',description:'Brake pads',quantity:'1',unitPrice:'1000',itemId:'10555'}]});
  const decisions={commandId:randomUUID(),quoteId:quote.id,decisions:[{id:'pad',status:'approved'}]};assert.equal((await f.request('driver',`/jobs/${id}/decisions`,decisions)).status,403);
  assert.equal((await f.request('dispatcher',`/jobs/${id}/decisions`,decisions)).status,200);
  const redacted=(await f.request('driver',`/jobs/${id}`)).data;assert.equal(redacted.quote.lines[0].unitMinor,undefined);assert.equal(redacted.totals,undefined);
  const png=await sharp({create:{width:3,height:3,channels:3,background:'blue'}}).png().toBuffer();
  const response=await fetch(`${f.base}/api/repair/attachments?requestId=${id}&kind=handover&filename=evidence.png&mimeType=image%2Fpng`,{method:'POST',headers:{Authorization:'Bearer driver','Content-Type':'application/octet-stream'},body:png});assert.equal(response.status,200);const attachment=await response.json();
  const denied=await fetch(`${f.base}/api/repair/attachments/${attachment.id}`,{headers:{Authorization:'Bearer other'}});assert.equal(denied.status,403);
  const download=await fetch(`${f.base}/api/repair/attachments/${attachment.id}`,{headers:{Authorization:'Bearer driver'}});assert.deepEqual(Buffer.from(await download.arrayBuffer()),png);assert.match(download.headers.get('content-disposition'),/attachment/);
  const stored=(await query('SELECT sha256 FROM repair_attachments WHERE id=$1',[attachment.id])).rows[0];assert.equal(stored.sha256.length,64);
  const quotePdf=await fetch(`${f.base}/api/repair/jobs/${id}/pdf`,{headers:{Authorization:'Bearer dispatcher'}});assert.equal(quotePdf.status,200);assert.match(Buffer.from(await quotePdf.arrayBuffer()).subarray(0,8).toString(),/%PDF/);
 }finally{await f.close();}
});
test('simultaneous submissions replay one request; competing stale updates cannot overwrite condition',async()=>{
 const f=await fixture();try{
  const input={commandId:randomUUID(),vehicleId:f.vehicle,meter:'0',meterUnit:'km',defect:'Race test',condition:'can_operate'};
  const results=await Promise.all(Array.from({length:6},()=>f.repo.create(f.actors.driver,input)));assert.equal(new Set(results.map(r=>r.id)).size,1);
  const job=results[0];const changes=await Promise.allSettled([f.repo.action(f.actors.driver,job.id,{commandId:randomUUID(),revision:job.revision,action:'condition',condition:'out_of_service',reason:'Brakes failed'}),f.repo.action(f.actors.driver,job.id,{commandId:randomUUID(),revision:job.revision,action:'condition',condition:'can_operate',reason:'Conflicting stale update'})]);
  assert.equal(changes.filter(r=>r.status==='fulfilled').length,1);assert.equal(changes.find(r=>r.status==='rejected').reason.status,409);
 }finally{await f.close();}
});
test('supplier receipts stay private, completed expense purchases queue exactly one direct Bill',async()=>{
 const f=await fixture();try{
  const input={commandId:randomUUID(),vendorId:'12821',invoiceRef:randomUUID(),purchaseDate:'2026-10-26',lines:[{category:'general',description:'Workshop cleaning supplies',quantity:'2',unitPrice:'10.50',taxBps:1300,accountId:'2211'}]};
  const purchase=await f.repo.purchase(f.actors.repair_office,input);
  await assert.rejects(f.repo.completePurchase(f.actors.repair_office,purchase.id,{commandId:randomUUID(),revision:1}),/receipt/i);
  const png=await sharp({create:{width:3,height:3,channels:3,background:'white'}}).png().toBuffer();const pdf=Buffer.from('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF');let receiptId;
  for(const [kind,bytes,mime] of [['receipt',pdf,'application/pdf'],['purchase_photo',png,'image/png']]){
   const res=await fetch(`${f.base}/api/repair/attachments?purchaseId=${purchase.id}&kind=${kind}&filename=private-receipt&mimeType=${encodeURIComponent(mime)}`,{method:'POST',headers:{Authorization:'Bearer repair_office','Content-Type':'application/octet-stream'},body:bytes});assert.equal(res.status,200);if(kind==='receipt')receiptId=(await res.json()).id;
  }
  for(const role of ['driver','operator','dispatcher','yard_manager','mbr_sales','repair_technician'])assert.equal((await f.request(role,`/attachments/${receiptId}`)).status,403);
  const complete={commandId:randomUUID(),revision:1};await f.repo.completePurchase(f.actors.repair_office,purchase.id,complete);await f.repo.completePurchase(f.actors.repair_office,purchase.id,complete);
  assert.equal(Number((await query("SELECT count(*) FROM repair_postings WHERE purchase_id=$1 AND kind='bill'",[purchase.id])).rows[0].count),1);
  assert.equal(Number((await query('SELECT count(*) FROM repair_stock_movements WHERE purchase_line_id=ANY($1::uuid[])',[purchase.lines.map(l=>l.id)])).rows[0].count),0);
  const search=await f.request('repair_office',`/attachments?search=${input.invoiceRef}`);assert.equal(search.data.length,2);
 }finally{await f.close();}
});
test('concurrent issues on different repairs cannot overdraw the same part',async()=>{
 const f=await fixture();try{
  const jobs=[];
  for(let i=0;i<2;i++){
   let job=await f.repo.create(f.actors.driver,{commandId:randomUUID(),vehicleId:f.vehicle,meter:'1',meterUnit:'km',defect:'Shared stock test',condition:'can_operate'});
   job=await startedAction(f.repo,f.actors.repair_technician,job.id,{commandId:randomUUID(),revision:job.revision,action:'inspection_complete',done:'Diagnosis complete'});
   const quote=await f.repo.quote(f.actors.repair_office,job.id,{commandId:randomUUID(),revision:job.revision,lines:[{id:'pump',kind:'part',description:'Pump',quantity:'3',unitPrice:'100',itemId:'10555'}]});
   await f.repo.decide(f.actors.dispatcher,job.id,{commandId:randomUUID(),quoteId:quote.id,decisions:[{id:'pump',status:'approved'}]});jobs.push(await f.repo.get(f.actors.repair_technician,job.id));
  }
  const part=await f.repo.savePart(f.actors.repair_office,{sku:randomUUID(),name:'Shared pump',tracked:true});
  const request=await f.repo.requestParts(f.actors.repair_technician,jobs[0].id,{commandId:randomUUID(),revision:jobs[0].revision,quoteLineId:'pump',partId:part.id,description:'Pump',quantity:'3'});
  await f.repo.approveParts(f.actors.repair_office,request.id,{commandId:randomUUID(),status:'approved'});
  const purchase=await f.repo.purchase(f.actors.repair_office,{commandId:randomUUID(),vendorId:'12821',invoiceRef:randomUUID(),purchaseDate:'2026-10-26',lines:[{category:'job_part',partRequestId:request.id,requestId:jobs[0].id,partId:part.id,description:'Pump',quantity:'5',unitPrice:'100',accountId:'2211',surplusReason:'Two spares'}]});
  await f.repo.receivePurchase(f.actors.repair_technician,purchase.id,purchase.lines[0].id,{commandId:randomUUID(),quantity:'5'});jobs[0]=await f.repo.get(f.actors.repair_technician,jobs[0].id);
  const outcomes=await Promise.allSettled(jobs.map(job=>f.repo.usePart(f.actors.repair_technician,job.id,{commandId:randomUUID(),revision:job.revision,quoteLineId:'pump',partId:part.id,kind:'issue',quantity:'3'})));
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.match(outcomes.find(r=>r.status==='rejected').reason.message,/stock/i);assert.equal((await f.repo.parts()).find(p=>p.id===part.id).onHandMilli,2000);
 }finally{await f.close();}
});
