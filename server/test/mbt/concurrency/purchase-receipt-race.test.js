import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {query,withTransaction,closeDb} from '../../../src/db.js';
import {enqueueDelayedStatusRefresh,claimDueDelayedStatusRefreshJobs,lockDelayedStatusRefreshLease,finishDelayedStatusRefreshAttempt} from '../../../src/netsuite-delayed-status-refresh-repository.js';
import {recordReceivingReceipt} from '../../../src/receiving-repository.js';
after(closeDb);
test('a receipt racing worker commit neither fails its save nor loses the follow-up',async()=>{
  const input={orderType:'purchase_order',netsuiteOrderId:989881,availableAt:new Date(0),rerunIfRunning:true};
  await enqueueDelayedStatusRefresh(input);
  const [job]=await claimDueDelayedStatusRefreshJobs({workerId:'receipt-race'});
  await enqueueDelayedStatusRefresh(input);
  let start;
  const gate=new Promise(resolve=>{start=resolve;});
  const enqueue=gate.then(()=>enqueueDelayedStatusRefresh(input)).then(value=>({value}),error=>({error}));
  await withTransaction(async()=>{
    assert.equal(await lockDelayedStatusRefreshLease(job),true);
    // Start outside the worker's transaction context using a timer created below.
    start();
    await delay(100);
    await finishDelayedStatusRefreshAttempt({...job,outcome:'succeeded'});
  });
  const result=await enqueue;
  assert.equal(result.error,undefined,result.error?.message);
  const active=(await query("SELECT id FROM netsuite_delayed_status_refresh_jobs WHERE netsuite_order_id=$1 AND status IN ('pending','running','retry')",[input.netsuiteOrderId])).rows;
  assert.equal(active.length,1);
  assert.equal(result.value.jobId,Number(active[0].id));
});
test('local receipt saving and PO refresh use a consistent lock order',async()=>{
  await query("DELETE FROM netsuite_delayed_status_refresh_jobs");
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES(989882,'PO-LOCK-ORDER','Pending Receipt',true)");
  await query("INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_type,quantity,unit,to_pcs,netsuite_active) VALUES(989882,1,989882,'InvtPart',10,'EA',1,true)");
  await enqueueDelayedStatusRefresh({orderType:'purchase_order',netsuiteOrderId:989882,availableAt:new Date(0)});
  const [job]=await claimDueDelayedStatusRefreshJobs({workerId:'receipt-lock-order'});
  let start;
  const gate=new Promise(resolve=>{start=resolve;});
  const saved=gate.then(()=>recordReceivingReceipt(989882,null,{photoDataUrls:['data:image/png;base64,YQ==','data:image/png;base64,Yg=='],
    payload:{item:{items:[{orderLine:1,itemReceive:true,quantity:10}]}},response:{localOnly:true},itemReceiptId:null,itemReceiptTranid:null})).then(value=>({value}),error=>({error}));
  await withTransaction(async()=>{
    await query("SET LOCAL lock_timeout='3s'");
    assert.equal(await lockDelayedStatusRefreshLease(job),true);start();await delay(100);
    await query("UPDATE purchase_orders SET status_text='Pending Bill' WHERE netsuite_id=989882");
    await finishDelayedStatusRefreshAttempt({...job,outcome:'succeeded'});
  });
  const result=await saved;assert.equal(result.error,undefined,result.error?.message);assert.equal(result.value.receiptStatus,'received');
  assert.equal((await query("SELECT count(*)::int AS n FROM netsuite_delayed_status_refresh_jobs WHERE netsuite_order_id=989882 AND status='pending'")).rows[0].n,1);
});
