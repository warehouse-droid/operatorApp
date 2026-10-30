import {partsStage} from './domain.js?v=20261029-quote-policy';
function patchJob(job,patch){if(job&&job.id===patch.id){job.revision=patch.revision;job.status=patch.status;job.data.eta=patch.eta;}}
function stages(state,jobId){
 const job=state.job?.id===jobId?state.job:state.jobs?.find(j=>j.id===jobId);if(!job)return;
 job.partsStatus=partsStage({...job,partRequests:job.partRequests||state.requests?.filter(r=>(r.job_id||r.request_id)===jobId)||[],incomingParts:job.incomingParts||state.incoming?.filter(l=>l.jobId===jobId)||[]});
 const child=state.job?.workJobs?.find(j=>j.id===jobId);if(child)child.partsStatus=job.partsStatus;
 if(state.job?.request){const values=(state.job.workJobs||[]).map(j=>j.partsStatus);state.job.request.partsStatus=['wait_for_po','wait_for_parts','ready','not_required','not_requested'].find(status=>values.includes(status))||null;}
}
export function applyReceipt(state,result){
 const receipt=result.localReceipt;if(!receipt)return false;const update=line=>line.id===result.lineId?{...line,receivedMilli:result.receivedMilli}:line;
 if(state.incoming)state.incoming=state.incoming.map(update).filter(line=>line.receivedMilli<line.quantityMilli);
 if(state.job?.incomingParts)state.job.incomingParts=state.job.incomingParts.map(update);
 if(receipt.partRequest){const patch=r=>r.id===receipt.partRequest.id?{...r,...receipt.partRequest}:r;if(state.requests)state.requests=state.requests.map(patch).filter(r=>['requested','approved','ordered'].includes(r.status));if(state.job)state.job.partRequests=state.job.partRequests.map(patch);}
 if(receipt.stock){const part=state.parts?.find(p=>p.id===receipt.stock.id);if(part)part.onHandMilli=receipt.stock.onHandMilli;}
 patchJob(state.job,receipt.job);for(const job of state.jobs||[])patchJob(job,receipt.job);stages(state,receipt.job.id);return true;
}
export function applyPurchaseOrder(state,po){
 const job=state.job;if(!job||!po.localJob)return false;patchJob(job,po.localJob);job.purchaseOrders=[...(job.purchaseOrders||[]).filter(p=>p.id!==po.id),po];
 for(const line of po.lines){const request=job.partRequests.find(r=>r.id===line.partRequestId);if(request){request.ordered_milli=String(Number(request.ordered_milli||0)+line.quantityMilli);request.status='ordered';request.eta=po.data.eta;}}
 job.incomingParts=[...(job.incomingParts||[]),...po.lines.filter(l=>l.category==='job_part').map(l=>({id:l.id,purchaseId:po.id,poNumber:po.data.poNumber,jobId:job.id,partRequestId:l.partRequestId,quantityMilli:l.quantityMilli,receivedMilli:l.receivedMilli,description:l.description,eta:po.data.eta}))];if(job.postingStatus){job.postingStatus.ready=false;job.postingStatus.bills.push({id:po.id,revision:po.revision,number:po.data.poNumber,stage:po.stage,status:'not_ready',blockers:['Receive every ordered part.','Record the supplier invoice.','Attach the supplier invoice and purchase photo.']});}stages(state,job.id);return true;
}
