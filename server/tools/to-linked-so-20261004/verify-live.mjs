import assert from 'node:assert/strict';
import {query,closeDb} from '../../src/db.js';
import {listTransferPostingJobs} from '../../src/transfer-order-posting-repository.js';
import {prepareTransferPostingJob,retryTransferPostingJob} from '../../src/transfer-order-posting-service.js';
import {suiteqlAll,fetchItemFulfillmentFromNetSuite} from '../../src/netsuite.js';
try {
 const jobs=(await query(`SELECT id,order_ref,operator_record_id,command_id,status,completion_event_id,snapshot,result,last_error
   FROM transfer_order_posting_jobs WHERE order_ref IN ('TOB01190','TOB01191') ORDER BY order_ref`)).rows;
 assert.equal(jobs.length,2);for(const job of jobs){assert.equal(job.status,'completed');assert.equal(job.command_id,null);
  const replay=await prepareTransferPostingJob(job.id,{resolveSource:async()=>assert.fail('Completed job must not read NetSuite'),getPolicy:async()=>assert.fail()});
  assert.equal(replay.status,'completed');
  await retryTransferPostingJob(job.id);
  assert.equal((await query('SELECT status FROM transfer_order_posting_jobs WHERE id=$1',[job.id])).rows[0].status,'completed');
 }
 const pending=await listTransferPostingJobs();assert.ok(!pending.some(j=>['TOB01190','TOB01191'].includes(j.order_ref)));
 const headers=(await query(`SELECT tranid,status,status_text,fulfillment_status,local_yard_order_status FROM transfer_orders
   WHERE tranid IN ('TOB01190','TOB01191') ORDER BY tranid`)).rows;
 const loads=(await query('SELECT id,order_ref,line_snapshot FROM operator_load_records WHERE id=ANY($1::bigint[])',[jobs.map(j=>j.operator_record_id)])).rows;
 const audit=(await query("SELECT count(*)::int AS count FROM delivery_audit_log WHERE action='transfer_posting.linked_so_existing_if_reconciled'")).rows[0];
 assert.equal(audit.count,2);
 const links=await suiteqlAll("SELECT DISTINCT l.previousdoc,t.id,t.tranid,t.type FROM NextTransactionLineLink l JOIN transaction t ON t.id=l.nextdoc WHERE l.previousdoc IN (1037048,1037331) AND t.type IN ('ItemShip','ItemRcpt')");
 assert.equal(links.length,2);assert.deepEqual(links.map(l=>l.tranid).sort(),['IF156515','IF156516']);
 const remote=[];for(const link of links){const r=await fetchItemFulfillmentFromNetSuite(link.id);remote.push({id:r.id,reference:r.tranId,
  sourceId:r.createdFrom.id,lines:r.item.items.map(l=>({orderLine:l.orderLine,item:l.item.id,quantity:l.quantity}))});}
 console.log(JSON.stringify({at:new Date().toISOString(),jobs,headers,loads,pendingTransfers:pending.map(j=>({reference:j.order_ref,status:j.status,linkedSOs:j.driver_order_refs})),
  audit,remote,netSuitePosts:0},null,2));
}finally{await closeDb();}
