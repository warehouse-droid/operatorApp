import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import crypto from 'node:crypto';
import {query,closeDb} from '../src/db.js';
import {hydrateHistoricalDispatchPlanOrders} from '../src/dispatch-historical-order-snapshots.js';
import {auditRetainedBoard} from './dispatch-history-cargo-oracle.mjs';
const root = process.env.DISPATCH_CARGO_REPORT_DIRECTORY || 'test-artifacts/dispatch-all-history-20261002/cargo-route';
await mkdir(root,{recursive:true,mode:0o700});
const pass = Number(process.argv[2] || 1);
const path = `${root}/pass-${pass}.json`;
const resume = process.argv.includes('--resume');
const source = JSON.parse(await readFile('test-artifacts/dispatch-all-history-20261002/pass-2.json','utf8'));
const cases = source.records.filter(record=>record.result === 'saved_and_rolled_back');
const report = resume ? JSON.parse(await readFile(path,'utf8')) : {pass,startedAt:new Date().toISOString(),records:[],failures:[]};
const persist = () => writeFile(path,JSON.stringify(report,null,2)+'\n',{mode:0o600});
const tracked=['src/driver-repository.js','src/dispatch-retained-link-manifests.js','src/dispatch-load-assignment.js','public/dispatch.js',
  'tools/dispatch-history-cargo-oracle.mjs','tools/dispatch-history-cargo-replay.mjs'];
const hashes=async()=>Object.fromEntries(await Promise.all(tracked.map(async file=>[file,crypto.createHash('sha256').update(await readFile(file)).digest('hex')])));
try {
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  assert.equal((await query('SELECT current_database() AS name')).rows[0].name,'mbt_test_history');
  report.sourceStages ||= [];report.sourceStages.push({at:new Date().toISOString(),resumeAt:report.records.length,hashes:await hashes()});
  const jobs=(await query(`SELECT id,plan_id::text,plan_date::text,load_id,stop_type,order_refs,completed_at,started_at,
    job_details->>'pickupLocation' AS pickup_location,job_details->>'dropLocation' AS drop_location
    FROM driver_job_records WHERE status='complete' AND completed_at IS NOT NULL AND stop_type IN ('pickup','dropoff')`)).rows;
  const transfers=(await query('SELECT tranid,received_at FROM transfer_orders WHERE received_at IS NOT NULL')).rows;
  for(let index=report.records.length;index<cases.length;index++) {
    const entry=cases[index];
    const table={snapshot:'dispatch_plan_snapshots',history:'dispatch_plan_snapshot_history',command:'dispatch_plan_commands'}[entry.stream];
    const column=entry.stream==='snapshot'?'plan_id':'id';
    const row=(await query(`SELECT * FROM ${table} WHERE ${column}=$1`,[entry.sourceId])).rows[0];
    const receipt=row.result?.plan;
    const plan={id:entry.planId,planDate:entry.planDate,orders:receipt?.orders || receipt?.assignedOrderSnapshots || row.orders || [],
      trucks:receipt?.trucks || row.trucks || [],summary:receipt?.summary || row.summary || {},
      savedAt:receipt?.savedAt || row.original_saved_at || row.saved_at || entry.eventAt};
    const hydrated=await hydrateHistoricalDispatchPlanOrders(plan);
    try {
      const checked=auditRetainedBoard(hydrated.plan);
      checked.executionSupportedRoutes=[];
      checked.routeIssues=checked.routeIssues.filter(issue=>{
        const asOf=new Date(plan.savedAt).getTime();
        const order=plan.orders.find(candidate=>candidate.id===issue.orderRef);
        const refs=[issue.orderRef,...(order?.childOrders || [])];
        let proof;
        if(issue.check==='pickup_before_delivery') {proof=jobs.find(job=>job.plan_id===entry.planId && job.load_id===issue.loadId
          && job.stop_type==='pickup' && new Date(job.completed_at).getTime()<=asOf
          && String(job.pickup_location || '').split(/\s*:\s*/)[0].toLowerCase()===String(issue.location).split(/\s*:\s*/)[0].toLowerCase()
          && ((job.order_refs || []).includes(issue.orderRef) || refs.slice(1).length && refs.slice(1).every(ref=>(job.order_refs || []).includes(ref))));}
        if(issue.check==='replenishment_evidence_missing') {
          proof=jobs.find(job=>job.stop_type==='dropoff' && (job.order_refs || []).includes(issue.transferOrderRef)
            && new Date(job.completed_at).getTime()<=asOf && job.plan_date < entry.planDate)
            || transfers.find(transfer=>transfer.tranid===issue.transferOrderRef && new Date(transfer.received_at).getTime()<=asOf);
        }
        if(proof) {checked.executionSupportedRoutes.push({...issue,proof});}
        return !proof;
      });
      report.records.push({index,stream:entry.stream,sourceId:entry.sourceId,planId:entry.planId,planDate:entry.planDate,
        result:checked.evidenceGaps.length || checked.routeIssues.length ? 'checked_with_unresolved_evidence' : 'checked',...checked});
    } catch(error) {
      const failure={index,entry,message:error.message,code:error.code || error.name,actual:error.actual,expected:error.expected,stack:error.stack};
      report.failures.push(failure);
      await writeFile(`${root}/failure-${pass}-${index}.json`,JSON.stringify({failure,plan:hydrated.plan},null,2),{mode:0o600});
      await persist(); console.error(JSON.stringify(failure)); process.exitCode=1;break;
    }
    if(index%100===0) {await persist();console.log(JSON.stringify({pass,checked:index+1,total:cases.length}));}
  }
  if(report.records.length===cases.length) {
    report.finalHashes=await hashes();assert.deepEqual(report.finalHashes,report.sourceStages.at(-1).hashes);
    report.completedAt=new Date().toISOString();
  }
  await persist();
} finally {await closeDb();}
