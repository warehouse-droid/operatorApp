"""Compare candidate/live PO reads within one read-only production snapshot."""
import base64
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def module_url(name, substitutions=None):
    source = (ROOT / 'src' / name).read_text()
    for old, new in (substitutions or {}).items():
        source = source.replace(old, new)
    source = source.replace('from "./', 'from "file:///app/src/').replace("from './", "from 'file:///app/src/")
    return 'data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()


schedule = module_url('dispatch-repository.js')
candidate = module_url('scm-purchase-order-catalog-repository.js', {'"./dispatch-repository.js"': json.dumps(schedule)})
script = """
import assert from 'node:assert/strict';
import {withTransaction,query,closeDb} from './src/db.js';
import * as baseline from './src/scm-purchase-order-catalog-repository.js';
import * as baselineSchedule from './src/dispatch-repository.js';
import pg from 'pg';
const candidate=await import(CANDIDATE);
const candidateSchedule=await import(SCHEDULE);
const profile=PROFILE;
const profileSchedule=PROFILE_SCHEDULE;
const extended=EXTENDED;
const recovery=RECOVERY;
let captured;
let evidenceQuery;
const original=pg.Client.prototype.query;
if(profile) pg.Client.prototype.query=function(sql,...args){
 const start=performance.now();
 if(typeof sql==='string' && sql.includes('WITH active_po_split_alloc AS MATERIALIZED')) captured=[sql,args[0]];
 if(typeof sql==='string' && sql.includes('WITH requested(order_key)')) evidenceQuery=[sql,args[0]];
 const result=original.call(this,sql,...args);
 return result?.then?result.then(value=>{console.log(JSON.stringify({ms:Math.round(performance.now()-start),rows:value?.rowCount,sql:String(sql).replace(/\\s+/g,' ').trim().slice(0,130)}));return value;}):result;
};
try {
 await withTransaction(async()=>{
  await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  await query("SET LOCAL statement_timeout='25s'");
  if(recovery){
    const jobs=(await query(`SELECT id::text,order_ref,status,attempts,completed_at,updated_at
      FROM scm_purchase_order_catalog_refresh_outbox WHERE id IN (1718,2677,4197,4198) ORDER BY id`)).rows;
    const listed=await candidate.listScmPurchaseOrderCatalog({search:'POB04160'});
    const schedule=await candidateSchedule.listScmSchedule({search:'POB04160',audience:'schedule_search'});
    const state=await candidate.getScmPurchaseOrderCatalogState();
    console.log(JSON.stringify({jobs,catalog:listed.orders.map(row=>({ref:row.id,status:row.scm?.status,method:row.scm?.method})),
      schedule:schedule.map(row=>({ref:row.orderRef,status:row.calculatedStatus,method:row.method})),state}));
    assert.ok(jobs.length===4&&jobs.every(job=>job.status==='complete'),'abandoned refresh recovery is not yet complete');
    assert.ok(listed.orders.some(row=>row.id==='POB04160'),'POB04160 missing from PO Split');
    assert.ok(schedule.some(row=>row.orderRef==='POB04160'),'POB04160 missing from schedule');
    assert.ok(state.ready,'catalog must be ready');
    return;
  }
  if(profile){
    if(profileSchedule) await candidateSchedule.listScmSchedule();
    else await candidate.listScmPurchaseOrderCatalog({limit:200,includeRestricted:true});
    pg.Client.prototype.query=original;
    const plan=(await query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+captured[0],captured[1])).rows[0]['QUERY PLAN'][0];
    const nodes=[];
    function walk(p){nodes.push({node:p['Node Type'],relation:p['Relation Name'],name:p['CTE Name']||p['Subplan Name']||p['Function Name'],condition:p['Join Filter']||p['Hash Cond']||p['Merge Cond']||p['Filter'],sort:p['Sort Key'],ms:p['Actual Total Time'],loops:p['Actual Loops'],rows:p['Actual Rows'],selfMs:Math.round((p['Actual Total Time']*p['Actual Loops']-(p.Plans||[]).reduce((s,c)=>s+c['Actual Total Time']*c['Actual Loops'],0))*10)/10});for(const c of p.Plans||[])walk(c);}
    walk(plan.Plan);
    console.log(JSON.stringify({planningMs:plan['Planning Time'],executionMs:plan['Execution Time'],slowNodes:nodes.sort((a,b)=>b.selfMs-a.selfMs).slice(0,14),ctes:nodes.filter(n=>n.name?.startsWith('CTE'))}));
    if(profileSchedule) return;
    nodes.length=0;
    const evidencePlan=(await query('EXPLAIN (ANALYZE, FORMAT JSON) '+evidenceQuery[0],evidenceQuery[1])).rows[0]['QUERY PLAN'][0];
    walk(evidencePlan.Plan);
    console.log(JSON.stringify({evidenceMs:evidencePlan['Execution Time'],slowNodes:nodes.sort((a,b)=>b.selfMs-a.selfMs).slice(0,10)}));
    return;
  }
  if(extended){
    let cursor='',page=0,total=0;
    do{
      const options={limit:200,includeRestricted:true,cursor};
      const expected=await baseline.listScmPurchaseOrderCatalog(options);
      const start=performance.now();
      const actual=await candidate.listScmPurchaseOrderCatalog(options);
      assert.deepEqual(actual,expected,'catalog page '+page+' differs');
      cursor=actual.nextCursor;total+=actual.orders.length;
      console.log(JSON.stringify({page:page++,rows:actual.orders.length,candidateMs:Math.round(performance.now()-start),identical:true}));
      assert.ok(page<100,'unexpected cursor loop');
    }while(cursor);
    console.log(JSON.stringify({catalogPages:page,totalRows:total,identical:true}));
    for(const filters of [{search:'POB04160',audience:'schedule_search'},{}]){
      let start=performance.now();const expected=await baselineSchedule.listScmSchedule(filters);
      const baselineMs=Math.round(performance.now()-start);
      start=performance.now();const actual=await candidateSchedule.listScmSchedule(filters);
      const candidateMs=Math.round(performance.now()-start);
      assert.deepEqual(actual,expected,'schedule differs '+JSON.stringify(filters));
      console.log(JSON.stringify({schedule:filters,rows:actual.length,baselineMs,candidateMs,identical:true}));
      const samples=[];
      for(let i=0;i<5;i++){
        start=performance.now();await candidateSchedule.listScmSchedule(filters);
        samples.push(Math.round(performance.now()-start));
      }
      console.log(JSON.stringify({schedule:filters,samplesMs:samples,maxMs:Math.max(...samples),underOneSecond:samples.every(ms=>ms<1000)}));
      assert.ok(samples.every(ms=>ms<1000),'schedule one-second response budget exceeded');
    }
    return;
  }
  const cases=[{search:'POB04160'},{search:'POB041'},{search:'brown'},{search:'POB04160',includeRestricted:false},{search:'does-not-exist-4160'},{}];
  for(const filters of cases){
    const options={limit:200,includeRestricted:true,...filters};
    let start=performance.now();
    const expected=await baseline.listScmPurchaseOrderCatalog(options);
    const before=Math.round(performance.now()-start);
    start=performance.now();
    const actual=await candidate.listScmPurchaseOrderCatalog(options);
    const after=Math.round(performance.now()-start);
    assert.deepEqual(actual,expected,'candidate results differ for '+JSON.stringify(filters));
    console.log(JSON.stringify({filters,rows:actual.orders.length,baselineMs:before,candidateMs:after,identical:true}));
    if((filters.search==='POB04160'||!Object.keys(filters).length)&&actual.orders[0]){
      const ref=actual.orders[0].id;
      const expectedDetail=await baseline.getScmPurchaseOrderCatalogOrder(ref);
      start=performance.now();
      const detail=await candidate.getScmPurchaseOrderCatalogOrder(ref);
      const detailMs=Math.round(performance.now()-start);
      assert.deepEqual(detail,expectedDetail,'detail result differs for '+ref);
      console.log(JSON.stringify({detailRef:ref,detailMs,identical:true,needsLegacyHydration:(detail?.items||[]).some(line=>!Object.hasOwn(line,'netsuiteDestinationYard'))}));
    }
  }
  for(const filters of [{search:'POB04160'},{}]){
    const samples=[];
    for(let i=0;i<5;i++){
      const start=performance.now();
      await candidate.listScmPurchaseOrderCatalog({limit:200,includeRestricted:true,...filters});
      samples.push(Math.round(performance.now()-start));
    }
    console.log(JSON.stringify({filters,samplesMs:samples,maxMs:Math.max(...samples),underOneSecond:samples.every(ms=>ms<1000)}));
    assert.ok(samples.every(ms=>ms<1000),'one-second response budget exceeded for '+JSON.stringify(filters));
  }
 },{rollback:true});
} catch(error) {console.error(JSON.stringify({error:error.message.slice(0,4000)})); process.exitCode=1;}
finally {await closeDb();}
""".replace('PROFILE_SCHEDULE', json.dumps('--profile-schedule' in sys.argv)).replace('CANDIDATE', json.dumps(candidate)).replace('SCHEDULE', json.dumps(schedule)).replace('PROFILE', json.dumps('--profile' in sys.argv or '--profile-schedule' in sys.argv)).replace('EXTENDED', json.dumps('--extended' in sys.argv)).replace('RECOVERY', json.dumps('--recovery' in sys.argv))
result = subprocess.run(['docker', 'exec', '-i', 'mbbs-operator-app-app-1', 'node', '--input-type=module'],
                        input=script, text=True, capture_output=True)
print(result.stdout, end='')
if result.stderr:
    print(result.stderr, file=sys.stderr, end='')
if '--record' in sys.argv:
    rows = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
    report = {'passed': result.returncode == 0, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'hashes': {name: hashlib.sha256((ROOT / 'src' / name).read_bytes()).hexdigest()
                         for name in ['dispatch-repository.js', 'scm-purchase-order-catalog-repository.js']}, 'reads': rows}
    name = 'extended-read-check.json' if '--extended' in sys.argv else 'read-only-check.json'
    if '--recovery' in sys.argv:
        name = 'recovery-check.json'
    if '--post' in sys.argv:
        name = 'post-release-' + name
    (ROOT / 'deployments/scm-po-search-20261029' / name).write_text(json.dumps(report, indent=2)+'\n')
result.check_returncode()
