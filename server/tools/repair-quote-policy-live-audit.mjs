import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const root=pathToFileURL(process.cwd()+'/');
const [{query,closeDb},{config},{createRepairRepository}]=await Promise.all([import(new URL('src/db.js',root)),import(new URL('src/config.js',root)),import(new URL('src/repair/repository.js',root))]);
// Operational deployment audit: local reads only, no adapter or mutations.
try{
 const repo=createRepairRepository(),office={role:'repair_office'},tech={role:'repair_technician'},id='539a8eb5-8cef-4ad4-bccd-69043120da53',rejectedId='68aa0ecb-058c-41f8-aaab-60d31defd023';
 const settings=await repo.settings(office),view=await repo.get(office,id),rejected=await repo.get(office,rejectedId),active=await repo.list(tech,{active:true,workJobs:true});
 assert.deepEqual(settings.quoteAutoApproval,{trucks:false,forkliftsLoaders:false,externalCustomers:false});
 assert.equal(config.repair.postingEnabled,false);assert.equal(settings.postingEnabled,false);assert.equal(view.postingStatus.mode,'manual');
 assert.equal(view.autoApproveQuote,false);assert.ok(rejected.quote.lines.every(line=>line.decision==='rejected'));assert.ok(!active.some(job=>['completed','cancelled'].includes(job.status)));
 const counts=(await query("SELECT count(*) FILTER (WHERE kind='quote_auto_approved')::integer AS auto_decisions,count(*) FILTER (WHERE kind='quote_approval_policy_changed')::integer AS policy_changes FROM repair_events")).rows[0];
 const postings=(await query('SELECT kind,state,attempt FROM repair_postings WHERE request_id=$1 ORDER BY created_at',[id])).rows;
 console.log(JSON.stringify({auditAt:new Date().toISOString(),quoteAutoApproval:settings.quoteAutoApproval,mode:view.postingStatus.mode,financialGates:{server:config.repair.postingEnabled,office:settings.postingEnabled},existingRequest:{number:view.request.number,status:view.request.status,receipt:view.request.receipt},rejectedJob:{number:rejected.number,wholeQuoteRejected:true},teamActiveCount:active.length,completedJobsHidden:true,auditCounts:counts,postings,financialCallsByAudit:0,mutationsByAudit:0}));
}finally{await closeDb();}
