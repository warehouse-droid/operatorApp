import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fc from 'fast-check';
import {getSpecialStockCasesByIds} from '../src/special-stock-request-repository.js';
import test,{after} from 'node:test';
import {performance} from 'node:perf_hooks';
import {beginRollbackContext,closeDb,query} from '../src/db.js';
import {readSpecialDispatchPlans,specialDispatchPlanning,specialPlannedOrderRefs} from '../src/special-stock-planning.js';

after(closeDb);
async function rollback(run) {
  const tx=await beginRollbackContext();
  try {await tx.run(run);} finally {await tx.rollback();}
}

test('completion lookup keeps 28500 historical events within the 500ms subquery budget',()=>rollback(async()=>{
  const job=(await query(`INSERT INTO driver_job_records(job_id,driver_login,stop_type,status)
    VALUES('request-perf-audit-job','request-perf-driver','dropoff','pending') RETURNING id`)).rows[0];
  await query(`INSERT INTO driver_job_corrections(correction_id,idempotency_id,action,driver_job_record_id,job_id,
    plan_date,driver_login,expected_state_hash,audit_note,corrected_by,before_state,after_state,result)
    SELECT gen_random_uuid(),gen_random_uuid(),'reopen',$1,'unrelated-reopen-'||g,
      '2098-01-01','request-perf-driver',repeat('0',64),'TEST performance audit','TEST','{}','{}',
      jsonb_build_object('physicalVisitJobIds',jsonb_build_array('visit-a-'||g,'visit-b-'||g))
    FROM generate_series(1,85) g`,[job.id]);
  await query(`INSERT INTO dispatch_order_completion_events(order_kind,order_ref,dispatch_completed_at,
    completion_evidence_type,completion_evidence_id)
    SELECT 'SO','SO-REQUEST-PERF-'||g,'2098-01-01','driver_job','request-perf-job-'||g
      FROM generate_series(1,28500) g`);
  await query('ANALYZE driver_job_corrections; ANALYZE dispatch_order_completion_events');
  const started=performance.now();
  const result=await query(`SELECT count(*)::int AS count FROM dispatch_order_completion_status
    WHERE order_kind='SO' AND order_ref LIKE 'SO-REQUEST-PERF-%'`);
  const elapsed=performance.now()-started;
  assert.equal(result.rows[0].count,28500);
  console.log(JSON.stringify({measurement:'completion-history',rows:28500,reopens:85,ms:elapsed}));
  assert.ok(elapsed<=500,`Completion work exceeded its 500ms share of the 1500ms page budget: ${elapsed.toFixed(1)}ms`);
}));

test('scoped planning returns the same nested/split/CO/ETA results and omits unrelated plans',()=>rollback(async()=>{
  const plans=[];
  for (let i=0;i<3;i++) {
    const p=(await query("INSERT INTO dispatch_plans(plan_date,status,revision) VALUES($1,'draft',3) RETURNING id",[`2098-02-0${i+1}`])).rows[0];
    const orders=i===0?[{id:'TEST-GROUP',type:'TO',childOrderDetails:[{id:'TEST-SO-S1',originalOrderId:'TEST-SO'}]},
      {id:'TEST-CO',type:'CO',childOrders:['TEST-NOT-PLANNED']}]:[{id:`UNRELATED-${i}`,type:'SO'}];
    const trucks=[{plate:'TEST',loads:[{name:'Load',stops:i===0?
      [{type:'pick',orderId:'TEST-GROUP',timing:{arrival:500}},{type:'drop',orderId:'TEST-GROUP',timing:{arrival:650}},{type:'drop',orderId:'TEST-CO'}]:
      [{type:'drop',orderId:`UNRELATED-${i}`}]}]}];
    await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2,$3,'{}')",[p.id,JSON.stringify(orders),JSON.stringify(trucks)]);
    plans.push(p.id);
  }
  const all=await readSpecialDispatchPlans();
  for(const name of ['TEST-SO','TEST-NOT-PLANNED','MISSING']) {
    const detail={salesOrderId:1,salesOrderRef:name};
    const scoped=await readSpecialDispatchPlans({orderRefs:[name]});
    assert.deepEqual(specialDispatchPlanning(detail,scoped),specialDispatchPlanning(detail,all));
    assert.equal(scoped.some(p=>String(p.id)===String(plans[1])),false,'Unrelated snapshots must not be loaded');
  }
  assert.deepEqual(await readSpecialDispatchPlans({orderRefs:[]}),[]);
  const scoped=await readSpecialDispatchPlans({orderRefs:[' test-so ','TEST-SO']});
  assert.equal(specialDispatchPlanning({salesOrderId:1,salesOrderRef:'TEST-SO'},scoped).salesOrder.plans[0].estimatedArrivalMinute,650);
  await query("UPDATE dispatch_plans SET status='cancelled' WHERE id=$1",[plans[0]]);
  assert.equal(specialDispatchPlanning({salesOrderId:1,salesOrderRef:'TEST-SO'},await readSpecialDispatchPlans({orderRefs:['TEST-SO']})).anyPlanned,false);
}));

test('effective completion rows remain identical to the original correction contract',()=>rollback(async()=>{
  const cases=fc.sample(fc.record({
    driver:fc.boolean(),reopen:fc.boolean(),direct:fc.boolean(),
    shape:fc.constantFrom('array','object','string','nested','number','null'),
    cycle:fc.constantFrom('old','current','later')
  }),{seed:20261008,numRuns:240});
  const job=(await query(`INSERT INTO driver_job_records(job_id,driver_login,stop_type,status)
    VALUES('request-property-audit-job','request-property-driver','dropoff','pending') RETURNING id`)).rows[0];
  for(const [index,c] of cases.entries()) {
    const evidence='property-job-'+index;
    const physical={array:[evidence,1,null,{nested:evidence}],object:{[evidence]:false},string:evidence,
      nested:[[evidence]],number:1,null:null}[c.shape];
    const correction=(await query(`INSERT INTO driver_job_corrections(correction_id,idempotency_id,action,
      driver_job_record_id,job_id,plan_date,driver_login,expected_state_hash,audit_note,corrected_by,before_state,after_state,result)
      VALUES(gen_random_uuid(),gen_random_uuid(),$1,$2,$3,'2098-01-01','TEST',repeat('0',64),'TEST property','TEST','{}','{}',$4) RETURNING id`,
      [c.reopen?'reopen':'map_location',job.id,c.direct?evidence:'unrelated-'+index,JSON.stringify({physicalVisitJobIds:physical})])).rows[0];
    await query(`INSERT INTO dispatch_order_completion_events(order_kind,order_ref,dispatch_completed_at,
      completion_evidence_type,completion_evidence_id,reopen_correction_id)
      VALUES('SO',$1,'2098-01-01',$2,$3,$4)`,['SO-PROPERTY-'+index,c.driver?'driver_job':'direct_dependency',evidence,
      c.cycle==='current'?correction.id:null]);
    if(c.cycle==='later') await query(`INSERT INTO driver_job_corrections(correction_id,idempotency_id,action,
      driver_job_record_id,job_id,plan_date,driver_login,expected_state_hash,audit_note,corrected_by,before_state,after_state,result)
      VALUES(gen_random_uuid(),gen_random_uuid(),'reopen',$1,$2,'2098-01-01','TEST',repeat('0',64),'TEST later cycle','TEST','{}','{}','{}')`,[job.id,evidence]);
  }
  for(const kind of ['SO','PO']) for(const [index,type] of ['driver_job','direct_dependency','manual_dispatch','scm_vendor','reconciliation','vrma_completion','custom_order','netsuite_fulfillment'].entries()) {
    if(kind==='SO' && type==='scm_vendor') continue; // Vendor completion is legal only for inbound kinds.
    await query(`INSERT INTO dispatch_order_completion_events(order_kind,order_ref,dispatch_completed_at,
      completion_evidence_type,completion_evidence_id,actor_type,actor_id,reason,metadata)
      VALUES($1,$2,$3,$4,$5,'operator','TEST','TEST priority','{"netSuiteUpdated":false}')`,[kind,index%2?` ${kind.toLowerCase()}-priority `:kind+'-PRIORITY',
      `2098-01-${String(index+1).padStart(2,'0')}`,type,'property-priority-'+kind+'-'+index]);
  }
  const originalStatus=await fs.readFile(new URL('../tools/request-loading-20261008/original-status-view.sql',import.meta.url),'utf8');
  const differenceStatus=await query(`WITH expected AS (${originalStatus}),actual AS (SELECT * FROM dispatch_order_completion_status)
    SELECT count(*)::int AS count FROM ((SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
      UNION ALL (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)) difference`);
  assert.equal(differenceStatus.rows[0].count,0);
  const old=await fs.readFile(new URL('../tools/request-loading-20261008/original-effective-view.sql',import.meta.url),'utf8');
  const actual=(await query('SELECT pg_get_viewdef(\'dispatch_effective_order_completion_events\'::regclass,true) AS sql')).rows[0].sql;
  const difference=await query(`WITH expected AS (${old}),actual AS (${actual.replace(/;\s*$/,'')})
    SELECT count(*)::int AS count FROM ((SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
      UNION ALL (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)) difference`);
  assert.equal(difference.rows[0].count,0);
}));

test('planning reference filter is a superset for nested, split, unusual and hostile identifiers',()=>rollback(async()=>{
  const names=['SO-1',' mixed ','SO-S1','ß','中文','quote\'ref','[OBJECT OBJECT]','\\slash','wild%_card','0'];
  for(const [index,name] of names.entries()) {
    for(const explicit of [true,false]) {
    const plan={id:9,planDate:'2098-02-01',orders:[{id:'GROUP',childOrderDetails:[{id:name,originalOrderId:explicit?'PARENT-'+index:undefined}]}],
      trucks:[{loads:[{stops:[{type:'pick',orderId:'GROUP'},{type:'delivery',orderId:name,timing:{arrival:540}}]}]}]};
    const refs=[...specialPlannedOrderRefs(plan)];
    const result=(await query(`SELECT dispatch_snapshot_planning_refs($1::jsonb,$2::jsonb) AS refs`,[JSON.stringify(plan.orders),JSON.stringify(plan.trucks)])).rows[0].refs;
    for(const name of refs) assert.ok(result.includes(name)||result.includes('__MBBS_ANY_REFERENCE__'),name);
    }
  }
}));

test('completion and planning migration can roll back without changing retained evidence',async()=>{
  const views=['dispatch_effective_order_completion_events','special_stock_workflow_stages','dispatch_order_completion_status'];
  const fixtures=['original-effective-view.sql','original-stage-view.sql','original-status-view.sql'];
  const definitions=async()=>Promise.all(views.map(async name=>(await query('SELECT pg_get_viewdef($1::regclass,true) AS sql',[name])).rows[0].sql));
  const evidence=async()=>(await query('SELECT count(*)::int AS count FROM dispatch_order_completion_events')).rows[0].count;
  const current=await definitions(),before=await evidence();
  await rollback(async()=>{
    for(const [index,name] of views.entries()) {
      const old=await fs.readFile(new URL('../tools/request-loading-20261008/'+fixtures[index],import.meta.url),'utf8');
      await query('CREATE OR REPLACE VIEW '+name+' AS '+old);
    }
    await query(`DROP FUNCTION dispatch_completion_evidence_priority(text);
      DROP INDEX idx_dispatch_snapshot_planning_refs;
      DROP FUNCTION dispatch_snapshot_planning_refs(jsonb,jsonb);
      DELETE FROM schema_migrations WHERE filename='275_request_completion_lookup.sql'`);
    assert.equal(await evidence(),before);
    assert.equal((await query("SELECT to_regclass('idx_dispatch_snapshot_planning_refs') AS name")).rows[0].name,null);
    assert.equal((await query("SELECT to_regprocedure('dispatch_snapshot_planning_refs(jsonb,jsonb)') AS name")).rows[0].name,null);
    assert.equal((await query("SELECT count(*)::int AS count FROM schema_migrations WHERE filename='275_request_completion_lookup.sql'")).rows[0].count,0);
    for(const name of views) await query('SELECT * FROM '+name+' LIMIT 1');
  });
  assert.deepEqual(await definitions(),current);
  assert.equal(await evidence(),before);
  assert.equal((await query("SELECT indisvalid FROM pg_index WHERE indexrelid='idx_dispatch_snapshot_planning_refs'::regclass")).rows[0].indisvalid,true);
  assert.equal((await query("SELECT dispatch_completion_evidence_priority('driver_job') AS priority")).rows[0].priority,10);
});

test('batch hydration rejects a missing request instead of silently dropping it',async()=>{
  assert.deepEqual(await getSpecialStockCasesByIds([]),[]);
  await assert.rejects(getSpecialStockCasesByIds([999999999999]),{code:'SPECIAL_CASE_NOT_FOUND',status:404});
  await assert.rejects(getSpecialStockCasesByIds(["1 OR 1=1"]),error=>error.status===400);
});
