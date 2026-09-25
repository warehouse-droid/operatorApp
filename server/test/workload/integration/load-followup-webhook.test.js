import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { query, withTransaction, closeDb } from '../../../src/db.js';
import { normalizeNetSuiteWebhookEnvelope } from '../../../src/netsuite-order-webhook-queue-policy.js';
import { enqueueNetSuiteOrderWebhook, claimNetSuiteOrderWebhook, completeNetSuiteOrderWebhook } from '../../../src/netsuite-order-webhook-queue-repository.js';
after(closeDb);
const body = (quantity, time = '2026-09-17T11:37:00Z') => ({ recordType:'sales_order',id:995451,tranid:'SOB120541',lastModifiedDate:time,lines:[{itemId:602,quantity}] });
async function fixture(run) {
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  return withTransaction(async()=>{
    await query('TRUNCATE netsuite_order_webhook_inbox RESTART IDENTITY CASCADE');
    await query('UPDATE netsuite_order_webhook_control SET paused=false');
    const sorted=Array.from({length:8},(_,i)=>body(i+1)).sort((a,b)=>normalizeNetSuiteWebhookEnvelope({payload:a}).payloadHash.localeCompare(normalizeNetSuiteWebhookEnvelope({payload:b}).payloadHash));
    return run(sorted);
  },{rollback:true});
}
for (const predecessor of ['queued','running','succeeded','failed']) {
  test(`equal-time edit with a smaller hash follows a ${predecessor} predecessor`,()=>fixture(async rows=>{
    const old=await enqueueNetSuiteOrderWebhook({payload:rows.at(-1)});
    let claim;
    if(['running','succeeded'].includes(predecessor)) claim=await claimNetSuiteOrderWebhook({workerId:'first'});
    if(predecessor==='succeeded') await completeNetSuiteOrderWebhook({id:claim.id,leaseToken:claim.leaseToken,result:{ok:true}});
    if(predecessor==='failed') await query("UPDATE netsuite_order_webhook_inbox SET status='failed' WHERE id=$1",[old.id]);
    const latest=await enqueueNetSuiteOrderWebhook({payload:rows[0]});
    assert.equal(latest.superseded,false);
    assert.equal(latest.coalesced,['queued','failed'].includes(predecessor)?1:0);
    if(predecessor==='running') await completeNetSuiteOrderWebhook({id:claim.id,leaseToken:claim.leaseToken,result:{ok:true}});
    const next=await claimNetSuiteOrderWebhook({workerId:'next'});
    assert.equal(next.id,latest.id);
    assert.equal((await enqueueNetSuiteOrderWebhook({payload:rows[0]})).duplicate,true);
  }));
}
test('three equal-time snapshots coalesce by arrival regardless of hash ordering',()=>fixture(async rows=>{
  for(const row of [rows[6],rows[1],rows[3]]) await enqueueNetSuiteOrderWebhook({payload:row});
  const next=await claimNetSuiteOrderWebhook({workerId:'last'});
  assert.equal(next.payload.lines[0].quantity,rows[3].lines[0].quantity);
  assert.equal((await query("SELECT count(*)::int n FROM netsuite_order_webhook_inbox WHERE status='queued'")).rows[0].n,0);
  assert.equal((await enqueueNetSuiteOrderWebhook({payload:body(99,'2026-09-17T11:36:00Z')})).superseded,true);
}));
test('concurrent equal-time arrivals serialize and retain the final accepted snapshot',async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 await query('TRUNCATE netsuite_order_webhook_inbox RESTART IDENTITY CASCADE');
 try{
  const results=await Promise.all(Array.from({length:12},(_,index)=>enqueueNetSuiteOrderWebhook({payload:body(index+20)})));
  assert.ok(results.every(row=>!row.superseded));
  const rows=(await query('SELECT id,status,superseded_by_id,payload FROM netsuite_order_webhook_inbox ORDER BY id')).rows;
  assert.equal(rows.length,12);assert.equal(rows.at(-1).status,'queued');
  assert.ok(rows.slice(0,-1).every(row=>row.status==='superseded'&&Number(row.superseded_by_id)>Number(row.id)));
  const claimed=await claimNetSuiteOrderWebhook({workerId:'concurrent-final'});
  assert.equal(claimed.id,String(rows.at(-1).id));assert.deepEqual(claimed.payload,rows.at(-1).payload);
  const duplicate=await enqueueNetSuiteOrderWebhook({payload:rows.at(-1).payload});
  assert.equal(duplicate.duplicate,true);
 }finally{await query('TRUNCATE netsuite_order_webhook_inbox RESTART IDENTITY CASCADE');}
});
