"""Replay plan 341's recovery draft against current or candidate modules, read-only."""
import base64
import json
from pathlib import Path
import re
import subprocess
import sys

server = Path(__file__).resolve().parents[1]
candidate = "--candidate" in sys.argv
modules = ["dispatch-load-assignment.js", "dispatch-executed-order-review.js",
           "dispatch-planner-performance.js", "dispatch-plan-repository.js"]
urls = {}
for name in modules:
    if candidate:
        source = (server / "src" / name).read_text()
        source = re.sub(r'([\"\'])\./([^\"\']+)\1',
                        lambda match: match[1] + urls.get(match[2], "file:///app/src/" + match[2]) + match[1], source)
        urls[name] = "data:text/javascript;base64," + base64.b64encode(source.encode()).decode()
    else:
        urls[name] = "file:///app/src/" + name

script = r'''
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from './src/db.js';
import {persistedDispatchPlan} from './src/dispatch-plan-fence.js';
import {listDispatchOrders} from './src/dispatch-repository.js';
const {overlayLockedLoadDerivedSchedule}=await import(ASSIGNMENT);
const {executedOrderChanges}=await import(REVIEW);
const {evaluateExecutedPrefixPolicy}=await import(POLICY);
const {getDispatchPlan}=await import(PLAN);
try {await withTransaction(async()=>{
  await query('SET TRANSACTION READ ONLY');
  await query("SET LOCAL statement_timeout='20s'");
  const row=(await query(`SELECT p.id,p.plan_date,p.status,p.revision,p.note,s.orders,s.trucks,s.summary,s.saved_at
    FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=341`)).rows[0];
  const recorded=persistedDispatchPlan(row);
  const backup=(await query(`SELECT id,orders,trucks,summary,archived_at FROM dispatch_plan_snapshot_history
    WHERE plan_id=341 AND archive_reason='save_recovery' ORDER BY id DESC LIMIT 1`)).rows[0];
  const jobs=(await query(`SELECT status,load_id,stop_id,stop_type,order_refs,job_details,started_at,completed_at
    FROM driver_job_records WHERE plan_id=341 AND status IN ('complete','in_progress')
    AND mbt_assignment_withdrawn_at IS NULL ORDER BY id`)).rows;
  const activity=jobs.filter(job=>job.started_at<=backup.archived_at).map(job=>({...job,
    status:job.completed_at && job.completed_at<=backup.archived_at?'complete':'in_progress'}));
  const plan=await getDispatchPlan(341);
  const group=plan.orders.find(order=>order.id==='GOB-121261-121262');
  const saved=recorded.orders.find(order=>order.id===group.id);
  const sources=await listDispatchOrders({exactOrderRefs:['SOB121261','SOB121262'],includeHiddenScm:true,
    includeFulfilledSalesDeliveries:true,includeInactiveSalesOrderLines:false,unboundedPerType:true});
  const sourceChanges=sources.flatMap(source=>executedOrderChanges(saved.childOrderDetails.find(child=>child.id===source.id),source));
  const draft={...plan,orders:backup.orders,trucks:backup.trucks,summary:backup.summary};
  const overlaid=overlayLockedLoadDerivedSchedule(plan,draft,new Set(activity.map(job=>job.load_id)),{activityStatuses:activity});
  const result=evaluateExecutedPrefixPolicy({previousPlan:plan,nextPlan:overlaid,activity});
  const weightOnly=structuredClone(recorded);
  weightOnly.orders.find(order=>order.id===group.id).weight+=200;
  for(const truck of weightOnly.trucks)for(const load of truck.loads)for(const stop of load.stops){
    if(stop.orderId===group.id){stop.dropWeight=8984.966;}
  }
  const weightPolicy=evaluateExecutedPrefixPolicy({previousPlan:recorded,nextPlan:weightOnly,activity});
  const hostile=structuredClone(overlaid);
  hostile.orders.find(order=>order.id===group.id).childOrderDetails[0].items[0].quantity+=1;
  const hostilePolicy=evaluateExecutedPrefixPolicy({previousPlan:plan,nextPlan:hostile,activity});
  assert.equal(sourceChanges.length,0,'source orders remain unchanged');
  assert.equal(hostilePolicy.allowed,false,'actual executed quantity edit remains rejected');
  if(CANDIDATE){
    assert.equal(group.weight,saved.weight);
    assert.equal(group.weight,8784.966);
    assert.equal(group.childOrderDetails[0].weight,7744.966);
    assert.equal(result.allowed,true,JSON.stringify(result.conflicts.map(c=>c.message)));
    assert.equal(weightPolicy.allowed,true);
  }
  console.log(JSON.stringify({readOnly:true,candidate:CANDIDATE,planId:341,revision:plan.revision,backupId:backup.id,
    savedWeight:saved.weight,loadedWeight:group.weight,sourceChanges:sourceChanges.length,
    backupPassesExecutedGuard:result.allowed,weightOnlyPasses:weightPolicy.allowed,
    remainingConflicts:result.conflicts.map(conflict=>({code:conflict.code,reasons:conflict.reasons,
      fields:[...new Set(conflict.changes.map(change=>change.field))]})),
    actualQuantityChangeBlocked:!hostilePolicy.allowed,
    boundaryStatusAtSave:activity.filter(job=>job.load_id==='T5-L1790695378171-cb09e75816d7a').at(-1)?.status,
    newReturnLoadRetained:overlaid.trucks.some(truck=>truck.loads.some(load=>load.returnOnly && load.id==='T5-MR1790713434365-0a71f7087f2e88'))}));
},{rollback:true});}finally{await closeDb();}
'''
for token, name in zip(["ASSIGNMENT", "REVIEW", "POLICY", "PLAN"], modules):
    script = script.replace(token, json.dumps(urls[name]))
script = script.replace("CANDIDATE", "true" if candidate else "false")
result = subprocess.run(["sudo", "-n", "docker", "exec", "-i", "mbbs-operator-app-app-1", "node", "--input-type=module"],
                        input=script, text=True, capture_output=True)
if result.returncode:
    errors = [line for line in result.stderr.splitlines() if len(line) < 600]
    raise RuntimeError("Read-only replay failed: " + "\n".join(errors[-15:]))
report = json.loads(result.stdout)
artifact = server / "test-artifacts/dispatch-weight-save"
artifact.mkdir(exist_ok=True)
(artifact / ("candidate-live.json" if candidate else "live.json")).write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report))
