// Operational retry for the seven diagnosed kit alerts; never use test data here.
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '/app/src/db.js';
import {fetchTransactionStatusesFromNetSuite} from '/app/src/netsuite.js';
import {resolveSalesOrderAutoFulfillmentCandidate,getSalesOrderAutoFulfillmentCandidate} from '/app/src/sales-order-auto-fulfillment-repository.js';
import {enqueueSalesOrderAutoFulfillmentCandidate} from '/app/src/sales-order-auto-fulfillment-runtime.js';
import {salesOrderAutoFulfillmentNetSuiteAdapter} from '/app/src/sales-order-auto-fulfillment-netsuite-adapter.js';

const mode=process.env.DELIVERY_KIT_RETRY_MODE||'inspect';
assert(['inspect','retry','verify'].includes(mode));
// This one-off process may reconcile fulfilled sources only. Stop if a source
// reopens between reads; never send a transform from this operational retry.
salesOrderAutoFulfillmentNetSuiteAdapter.transform=async()=>{
  throw new Error('This verified-fulfilled retry cannot create an Item Fulfillment.');
};
const expected=[['SOA10598',1076698],['SOA10890',1092514],['SOA10934',1095727],['SOB123258',1084561],
  ['SOB123259',1084620],['SOB123344',1087669],['SOM07147',1077575]];
const refs=expected.map(([ref])=>ref),ids=expected.map(([,id])=>id);
async function rows(lock=false) {
  return (await query(`SELECT id,dispatch_order_ref,source_sales_order_id,status,attempt_count,netsuite_transaction_id,
    last_error,snapshot_hash,operator_load_record_id FROM dispatch_sales_order_if_candidates
    WHERE dispatch_order_ref=ANY($1::text[]) ORDER BY dispatch_order_ref ${lock?'FOR UPDATE':''}`,[refs])).rows;
}
async function fingerprints() {
  return (await query(`SELECT
    (SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY id)::text) FROM operator_load_records l WHERE order_id=ANY($1::bigint[])) AS loads,
    (SELECT md5(jsonb_agg(to_jsonb(j) ORDER BY id)::text) FROM driver_job_records j WHERE order_refs ?| $2::text[]) AS jobs,
    (SELECT md5(jsonb_agg(jsonb_build_object('id',id,'line',line_snapshot,'load',operator_load_snapshot,'hash',snapshot_hash,'payload',payload) ORDER BY id)::text)
      FROM dispatch_sales_order_if_candidates WHERE dispatch_order_ref=ANY($2::text[])) AS snapshots,
    (SELECT md5(jsonb_agg(to_jsonb(c) ORDER BY id)::text) FROM dispatch_sales_order_if_candidates c WHERE dispatch_order_ref IN ('SOM07128','SOR00250')) AS unrelated` ,[ids,refs])).rows[0];
}
async function liveHeaders() {
  const live=await fetchTransactionStatusesFromNetSuite(ids,'SalesOrd');
  assert.equal(live.length,expected.length);
  assert.deepEqual(live.map(row=>[row.tranid,Number(row.id)]).sort((a,b)=>a[0].localeCompare(b[0])),expected);
  assert(live.every(row=>['F','G'].includes(row.status)),'Every target must already be fully fulfilled; stop for review otherwise');
  return live.map(row=>({id:Number(row.id),ref:row.tranid,status:row.status,statusText:row.status_text}));
}
try {
  const before=await fingerprints(),initial=await rows(),headers=await liveHeaders();
  assert.equal(initial.length,7);
  console.log(JSON.stringify({event:'before',mode,rows:initial,live:headers,fingerprints:before}));
  if(mode==='retry') await withTransaction(async()=>{
    await query("SET LOCAL lock_timeout='5s'");
    await query("SELECT pg_advisory_xact_lock(hashtext('delivery-kit-retry-20261029'))");
    const current=await rows(true);assert.equal(current.length,7);
    await liveHeaders();
    for(const row of current) {
      if(row.status==='reconciled') continue;
      assert.equal(row.status,'attention');assert.equal(Number(row.attempt_count),0);assert.equal(row.netsuite_transaction_id,null);
      assert.match(row.last_error,/no unique NetSuite REST orderLine/);assert(row.operator_load_record_id);assert(row.snapshot_hash);
      await resolveSalesOrderAutoFulfillmentCandidate({candidateId:row.id,action:'recheck',actorId:'system:authorized-kit-retry-20261029',
        reason:'User requested retry after delivery kit mapping fix; live NetSuite source is already fully fulfilled.'});
      await enqueueSalesOrderAutoFulfillmentCandidate(row.id);
      const result=await getSalesOrderAutoFulfillmentCandidate(row.id);
      assert.equal(result.status,'reconciled',`${row.dispatch_order_ref}: ${result.lastError}`);
      assert.equal(result.attemptCount,0,'Reconciliation must not start a new posting attempt');
      assert.equal(result.netSuiteTransactionId,null,'Do not manufacture another IF identity');
      console.log(JSON.stringify({event:'retried',ref:row.dispatch_order_ref,candidate:row.id,status:result.status,postingAttempts:result.attemptCount}));
    }
    assert.deepEqual(await fingerprints(),before);
  });
  const final=await rows();
  if(mode!=='inspect') assert(final.every(row=>row.status==='reconciled'&&Number(row.attempt_count)===0&&row.last_error===null));
  assert.deepEqual(await fingerprints(),before);
  console.log(JSON.stringify({event:'after',rows:final,fingerprints:before}));
} finally {await closeDb();}
