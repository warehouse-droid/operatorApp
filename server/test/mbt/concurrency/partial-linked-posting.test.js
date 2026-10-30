import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {closeDb,query,withTransaction} from '../../../src/db.js';
import {prepareDirectPoReceiptJob} from '../../../src/direct-po-auto-receipt.js';
import {readAllocatedPoReceiptEvidence,claimAllocatedPoReceiptEvidence} from '../../../src/direct-po-allocation-receipt.js';
import {seed,deliver,dependencies,processor,source} from '../../support/partial-linked-posting-fixture.mjs';
after(closeDb);

test('two stale evidence readers race at the database boundary and exactly one keeps ownership',async()=>{
  const f=await withTransaction(async()=>{const value=await seed();await deliver(value);await deliver({...value,drop:`value-${value.drop}`});return value;});
  const jobs=(await query('SELECT * FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rows;
  let arrived=0,release;const barrier=new Promise(resolve=>{release=resolve;});
  const outcomes=await Promise.allSettled(jobs.map(job=>withTransaction(async()=>{
    const rows=await readAllocatedPoReceiptEvidence(job);
    arrived++;if(arrived===2) {release();}await barrier;
    return claimAllocatedPoReceiptEvidence(job,rows);
  })));
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  const rejected=outcomes.filter(result=>result.status==='rejected');
  assert.equal(rejected.length,1);assert.equal(rejected[0].reason.code,'OPERATOR_NETSUITE_POSTING_ORDER_CLAIMED');
  assert.equal((await query('SELECT allocation_id FROM dispatch_direct_po_ir_allocation_claims WHERE allocation_id=$1',[f.allocation])).rowCount,1);
});

test('32 independent workers admit one receipt and one immutable allocation owner',async()=>{
  const f=await withTransaction(async()=>{const value=await seed();await deliver(value);return value;});
  const id=(await query('SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rows[0].id;
  const outcomes=await Promise.all(Array.from({length:32},()=>prepareDirectPoReceiptJob(id,dependencies(f))));
  assert.equal(new Set(outcomes.filter(row=>row?.command).map(row=>row.command.id)).size,1);
  assert.equal((await query('SELECT id FROM operator_netsuite_posting_commands WHERE request_id=$1',[id])).rowCount,1);
  assert.equal((await query('SELECT allocation_id FROM dispatch_direct_po_ir_allocation_claims WHERE allocation_id=$1',[f.allocation])).rowCount,1);
});

test('two independent delivery admissions cannot consume the same physical allocation twice',async()=>{
  const f=await withTransaction(async()=>{const value=await seed();await deliver(value);await deliver({...value,drop:`${value.drop}-duplicate`});return value;});
  const jobs=(await query('SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rows;
  await Promise.all(jobs.map(row=>prepareDirectPoReceiptJob(row.id,dependencies(f))));
  for(const row of jobs) {await prepareDirectPoReceiptJob(row.id,dependencies(f));}
  assert.equal((await query('SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1 AND command_id IS NOT NULL',[f.id+1])).rowCount,1);
  assert.equal((await query('SELECT allocation_id FROM dispatch_direct_po_ir_allocation_claims WHERE allocation_id=$1',[f.allocation])).rowCount,1);
});

test('source claim contention rolls back allocation ownership and retries after the earlier receipt',async()=>{
  const f=await withTransaction(async()=>{const value=await seed();await deliver(value);return value;});
  const firstId=(await query('SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rows[0].id;
  const first=await prepareDirectPoReceiptJob(firstId,dependencies(f));
  const extra=(await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,item_name,sku,
    allocated_sales_qty,status,dispatch_target_ref,dispatch_target_line_key,details)
    SELECT sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,item_name,sku,60,'active',dispatch_target_ref,dispatch_target_line_key,details
      FROM dispatch_so_po_allocations WHERE id=$1 RETURNING id`,[f.allocation])).rows[0].id;
  await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,load_id,driver_login,stop_type,order_refs,status,completed_at,job_details)
    SELECT job_id||'-next',plan_id,plan_date,load_id||'-next',driver_login,stop_type,order_refs,status,now(),job_details FROM driver_job_records WHERE job_id=$1`,[f.pick]);
  await deliver({...f,load:`${f.load}-next`,drop:`${f.drop}-next`});
  const nextId=(await query('SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1 AND id<>$2',[f.id+1,firstId])).rows[0].id;
  const blocked=await prepareDirectPoReceiptJob(nextId,dependencies(f));
  assert.equal(blocked.status,'discovered');
  assert.equal((await query('SELECT allocation_id FROM dispatch_direct_po_ir_allocation_claims WHERE allocation_id=$1',[extra])).rowCount,0);
  assert.equal((await processor(f).runtime.process(first.command.id)).status,'completed');
  const next=await prepareDirectPoReceiptJob(nextId,{...dependencies(f),fetchSource:async()=>source(f,40)});
  assert.equal(next.command.steps[0].payload.item.items[0].quantity,60);
  assert.equal((await query('SELECT allocation_id FROM dispatch_direct_po_ir_allocation_claims WHERE allocation_id=$1',[extra])).rowCount,1);
});
