import assert from 'node:assert/strict';
import {query,closeDb,withTransaction} from './src/db.js';
import {resolveSalesOrderAutoFulfillmentCandidate} from './src/sales-order-auto-fulfillment-repository.js';
const refs=['SOA08854-S2','SOA06143-S2'];
try {
  const result=await withTransaction(async()=>{
    const rows=(await query('SELECT id,dispatch_order_ref,status,attempt_count FROM dispatch_sales_order_if_candidates WHERE dispatch_order_ref=ANY($1::text[]) FOR UPDATE',[refs])).rows;
    assert.equal(rows.length,2);assert.ok(rows.every(r=>r.status==='waiting_evidence'&&Number(r.attempt_count)===0));
    const result=[];
    for(const row of rows) {
      const after=await resolveSalesOrderAutoFulfillmentCandidate({candidateId:row.id,action:'skip',actorId:'maintenance:netsuite-queue-resolution-20261021',
        reason:'User explicitly instructed "skip that 2 orders" after reviewing the conflicting Dispatch and NetSuite quantities for SOA08854-S2 and SOA06143-S2. No NetSuite posting or completion status asserted.'});
      assert.equal(after.status,'skipped');result.push({reference:row.dispatch_order_ref,before:row.status,status:after.status,id:row.id});
    }
    return result;
  });
  console.log(JSON.stringify({at:new Date().toISOString(),netSuitePosts:0,results:result}));
}finally{await closeDb();}
