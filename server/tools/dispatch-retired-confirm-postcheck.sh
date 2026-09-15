#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"
docker exec -i -e "RETIRED_CONFIRM_POSTCHECK_MODE=${1:-after}" mbbs-operator-app-app-1 node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {query,withTransaction,closeDb} from './src/db.js';
import {loadDispatchOrdersForResponse} from './src/server.js';
import {reconcileDispatchPlanGlobalOrderDefinitions} from './src/dispatch-delivery-group-repository.js';
import {getDispatchOrderCatalogOrder,listDispatchOrderPool} from './src/dispatch-order-catalog-repository.js';
import {getDispatchPlan} from './src/dispatch-plan-repository.js';
import {evaluateDispatchExecutedPrefixPreservation} from './src/dispatch-executed-prefix-repository.js';
try {
  assert.equal((await fetch('http://127.0.0.1:3000/health')).ok,true);
  if(process.env.RETIRED_CONFIRM_POSTCHECK_MODE!=='before') {
    for(const file of ['dispatch.js','dispatch.html']) {
      const response=await fetch(`http://127.0.0.1:3000/${file}`);
      assert.equal(response.status,200);
      const served=await response.text(),disk=await readFile(`/app/public/${file}`,'utf8');
      assert.equal(createHash('sha256').update(served).digest('hex'),createHash('sha256').update(disk).digest('hex'));
      if(file==='dispatch.html') assert.ok(served.includes('lifecycle=20260914-v1'));
    }
    console.log(JSON.stringify({check:'health_and_served_assets',passed:true}));
  }
  await withTransaction(async()=>{
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await query("SET LOCAL statement_timeout='40s'");
    const witness={};
    for (const [name,sql] of Object.entries({
      plans:"SELECT md5(string_agg(row_to_json(p)::text,'|' ORDER BY p.id)) digest FROM dispatch_plans p WHERE id IN (324,326)",
      snapshots:"SELECT md5(string_agg(row_to_json(s)::text,'|' ORDER BY s.plan_id)) digest FROM dispatch_plan_snapshots s WHERE plan_id IN (324,326)",
      recovery:"SELECT count(*) count,md5(string_agg(row_to_json(h)::text,'|' ORDER BY h.id)) digest FROM dispatch_plan_snapshot_history h WHERE plan_id IN (324,326)",
      driverJobs:"SELECT count(*) count,md5(string_agg(row_to_json(j)::text,'|' ORDER BY j.id)) digest FROM driver_job_records j WHERE plan_id IN (324,326)",
      source:"SELECT md5(string_agg(row_to_json(o)::text,'|' ORDER BY o.netsuite_id)) digest FROM sales_orders o WHERE tranid IN ('SOA08404-S2','SOA08404','SOM06255','SOM06256')",
      co:"SELECT md5(row_to_json(c)::text) digest FROM local_co_orders c WHERE co_ref='CO-GOA-7894-7895'"
    })) witness[name]=(await query(sql)).rows;
    console.log(JSON.stringify({check:'persistent_records',witness}));
    if(process.env.RETIRED_CONFIRM_POSTCHECK_MODE==='before') return;
    const retired='SOA08404-S2', recreated='CO-GOA-7894-7895';
    const exact=await loadDispatchOrdersForResponse({exactOrderRefs:[retired,recreated]});
    assert.equal(exact.some(order=>order.id===retired),false);
    assert.ok(exact.some(order=>order.id===recreated));
    for (const ref of [retired,recreated]) {
      const orders=await loadDispatchOrdersForResponse({search:ref});
      assert.equal(orders.some(order=>order.id===ref),ref===recreated);
      await reconcileDispatchPlanGlobalOrderDefinitions({orders,trucks:[]},{rejectRetiredGlobalOrderRefs:true});
      console.log(JSON.stringify({check:'fresh_search_to_validator',ref,visible:ref===recreated,passed:true}));
    }
    assert.equal(await getDispatchOrderCatalogOrder(retired),null);
    assert.equal((await getDispatchOrderCatalogOrder(recreated))?.id,recreated);
    assert.ok((await listDispatchOrderPool({type:'CO',search:recreated})).orders.some(order=>order.id===recreated));
    await assert.rejects(reconcileDispatchPlanGlobalOrderDefinitions({orders:[{id:retired,type:'SO'}],
      trucks:[{id:'check',loads:[{id:'check',stops:[{type:'drop',orderId:retired}]}]}]},
      {rejectRetiredGlobalOrderRefs:true}),error=>error.code==='DISPATCH_DERIVED_ORDER_RETIRED');
    const recovery=(await query(`SELECT id,plan_id,md5(orders::text||trucks::text) AS content_digest
      FROM dispatch_plan_snapshot_history WHERE id IN (17282,17288,17291) ORDER BY id`)).rows;
    assert.equal(recovery.length,3);
    const plans=(await query("SELECT id,plan_date::text,status,revision FROM dispatch_plans WHERE id IN (324,326) ORDER BY id")).rows;
    const audit=(await query(`SELECT id,action,details->>'recreationAuditId' recreation_audit_id FROM dispatch_audit_log
      WHERE action='dispatch_retired_direct_co_definition_repaired' AND order_id=$1 ORDER BY id DESC LIMIT 1`,[recreated])).rows;
    assert.equal(audit.length,1);
    const snapshot=(await query('SELECT orders,trucks FROM dispatch_plan_snapshots WHERE plan_id=324')).rows[0];
    const refreshed=await getDispatchPlan('324');
    const protectedLoad='T4-L1789349637541-7959d8854096b';
    const load=plan=>plan.trucks.flatMap(truck=>truck.loads||[]).find(candidate=>candidate.id===protectedLoad);
    const recorded=load(snapshot).stops.map(stop=>({id:stop.id,timing:stop.timing}));
    assert.ok(recorded.every(stop=>stop.timing),'Published executed timing is missing');
    assert.deepEqual(load(refreshed).stops.map(stop=>({id:stop.id,timing:stop.timing})),recorded);
    const policy=await evaluateDispatchExecutedPrefixPreservation({previousPlan:{id:'324',...snapshot},nextPlan:refreshed});
    if(process.env.RETIRED_CONFIRM_POSTCHECK_MODE==='recorded') {
      assert.equal(policy.allowed,true,'Unchanged recorded load still conflicts after refresh');
      assert.deepEqual(load(refreshed).stops,load(snapshot).stops);
      assert.equal(load(refreshed).stops.at(-1).dropSalesQty,1500.29);
      assert.equal(refreshed.orders.find(order=>order.id==='LOINC-033146').poRouteProjection,undefined);
      console.log(JSON.stringify({check:'recorded_po_load',passed:true,quantity:1500.29,unchangedPlanAllowed:true}));
    }
    if(!policy.allowed) {
      assert.ok(policy.conflicts.every(conflict=>conflict.code==='DISPATCH_ACTIVE_LOAD_LOCKED'&&conflict.loadId===protectedLoad));
      const before=load(snapshot).stops.at(-1),after=load(refreshed).stops.at(-1);
      assert.equal(before.orderId,'LOINC-033146');
      console.log(JSON.stringify({check:'independent_live_allocation_conflict',allowed:false,conflicts:policy.conflicts,
        orderId:before.orderId,recordedDropSalesQty:before.dropSalesQty,projectedDropSalesQty:after.dropSalesQty}));
    }
    console.log(JSON.stringify({check:'executed_schedule_refresh',passed:true,planId:'324',protectedLoad,protectedStops:recorded.length}));
    console.log(JSON.stringify({check:'catalog_guard_recovery_postcheck',passed:true,recovery,plans,audit}));
  });
} finally {await closeDb();}
JS
if [[ "${1:-after}" != before ]]; then
  docker exec mbbs-operator-app-app-1 sha256sum /app/src/server.js /app/src/dispatch-plan-repository.js /app/public/dispatch.js /app/public/dispatch.html /app/tools/repair-dispatch-retired-confirm.mjs
fi
docker inspect mbbs-operator-app-app-1 mbbs-operator-app-webhook-worker-1 --format '{{.Name}} image={{.Config.Image}} started={{.State.StartedAt}} running={{.State.Running}}'
