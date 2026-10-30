import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const root=pathToFileURL(process.cwd()+'/');
const [{query,closeDb},{config},{createRepairRepository}]=await Promise.all([import(new URL('src/db.js',root)),import(new URL('src/config.js',root)),import(new URL('src/repair/repository.js',root))]);
// Deployment audit only: local reads; no adapter, mutation, or NetSuite call.
try{
 const repo=createRepairRepository(),office={role:'repair_office'},tech={role:'repair_technician'},id='539a8eb5-8cef-4ad4-bccd-69043120da53',rejectedId='68aa0ecb-058c-41f8-aaab-60d31defd023';
 const view=await repo.get(office,id),rejected=await repo.get(office,rejectedId),active=await repo.list(tech,{active:true,workJobs:true}),settings=await repo.settings(office),shared=await repo.get(tech,id);
 assert.equal(view.postingStatus.mode,'manual');assert.ok(rejected.quote.lines.every(line=>line.decision==='rejected'));assert.ok(!active.some(job=>['completed','cancelled'].includes(job.status)||['pending','accepted'].includes(job.receipt)));assert.ok(!JSON.stringify(shared).includes('hourlyCostMinor'));assert.equal(config.repair.enabled,true);assert.equal(config.repair.postingEnabled,false);assert.equal(settings.postingEnabled,false);
 const postings=(await query("SELECT kind,state,attempt FROM repair_postings WHERE request_id=$1 ORDER BY created_at",[id])).rows;
 console.log(JSON.stringify({auditAt:new Date().toISOString(),mode:view.postingStatus.mode,financialGates:{server:config.repair.postingEnabled,office:settings.postingEnabled},request:{number:view.request.number,status:view.request.status,receipt:view.request.receipt,wor:view.postingStatus.wor.status,sos:view.postingStatus.sos.status,actualLabourRows:view.postingStatus.workforce.length,labourEditable:view.postingStatus.workforceEditable,purchaseOrders:view.postingStatus.bills.map(po=>({number:po.number,stage:po.stage,status:po.status}))},rejectedJob:{number:rejected.number,status:rejected.status,outcome:rejected.outcome,wholeQuoteRejected:true},teamActiveCount:active.length,closedJobsHidden:true,sharedLabourCostHidden:true,postings,financialCallsByAudit:0}));
}finally{await closeDb();}
