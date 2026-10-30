import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {closeDb,query,withTransaction} from '../../../src/db.js';
import {readFile} from 'node:fs/promises';
import fc from 'fast-check';
import {prepareDirectPoReceiptJob} from '../../../src/direct-po-auto-receipt.js';
import {rollback,dependencies} from '../../support/partial-linked-posting-fixture.mjs';
import {splitSeed,splitPickup,splitDrop,splitEvents,splitSource} from '../../support/split-linked-receipt-fixture.mjs';
after(closeDb);

test('grouped split records exactly S1 allocation and admits its receipt without S2',()=>rollback(async()=>{
  const f=await splitSeed();await splitPickup(f);await splitDrop(f);
  assert.deepEqual((await splitEvents(f)).map(e=>[e.phase,Number(e.allocated_sales_qty)]),[['pickup',27],['delivered',27]]);
  const jobs=(await query('SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rows;
  assert.equal(jobs.length,1);
  const ready=await prepareDirectPoReceiptJob(jobs[0].id,{...dependencies(f),fetchSource:async()=>splitSource(f)});
  assert.deepEqual(ready.command.steps[0].payload.item.items,[{orderLine:1,itemReceive:false,location:26},{orderLine:2,quantity:27,itemReceive:true,location:26}]);
  assert.equal(Number((await query('SELECT quantity FROM sales_order_lines WHERE id=$1',[f.splitLine])).rows[0].quantity),29);
}));

async function invalidate(f,variant) {
  const child=f.orders[0].childOrderDetails[0],item=child.items[0];
  if(variant==='group') f.orders[0].id+='-different';
  if(variant==='child') f.orders[0].childOrders=[f.other];
  if(variant==='parent') child.originalOrderId+='-different';
  if(variant==='parent-id') child.netsuiteId='999';
  if(variant==='line') item.lineRowId='999';
  if(variant==='item') item.itemId=999;
  if(variant==='quantity') item.quantity=f.amount-0.25;
  if(variant==='malformed') item.quantity={unexpected:1};
  if(variant==='route') f.trucks[0].loads[0].id+='-different';
  if(variant==='stop') f.trucks[0].loads[0].stops.forEach(stop=>{stop.id+='-different';});
  if(variant==='retained') f.id+=99;
  if(variant==='cancelled') await query("UPDATE dispatch_so_po_allocations SET status='cancelled' WHERE id=$1",[f.splitAllocation]);
  if(variant==='aggregate') await query(`INSERT INTO dispatch_so_po_allocations(sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,item_name,sku,
    allocated_sales_qty,status,dispatch_target_kind,dispatch_target_ref,dispatch_target_line_key,details)
    SELECT sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,item_name,sku,1,status,dispatch_target_kind,dispatch_target_ref,dispatch_target_line_key,details
    FROM dispatch_so_po_allocations WHERE id=$1`,[f.splitAllocation]);
  await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb WHERE plan_id=$1',[f.plan,JSON.stringify(f.orders),JSON.stringify(f.trucks)]);
}

for(const variant of ['group','child','parent','parent-id','line','item','quantity','malformed','route','stop','retained','cancelled','aggregate']) {
  test(`grouped split rejects ${variant} mismatch`,()=>rollback(async()=>{
    const f=await splitSeed();await invalidate(f,variant);await splitPickup(f);await splitDrop(f);
    assert.deepEqual(await splitEvents(f),[]);
  }));
}

test('wrong pickup place or incomplete pickup cannot establish split delivery evidence',()=>rollback(async()=>{
  for(const variant of ['place','incomplete']) {
    const f=await splitSeed();
    if(variant==='place') await query(`UPDATE driver_job_records SET job_details='{"pickupLocation":"Other Vendor"}' WHERE job_id=$1`,[f.pick]);
    else await query("UPDATE driver_job_records SET status='in_progress' WHERE job_id=$1",[f.pick]);
    await splitPickup(f);await splitDrop(f);assert.deepEqual(await splitEvents(f),[]);
  }
}));

test('bounded historical replay adds only missing evidence and rolls back atomically',()=>rollback(async()=>{
  const migration=await readFile('migrations/324_grouped_split_allocation_execution.sql','utf8');
  const old=(await readFile('migrations/180_sales_order_completion_fulfillment.sql','utf8'));
  const definition=old.slice(old.indexOf('CREATE OR REPLACE FUNCTION dispatch_project_so_po_allocation_execution()'),old.indexOf('DROP TRIGGER IF EXISTS trg_dispatch_so_po_allocation_execution'));
  await query(definition);
  const f=await splitSeed(),pick=await splitPickup(f),drop=await splitDrop(f);
  assert.deepEqual(await splitEvents(f),[]);
  const records=(await query('SELECT to_jsonb(j) AS value FROM driver_job_records j WHERE id=ANY($1::bigint[]) ORDER BY id',[[pick,drop]])).rows;
  await withTransaction(()=>query(migration),{rollback:true});
  assert.equal((await query("SELECT pg_get_functiondef('dispatch_project_so_po_allocation_execution()'::regprocedure) AS value")).rows[0].value.includes('PERFORM dispatch_record_'),false);
  await query(migration);await query(migration);
  assert.deepEqual(await splitEvents(f),[],'migration must never backfill historical jobs');
  const replay=async()=>{await query('SELECT dispatch_record_so_po_allocation_execution($1)',[pick]);await query('SELECT dispatch_record_so_po_allocation_execution($1)',[drop]);};
  await assert.rejects(withTransaction(async()=>{await replay();throw new Error('deliberate recovery failure');}),/deliberate/);
  assert.deepEqual(await splitEvents(f),[]);
  await replay();await replay();
  assert.equal((await splitEvents(f)).length,2);
  assert.equal((await query('SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rowCount,1);
  assert.deepEqual((await query('SELECT to_jsonb(j) AS value FROM driver_job_records j WHERE id=ANY($1::bigint[]) ORDER BY id',[[pick,drop]])).rows,records);
}));

test('property: arbitrary split quantities preserve the sibling and reject identity or quantity mismatch',async()=>{
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:10000}),fc.integer({min:1,max:50}),async(n,sibling)=>{
    for(const variant of ['valid','group','line','quantity']) await rollback(async()=>{
      const amount=n/4,f=await splitSeed(amount,sibling);
      if(variant!=='valid') await invalidate(f,variant);
      await splitPickup(f);await splitDrop(f);
      assert.deepEqual((await splitEvents(f)).map(e=>[e.phase,Number(e.allocated_sales_qty)]),variant==='valid'?[['pickup',amount],['delivered',amount]]:[]);
      assert.equal(Number((await query('SELECT quantity FROM sales_order_lines WHERE id=$1',[f.splitLine])).rows[0].quantity),amount+sibling);
    });
  }),{numRuns:20,seed:20261029});
});

test('concurrent replay and receipt admission retain one event pair and one allocation claim',async()=>{
  const f=await withTransaction(async()=>{const value=await splitSeed();value.pickId=await splitPickup(value);value.dropId=await splitDrop(value);return value;});
  await Promise.all(Array.from({length:12},()=>withTransaction(async()=>{
    await query('SELECT dispatch_record_so_po_allocation_execution($1)',[f.pickId]);
    await query('SELECT dispatch_record_so_po_allocation_execution($1)',[f.dropId]);
  })));
  assert.equal((await splitEvents(f)).length,2);
  const jobs=(await query('SELECT id FROM dispatch_direct_po_ir_jobs WHERE local_po_id=$1',[f.id+1])).rows;
  assert.equal(jobs.length,1);
  const results=await Promise.all(Array.from({length:12},()=>prepareDirectPoReceiptJob(jobs[0].id,{...dependencies(f),fetchSource:async()=>splitSource(f)})));
  assert.equal(new Set(results.filter(r=>r?.command).map(r=>r.command.id)).size,1);
  assert.equal((await query('SELECT allocation_id FROM dispatch_direct_po_ir_allocation_claims WHERE allocation_id=$1',[f.splitAllocation])).rowCount,1);
});
