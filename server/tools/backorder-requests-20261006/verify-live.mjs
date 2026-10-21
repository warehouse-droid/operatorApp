import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {backorderStage,assertBackorderLocalAction} from '../../public/backorder-workflow.js';
import {getBackorderRequest,runBackorderAction} from '../../src/backorder-request-service.js';
import {getScmStockRequest} from '../../src/stock-request-repository.js';
import {createBackorderUI} from '../../public/backorder-stock-requests.js';

try{
  for(const fn of [getBackorderRequest,runBackorderAction,createBackorderUI])assert.equal(typeof fn,'function');
  assert.notEqual(backorderStage({salesOrderId:1,operationallyComplete:true}),'completed');
  assert.equal(backorderStage({salesOrderId:1,purchaseOrderId:2,operationallyComplete:true}),'completed');
  assert.throws(()=>assertBackorderLocalAction({workflowKind:'backorder'}),{code:'BACKORDER_REMOTE_BLOCKED'});
  const result=await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    assert.equal((await query("SELECT count(*)::int AS n FROM schema_migrations WHERE filename='268_regular_backorder.sql'")).rows[0].n,1);
    const profile=(await query("SELECT count(*)::int AS n FROM sales_special_stock_cases WHERE workflow_kind NOT IN ('special','backorder')")).rows[0].n;
    assert.equal(profile,0);
    const fixed=(await query("SELECT id,status,revision FROM sales_stock_requests WHERE request_ref='STREQ-000082'")).rows[0];
    assert.equal(Number(fixed.id),122);assert.equal(fixed.status,'active');assert.ok(fixed.revision>=3);
    const lines=(await query('SELECT id,item_name,status FROM sales_stock_request_lines WHERE request_id=$1 ORDER BY id',[fixed.id])).rows;
    assert.equal(lines.length,4);assert.equal(Number(lines[0].id),165);assert.equal(lines[0].item_name,'BWS-HUNT70S-RDM-SM');assert.equal(lines[0].status,'closed');assert.deepEqual(lines.slice(1).map(line=>Number(line.id)),[166,167,168]);
    const detail=await getScmStockRequest(fixed.id);assert.equal(detail.lines[0].resolution.purchaseOrderRef,'POB03992');assert.equal(detail.lines[0].resolution.eta,'2026-10-08');assert.ok(detail.lines.slice(1).every(line=>line.resolution?.purchaseOrderRef!=='POB03992'));
    return {migrationApplied:true,stockingRequestPreserved:true,stockingCurrentRevision:fixed.revision,stockingLines:detail.lines.map(line=>({id:line.id,status:line.status,resolution:line.resolution?{purchaseOrderRef:line.resolution.purchaseOrderRef,eta:line.resolution.eta}:null})),backorderCases:Number((await query("SELECT count(*)::int AS n FROM sales_special_stock_cases WHERE workflow_kind='backorder'")).rows[0].n)};
  });
  const health=await fetch('http://127.0.0.1:3000/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
  for(const role of ['sales','scm']){
    const html=await fetch(`http://127.0.0.1:3000/${role}/stock-requests`);assert.equal(html.status,200);assert.match(await html.text(),/backorder=20261007-v1/);
  }
  const ui=await fetch('http://127.0.0.1:3000/regular-stock-ui.js');assert.match(await ui.text(),/value="backorder"/);
  console.log(JSON.stringify({modulesLoaded:true,assetsUpdated:true,...result}));
}finally{await closeDb();}
