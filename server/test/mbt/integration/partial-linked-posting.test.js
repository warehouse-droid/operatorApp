import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {closeDb,query,withTransaction} from '../../../src/db.js';
import {prepareDirectPoReceiptJob} from '../../../src/direct-po-auto-receipt.js';
import {assertAllocatedPoReceiptCurrent} from '../../../src/direct-po-allocation-receipt.js';
import {rollback,seed,deliver,dependencies,processor,source} from '../../support/partial-linked-posting-fixture.mjs';
after(closeDb);

test('partial delivery queues exact allocation receipt without whole-PO completion',()=>rollback(async()=>{
  const f=await seed();
  assert.equal((await query('SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rowCount,0);
  await deliver(f);
  assert.equal((await query("SELECT id FROM dispatch_order_completion_events WHERE order_kind='PO' AND order_ref=$1",[f.po])).rowCount,0);
  const jobs=(await query('SELECT * FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rows;
  assert.equal(jobs.length,1,'delivery must admit partial receipt independently of whole-PO completion');
  const ready=await prepareDirectPoReceiptJob(jobs[0].id,dependencies(f));
  assert.equal(ready.command.status,'queued');
  assert.deepEqual(ready.command.steps[0].payload.item.items,[
    {orderLine:1,quantity:40,itemReceive:true,location:26},
    {orderLine:2,itemReceive:false,location:26}
  ]);
  const replay=await prepareDirectPoReceiptJob(jobs[0].id,dependencies(f));
  assert.equal(replay.command.id,ready.command.id);
  await query("UPDATE driver_job_records SET status='complete' WHERE job_id=$1",[f.drop]);
  assert.equal((await query('SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rowCount,1);
}));

async function job(f) {return (await query('SELECT * FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1 ORDER BY created_at,id',[f.id+1])).rows;}

test('a delivery job ID alone cannot authorize remote posting without owned allocation evidence',()=>rollback(async()=>{
  const f=await seed();await deliver(f);const current=(await job(f))[0];
  await assert.rejects(assertAllocatedPoReceiptCurrent({lineSnapshot:[{directReceiptJobId:current.id}]}),/claimed delivery evidence/);
  assert.equal((await query('SELECT command_id FROM dispatch_direct_po_ir_jobs WHERE id=$1',[current.id])).rows[0].command_id,null);
}));

test('real durable processor finalizes 40/100 as partial, leaves pallet open and never reposts on replay',()=>rollback(async()=>{
  const f=await seed();await deliver(f);
  const ready=await prepareDirectPoReceiptJob((await job(f))[0].id,dependencies(f));
  const worker=processor(f);
  const completed=await worker.runtime.process(ready.command.id);
  assert.equal(completed.status,'completed',completed.lastError);
  assert.equal(worker.transforms(),1);
  const receipt=(await query('SELECT receipt_status,payload FROM receiving_receipt_records WHERE order_id=$1',[f.id+1])).rows[0];
  assert.equal(receipt.receipt_status,'partial_received');
  assert.deepEqual(receipt.payload.item.items,[{orderLine:201,quantity:40,itemReceive:true,location:26}]);
  const header=(await query('SELECT receipt_status FROM purchase_orders WHERE netsuite_id=$1',[f.id+1])).rows[0];
  assert.equal(header.receipt_status,'partial_received');
  const lines=(await query('SELECT netsuite_received_qty FROM purchase_order_lines WHERE purchase_order_id=$1 ORDER BY line_id',[f.id+1])).rows;
  assert(lines.every(line=>Number(line.netsuite_received_qty)===0),'a receipt must not force cached counters to the full order quantity');
  await worker.runtime.process(ready.command.id);
  assert.equal(worker.transforms(),1);
  assert.equal((await query('SELECT id FROM receiving_receipt_records WHERE order_id=$1',[f.id+1])).rowCount,1);
}));

test('a duplicate physical allocation in another delivery job cannot be consumed again',()=>rollback(async()=>{
  const f=await seed();await deliver(f);
  const ready=await prepareDirectPoReceiptJob((await job(f))[0].id,dependencies(f));
  await deliver({...f,drop:`${f.drop}-duplicate`});
  const next=(await job(f)).find(row=>row.id!==ready.id);
  const result=await prepareDirectPoReceiptJob(next.id,dependencies(f));
  assert.equal(result.status,'reconciled');assert.equal(result.command,undefined);
  assert.equal((await query('SELECT * FROM dispatch_direct_po_ir_allocation_claims WHERE allocation_id=$1',[f.allocation])).rowCount,1);
}));

test('a distinct later allocation receives its own 60 units and preserves the unlinked pallet',()=>rollback(async()=>{
  const f=await seed();await deliver(f);
  const first=await prepareDirectPoReceiptJob((await job(f))[0].id,dependencies(f));
  const worker=processor(f);assert.equal((await worker.runtime.process(first.command.id)).status,'completed');
  await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,item_name,sku,
    allocated_sales_qty,status,dispatch_target_ref,dispatch_target_line_key,details)
    SELECT sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,item_name,sku,60,'active',dispatch_target_ref,dispatch_target_line_key,details
      FROM dispatch_so_po_allocations WHERE id=$1`,[f.allocation]);
  await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,load_id,driver_login,stop_type,order_refs,status,completed_at,job_details)
    SELECT job_id||'-next',plan_id,plan_date,load_id||'-next',driver_login,stop_type,order_refs,status,now(),job_details FROM driver_job_records WHERE job_id=$1`,[f.pick]);
  await deliver({...f,load:`${f.load}-next`,drop:`${f.drop}-next`});
  const next=(await job(f)).find(row=>row.id!==first.id);
  const ready=await prepareDirectPoReceiptJob(next.id,{...dependencies(f),fetchSource:async()=>source(f,40)});
  assert.equal(ready.command.steps[0].payload.item.items[0].quantity,60);
  const secondWorker=processor(f,{received:40});assert.equal((await secondWorker.runtime.process(ready.command.id)).status,'completed');
  const receipts=(await query('SELECT payload,receipt_status FROM receiving_receipt_records WHERE order_id=$1',[f.id+1])).rows;
  assert.equal(receipts.reduce((sum,row)=>sum+Number(row.payload.item.items[0].quantity),0),100);
  assert(receipts.every(row=>row.receipt_status==='partial_received'));
}));

test('gate off, cancelled allocation, changed item and reopened delivery cannot create an IR',()=>rollback(async()=>{
  for(const variant of ['gate','cancelled','item','reopen']) {
    const f=await seed();const driver=await deliver(f);
    if(variant==='gate') {await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='operator_netsuite_receiving_ir_150'");}
    if(variant==='cancelled') {await query("UPDATE dispatch_so_po_allocations SET status='cancelled' WHERE id=$1",[f.allocation]);}
    if(variant==='item') {await query('UPDATE purchase_order_lines SET item_id=1784 WHERE id=$1',[f.pl]);}
    if(variant==='reopen') {await query("UPDATE driver_job_records SET status='in_progress' WHERE id=$1",[driver]);}
    const current=(await job(f))[0];
    if(variant==='gate') {assert.equal((await prepareDirectPoReceiptJob(current.id,dependencies(f))).status,'gate_disabled');}
    else {await assert.rejects(prepareDirectPoReceiptJob(current.id,dependencies(f)),/evidence|item|quantity/i);}
    assert.equal((await query('SELECT command_id FROM dispatch_direct_po_ir_jobs WHERE id=$1',[current.id])).rows[0].command_id,null);
  }
}));

test('new system receipt evidence cannot authorize an ordinary operator receipt',()=>rollback(async()=>{
  const f=await seed();await deliver(f);
  const ready=await prepareDirectPoReceiptJob((await job(f))[0].id,dependencies(f));
  await assert.rejects(withTransaction(()=>query(`UPDATE operator_netsuite_posting_commands
    SET input_snapshot=jsonb_set(input_snapshot,'{localOperation,kind}','"receiving_receipt"') WHERE id=$1`,[ready.command.id])),/check constraint/i);
  await assert.rejects(withTransaction(()=>query(`UPDATE operator_netsuite_posting_commands
    SET input_snapshot=input_snapshot #- '{directDeliveryEvidence,executionEventIds}' WHERE id=$1`,[ready.command.id])),/check constraint/i);
}));

test('numeric PO identity preserves pickup evidence when its reference has been renamed',()=>rollback(async()=>{
  const f=await seed();await deliver(f);
  await query("UPDATE purchase_orders SET dispatch_ref='RENAMED-'||dispatch_ref WHERE netsuite_id=$1",[f.id+1]);
  const ready=await prepareDirectPoReceiptJob((await job(f))[0].id,dependencies(f));
  assert.equal(ready.command.steps[0].payload.item.items[0].quantity,40);
  assert.equal(ready.command.inputSnapshot.directDeliveryEvidence.pickupJobIds[0],f.pick);
}));

test('full product delivery with an unlinked pallet still creates a partial receipt',()=>rollback(async()=>{
  const f=await seed(100);await deliver(f);
  const jobs=(await query('SELECT * FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rows;
  assert.equal(jobs.length,1);
  const ready=await prepareDirectPoReceiptJob(jobs[0].id,dependencies(f));
  assert.equal(ready.command.steps[0].payload.item.items[0].quantity,100);
  assert.equal(ready.command.steps[0].payload.item.items[1].itemReceive,false);
}));

test('reopened pickup audit invalidates its retained delivery even if the driver status was restored',()=>rollback(async()=>{
  const f=await seed();await deliver(f);
  await query(`INSERT INTO driver_job_corrections(correction_id,idempotency_id,action,driver_job_record_id,job_id,
    plan_date,driver_login,expected_state_hash,audit_note,corrected_by,before_state,after_state)
    SELECT gen_random_uuid(),gen_random_uuid(),'reopen',id,job_id,plan_date,driver_login,repeat('a',64),
      'Reopen pickup test','test','{}','{}' FROM driver_job_records WHERE job_id=$1`,[f.pick]);
  await assert.rejects(prepareDirectPoReceiptJob((await job(f))[0].id,dependencies(f)),/evidence/i);
}));

test('revoking an allocation after admission blocks the real transform',()=>rollback(async()=>{
  const f=await seed();await deliver(f);
  const ready=await prepareDirectPoReceiptJob((await job(f))[0].id,dependencies(f));
  await query("UPDATE dispatch_so_po_allocations SET status='cancelled' WHERE id=$1",[f.allocation]);
  const worker=processor(f),result=await worker.runtime.process(ready.command.id);
  assert.notEqual(result.status,'completed');assert.equal(worker.transforms(),0);
  assert.match(result.lastError,/evidence|quantity|item/i);
}));

test('migration can be reapplied and rolled back atomically without changing allocations',()=>rollback(async()=>{
  const {readFile}=await import('node:fs/promises');
  const sql=await readFile('migrations/314_partial_linked_po_receipts.sql','utf8');
  const f=await seed();await deliver(f);
  await withTransaction(()=>query(sql),{rollback:true});
  await query(sql);
  assert.equal((await job(f)).length,1);
  const ready=await prepareDirectPoReceiptJob((await job(f))[0].id,dependencies(f));
  assert.equal(ready.command.steps[0].payload.item.items[0].quantity,40);
  await assert.rejects(withTransaction(()=>query('DELETE FROM dispatch_direct_po_ir_allocation_claims WHERE job_id=$1',[ready.id])),
    {message:'dispatch_direct_po_ir_allocation_claims is append-only; DELETE is not permitted'});
  assert.equal((await query('SELECT allocation_id FROM dispatch_direct_po_ir_allocation_claims WHERE job_id=$1',[ready.id])).rowCount,1);
}));

test('multiple delivered allocations sum once on their exact line and reject an excessive total',()=>rollback(async()=>{
  for(const amount of [25,75]) {
    const f=await seed(amount);
    await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,item_name,sku,
      allocated_sales_qty,status,dispatch_target_ref,dispatch_target_line_key,details)
      SELECT sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,item_name,sku,35,'active',dispatch_target_ref,dispatch_target_line_key,details
        FROM dispatch_so_po_allocations WHERE id=$1`,[f.allocation]);
    await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,load_id,driver_login,stop_type,order_refs,status,completed_at,job_details)
      SELECT job_id||'-next',plan_id,plan_date,load_id||'-next',driver_login,stop_type,order_refs,status,now(),job_details FROM driver_job_records WHERE job_id=$1`,[f.pick]);
    await deliver({...f,load:`${f.load}-next`});
    const current=(await job(f))[0];
    if(amount===75) {
      await assert.rejects(prepareDirectPoReceiptJob(current.id,dependencies(f)),/exceeds/i);
      assert.equal((await query('SELECT allocation_id FROM dispatch_direct_po_ir_allocation_claims WHERE job_id=$1',[current.id])).rowCount,0);
    } else {
      const ready=await prepareDirectPoReceiptJob(current.id,dependencies(f));
      assert.equal(ready.command.steps[0].payload.item.items[0].quantity,60);
      assert.equal(ready.command.steps[0].payload.item.items[1].itemReceive,false);
      assert.equal((await query('SELECT allocation_id FROM dispatch_direct_po_ir_allocation_claims WHERE job_id=$1',[current.id])).rowCount,2);
    }
  }
}));
