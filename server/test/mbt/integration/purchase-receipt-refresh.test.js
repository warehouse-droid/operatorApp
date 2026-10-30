import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {query,withTransaction,closeDb} from '../../../src/db.js';
import {enqueuePurchaseReceiptRefresh,enqueuePurchaseReceiptWebhook,applyPurchaseReceiptProgress} from '../../../src/purchase-receipt-refresh-repository.js';
import {enqueueDelayedStatusRefresh,claimDueDelayedStatusRefreshJobs,finishDelayedStatusRefreshAttempt} from '../../../src/netsuite-delayed-status-refresh-repository.js';
import {backorderArrivals} from '../../../src/backorder-arrival.js';
import {recordReceivingReceipt} from '../../../src/receiving-repository.js';
import {readFileSync} from 'node:fs';

after(closeDb);
const parent=989771,child=-989771;
const scenario=fn=>withTransaction(fn,{rollback:true});
async function fixture() {
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,netsuite_active)
    VALUES($1,'PO-RECEIPT','B','Pending Receipt',true),($2,'PO-RECEIPT-CHILD','B','Pending Receipt',true)`,[parent,child]);
  await query(`INSERT INTO dispatch_scm_po_splits(source_po_id,source_po_ref,split_po_id,split_po_ref)
    VALUES($1,'PO-RECEIPT',$2,'PO-RECEIPT-CHILD')`,[parent,child]);
  await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,item_type,quantity,unit,to_pcs,piece_qty,netsuite_active)
    VALUES($1,71,989711,'TEST MATERIAL','InvtPart',10,'EA',1,10,true)`,[parent]);
}
const finish=job=>finishDelayedStatusRefreshAttempt({jobId:job.jobId,leaseToken:job.leaseToken,outcome:'succeeded'});

test('receipt child and signed IR coalesce to one canonical parent; invalid events do not queue',()=>scenario(async()=>{
  await fixture();
  const first=await enqueuePurchaseReceiptRefresh(child);
  assert.equal(first?.netsuiteOrderId,parent);
  const next=await enqueuePurchaseReceiptWebhook({ok:true,sourceOrderKind:'PO',sourceOrderId:parent});
  assert.equal(next.jobId,first.jobId);
  for(const extra of [{ignored:true},{stale:true},{ok:false},{sourceOrderKind:'TO'}])
    assert.equal(await enqueuePurchaseReceiptWebhook({ok:true,sourceOrderKind:'PO',sourceOrderId:parent,...extra}),null);
  assert.equal(await enqueuePurchaseReceiptRefresh(-999),null);
  assert.equal(await enqueuePurchaseReceiptRefresh('1 OR 1=1'),null);
  assert.equal((await query('SELECT count(*)::int AS n FROM netsuite_delayed_status_refresh_jobs')).rows[0].n,1);
}));

test('receipt signal during a running refresh survives as exactly one pending follow-up',()=>scenario(async()=>{
  const first=await enqueueDelayedStatusRefresh({orderType:'purchase_order',netsuiteOrderId:parent,availableAt:new Date(0)});
  const [job]=await claimDueDelayedStatusRefreshJobs({workerId:'receipt-worker'});
  assert.equal(job.jobId,first.jobId);
  for(let i=0;i<5;i++) await enqueueDelayedStatusRefresh({orderType:'purchase_order',netsuiteOrderId:parent,availableAt:new Date(),rerunIfRunning:true});
  assert.equal(await finish(job),true);
  const rows=(await query('SELECT id,status FROM netsuite_delayed_status_refresh_jobs ORDER BY id')).rows;
  assert.equal(rows.length,2);assert.equal(rows[0].status,'succeeded');assert.equal(rows[1].status,'pending');
  assert.equal(await finish(job),false);
}));

test('fresh received quantities update every shared backorder PO projection without completing production lines',()=>scenario(async()=>{
  await fixture();
  const details=[1,2].map(id=>({id,workflowKind:'backorder',closeStatus:'active',status:'active'}));
  const lines=[{id:11,request_id:1,supply_status:'already_ordered',backorder_po_number:'PO-RECEIPT'},
    {id:12,request_id:1,supply_status:'production',backorder_po_number:''},
    {id:21,request_id:2,supply_status:'already_ordered',backorder_po_number:'PO-RECEIPT'}];
  const remote={line_id:71,netsuite_order_line:1,item_id:989711,item_name:'TEST MATERIAL',item_type:'InvtPart',quantity:10,unit:'EA',to_pcs:1,piece_qty:10};
  for(const received of [4,10]) {
    await applyPurchaseReceiptProgress({netsuiteOrderId:parent,lines:[{...remote,netsuite_received_qty:received}]});
    const arrivals=await backorderArrivals(details,lines);
    assert.deepEqual([...arrivals.values()].map(row=>row.status),Array(2).fill(received===10?'arrived':'arrival'));
    assert.equal(lines[1].supply_status,'production');
    const row=(await query('SELECT netsuite_received_qty,quantity FROM purchase_order_lines WHERE purchase_order_id=$1',[parent])).rows[0];
    assert.equal(Number(row.netsuite_received_qty),received);assert.equal(Number(row.quantity),10);
  }
}));

test('saving a local parent receipt queues its refresh atomically and preserves local receipt evidence',()=>scenario(async()=>{
  await fixture();
  const result=await recordReceivingReceipt(parent,null,{photoDataUrls:['data:image/png;base64,YQ==','data:image/png;base64,Yg=='],
    payload:{item:{items:[{orderLine:71,itemReceive:true,quantity:10}]}},response:{localOnly:true},itemReceiptId:null,itemReceiptTranid:null});
  assert.equal(result.receiptStatus,'received');
  assert.equal((await query('SELECT netsuite_order_id FROM netsuite_delayed_status_refresh_jobs')).rows[0]?.netsuite_order_id,String(parent));
}));
test('the additive queue migration is repeatable and rolls back without changing existing jobs',()=>scenario(async()=>{
  const job=await enqueueDelayedStatusRefresh({orderType:'purchase_order',netsuiteOrderId:parent,availableAt:new Date(0)});
  const before=(await query('SELECT * FROM netsuite_delayed_status_refresh_jobs WHERE id=$1',[job.jobId])).rows;
  await withTransaction(async()=>{
    await query('ALTER TABLE netsuite_delayed_status_refresh_jobs DROP COLUMN receipt_refresh_requested');
    for(let n=0;n<2;n++)await query(readFileSync('migrations/312_purchase_receipt_refresh.sql','utf8'));
    assert.deepEqual((await query('SELECT * FROM netsuite_delayed_status_refresh_jobs WHERE id=$1',[job.jobId])).rows,before);
  },{rollback:true});
  assert.deepEqual((await query('SELECT * FROM netsuite_delayed_status_refresh_jobs WHERE id=$1',[job.jobId])).rows,before);
}));
