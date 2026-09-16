import assert from "node:assert/strict";
import test, { after } from "node:test";
import { query, pool, closeDb } from "../../../src/db.js";
import { scenario, seedSalesOrder, completeDriver } from "../support/fulfilled-so-fixture.js";
import { listFulfilledSalesDeliveryStates } from "../../../src/dispatch-fulfilled-so-repository.js";
import { readCleanupState, createCleanupManifest, applyCleanupManifest } from "../../../tools/so-delivery-cleanup-repository.mjs";

after(closeDb);
const remote = (id,ref) => ({mode:"netsuite-read-only-select",completedAt:new Date().toISOString(),
  rows:[{id:String(id),tranid:ref,status:"G",status_text:"Sales Order : Billed"}]});
const manifestFor = async (id,ref) => createCleanupManifest(await readCleanupState(),remote(id,ref),{candidateIds:[String(id)]});

test("cleanup commits observed completion without creating Driver or external posting work; repeat is empty", () => scenario(async()=>{
  const id=817157001,ref="SO-CLEANUP-APPLY";
  await seedSalesOrder(id,ref,{status:"B"});
  const before=await readCleanupState();
  const plan=createCleanupManifest(before,remote(id,ref),{candidateIds:[String(id)]});
  assert.equal(plan.entries.length,1);
  const result=await applyCleanupManifest(plan);
  assert.equal(result.changedOrders,1);
  assert.equal(result.addedCompletions,1);
  const order=(await query("SELECT operator_status,local_yard_order_status,status FROM sales_orders WHERE netsuite_id=$1",[id])).rows[0];
  assert.deepEqual(order,{operator_status:"loaded",local_yard_order_status:"Loaded",status:"G"});
  assert.equal((await listFulfilledSalesDeliveryStates([ref])).get(ref.toLowerCase()).eligible,true);
  const after=await readCleanupState();
  assert.deepEqual(after.protected,before.protected);
  const repeat=await applyCleanupManifest(plan);
  assert.equal(repeat.changedOrders,0);
  assert.equal(repeat.addedCompletions,0);
}));

test("cleanup rollback rehearsal leaves every source row and completion unchanged", () => scenario(async()=>{
  const id=817157002,ref="SO-CLEANUP-ROLLBACK";
  await seedSalesOrder(id,ref,{status:"B"});
  const before=await readCleanupState();
  const plan=createCleanupManifest(before,remote(id,ref),{candidateIds:[String(id)]});
  const result=await applyCleanupManifest(plan,{rollback:true});
  assert.equal(result.changedOrders,1);
  const after=await readCleanupState();
  assert.deepEqual(after.orders,before.orders);
  assert.deepEqual(after.lines,before.lines);
  assert.deepEqual(after.completions,before.completions);
}));

test("stale before-images abort the complete batch", () => scenario(async()=>{
  const id=817157003,ref="SO-CLEANUP-STALE";
  await seedSalesOrder(id,ref,{status:"B"});
  const plan=await manifestFor(id,ref);
  await query("UPDATE sales_order_lines SET packed_sales_qty=1 WHERE sales_order_id=$1",[id]);
  await assert.rejects(applyCleanupManifest(plan),/stale|changed/i);
  assert.equal((await query("SELECT operator_status FROM sales_orders WHERE netsuite_id=$1",[id])).rows[0].operator_status,"open");
  assert.equal((await query("SELECT count(*)::int AS n FROM dispatch_order_completion_events WHERE order_ref=$1",[ref])).rows[0].n,0);
}));

test("new Driver completion invalidates the review and stays blocked after a fresh cleanup", () => scenario(async()=>{
  const id=817157004,ref="SO-CLEANUP-DRIVER";
  await seedSalesOrder(id,ref,{status:"B"});
  const plan=await manifestFor(id,ref);
  await completeDriver(ref);
  await assert.rejects(applyCleanupManifest(plan),/stale|changed/i);
  await applyCleanupManifest(await manifestFor(id,ref));
  const state=(await listFulfilledSalesDeliveryStates([ref])).get(ref.toLowerCase());
  assert.equal(state.locallyCompleted,true);
  assert.equal(state.eligible,false);
}));

test("forged quantities, unverified statuses, and expired evidence are rejected", () => scenario(async()=>{
  const id=817157005,ref="SO-CLEANUP-FORGED";
  await seedSalesOrder(id,ref,{status:"B"});
  const plan=await manifestFor(id,ref);
  const forged=structuredClone(plan);
  forged.entries[0].after.lines[0].loaded_qty=999;
  await assert.rejects(applyCleanupManifest(forged),/manifest|projection|changed|stale/i);
  const expired=structuredClone(plan);
  expired.remote.completedAt="2020-01-01T00:00:00Z";
  await assert.rejects(applyCleanupManifest(expired),/expired|evidence/i);
}));

test("an Operator load lock prevents cleanup from changing its order", () => scenario(async()=>{
  const id=817157006,ref="SO-CLEANUP-LOCKED";
  await seedSalesOrder(id,ref,{status:"B"});
  const plan=await manifestFor(id,ref);
  const operator=await pool.connect();
  try {
    await operator.query("BEGIN");
    await operator.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`operator-delivery-load:${id}`]);
    await assert.rejects(applyCleanupManifest(plan),/lock timeout/i);
    assert.equal((await query("SELECT operator_status FROM sales_orders WHERE netsuite_id=$1",[id])).rows[0].operator_status,"open");
  } finally {await operator.query("ROLLBACK");operator.release();}
}));

test("the unfinished-local scope excludes Operator and Driver completions",()=>scenario(async()=>{
  const ids=[817157007,817157008,817157009],refs=["SO-CLEANUP-NARROW-OPEN","SO-CLEANUP-NARROW-SHIPPED","SO-CLEANUP-NARROW-DRIVER"];
  for(let i=0;i<ids.length;i++) await seedSalesOrder(ids[i],refs[i],{status:"B"});
  await query("UPDATE sales_orders SET operator_status='fulfilled',local_yard_order_status='Shipped' WHERE netsuite_id=$1",[ids[1]]);
  await completeDriver(refs[2]);
  const evidence={...remote(ids[0],refs[0]),rows:ids.map((id,i)=>remote(id,refs[i]).rows[0])};
  const manifest=createCleanupManifest(await readCleanupState(),evidence,{candidateIds:ids.map(String),scope:"unfinished-local"});
  assert.deepEqual(manifest.entries.map(entry=>entry.ref),[refs[0]]);
  assert.equal(manifest.excludedCompleted.length,2);
}));

test("the confirmed no-local-delivery scope retains shipped SOs and excludes Driver deliveries",()=>scenario(async()=>{
  const ids=[817157010,817157011,817157012],refs=["SO-CLEANUP-FINAL-OPEN","SO-CLEANUP-FINAL-SHIPPED","SO-CLEANUP-FINAL-DRIVER"];
  for(let i=0;i<ids.length;i++) await seedSalesOrder(ids[i],refs[i],{status:"B"});
  await query("UPDATE sales_orders SET operator_status='fulfilled',local_yard_order_status='Shipped' WHERE netsuite_id=$1",[ids[1]]);
  await completeDriver(refs[2]);
  const evidence={...remote(ids[0],refs[0]),rows:ids.map((id,i)=>remote(id,refs[i]).rows[0])};
  const manifest=createCleanupManifest(await readCleanupState(),evidence,{candidateIds:ids.map(String),scope:"no-local-delivery"});
  assert.deepEqual(manifest.entries.map(entry=>entry.ref),refs.slice(0,2));
  assert.equal(manifest.excludedCompleted.length,1);
}));

test("the direct local-delivery path preserves NetSuite fields and adds no completion event",()=>scenario(async()=>{
  const id=817157013,ref="SO-CLEANUP-DIRECT-LOCAL";
  await seedSalesOrder(id,ref,{status:"B"});await completeDriver(ref);
  const before=await readCleanupState();
  const manifest=createCleanupManifest(before,remote(id,ref),{candidateIds:[String(id)],scope:"local-delivery-only"});
  assert.equal(manifest.entries.length,1);
  assert.equal(manifest.entries[0].evidence,null);
  assert.equal(manifest.entries[0].after.order.status,"B");
  const result=await applyCleanupManifest(manifest);
  assert.equal(result.changedOrders,1);assert.equal(result.addedCompletions,0);
  const after=await readCleanupState();
  assert.deepEqual(after.completions,before.completions);
  assert.equal(after.orders.find(order=>String(order.netsuite_id)===String(id)).status,"B");
}));
