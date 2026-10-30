import assert from 'node:assert/strict';
import {query,closeDb} from './src/db.js';
import {getOperatorNetSuitePostingCommand} from './src/operator-netsuite-posting-repository.js';
import {getIfirPostingRestletEnabled} from './src/netsuite-ifir-posting-policy.js';
try {
  const counts={native:0,sales:0,transfer:0};
  for(const entry of PLAN.cases) {
    if(entry.queue==='native') {
      const actual=await getOperatorNetSuitePostingCommand(entry.id);
      const old=INVENTORY.native.find(c=>c.id===entry.id);
      assert.equal(actual.status,'completed');assert.equal(actual.inputHash,old.inputHash);assert.equal(actual.activeClaims.length,0);
      assert.equal(actual.steps.length,old.steps.length);
      for(let i=0;i<old.steps.length;i++) {
        assert.equal(actual.steps[i].status,'posted');assert.deepEqual(actual.steps[i].payload,old.steps[i].payload);
        assert.equal(actual.steps[i].payloadHash,old.steps[i].payloadHash);assert.deepEqual(actual.steps[i].lineSnapshot,old.steps[i].lineSnapshot);
      }
    }else if(entry.queue==='sales') {
      const row=(await query('SELECT * FROM dispatch_sales_order_if_candidates WHERE id=$1',[entry.id])).rows[0];
      const old=INVENTORY.sales.find(c=>c.id===entry.id);
      assert.ok(['completed','reconciled'].includes(row.status));assert.equal(row.snapshot_hash,old.snapshotHash);
      assert.equal(row.payload_hash,old.payloadHash);assert.deepEqual(row.payload,old.payload);assert.deepEqual(row.line_snapshot,old.lineSnapshot);
      assert.equal(row.lease_token,null);
      assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_sales_order_if_line_claims WHERE candidate_id=$1 AND active',[entry.id])).rows[0].n,0);
    }else {
      const row=(await query('SELECT * FROM transfer_order_posting_jobs WHERE id=$1',[entry.id])).rows[0];
      assert.equal(row.status,'completed');assert.ok(row.result.transactions.length);assert.equal(row.command_id,null);
    }
    counts[entry.queue]++;
  }
  const skipped=(await query(`SELECT dispatch_order_ref,status FROM dispatch_sales_order_if_candidates
    WHERE dispatch_order_ref=ANY($1::text[])`,[['SOA08854-S2','SOA06143-S2']])).rows;
  assert.equal(skipped.length,2);assert.ok(skipped.every(c=>c.status==='skipped'));
  const gate=await getIfirPostingRestletEnabled();assert.equal(gate,false);
  console.log(JSON.stringify({at:new Date().toISOString(),verified:counts,originalPayloadsPreserved:true,claimsReleased:true,skipped,restletGate:gate}));
}finally{await closeDb();}
