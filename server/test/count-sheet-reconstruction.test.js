import test,{before as beforeAll,after as afterAll} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb} from '../src/db.js';
import {createOperator} from '../src/auth-repository.js';
import {createCountSheet,changeCountSheet,getCountSheet} from '../src/count-sheet-repository.js';
import {countSheetReconstructionState,reconstructCountSheetComparison} from '../src/count-sheet-reconstruction.js';
import {confirmFreshCycleCount,blindCycleCount} from '../src/cycle-count-stock-refresh.js';
const itemId=982400;
let operator,manager;
const row={item_id:itemId,location_id:1,quantity_on_hand:86.7,quantity_available:76.7,item_name:'Reconstruct',stock_unit:'SQFT',to_lyr:12.79};
beforeAll(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  operator=await createOperator({username:crypto.randomUUID(),password:crypto.randomUUID(),displayName:'Counter',role:'operator',operatorYardLocationIds:[1]});
  manager=await createOperator({username:crypto.randomUUID(),password:crypto.randomUUID(),displayName:'Reviewer',role:'yard_manager',yardLocationIds:[1]});
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_lyr) VALUES($1,'Reconstruct','SQFT',12.79) ON CONFLICT DO NOTHING",[itemId]);
  await query("INSERT INTO inventory_balances(item_id,location_id,quantity_on_hand,quantity_available) VALUES($1,1,1086.93,396.39) ON CONFLICT(item_id,location_id) DO UPDATE SET quantity_on_hand=1086.93",[itemId]);
});
afterAll(closeDb);
async function submittedSheet() {
  let s=await createCountSheet(manager,{locationId:1,title:'Reconstruction test',itemIds:[itemId],requestId:crypto.randomUUID()});
  s=await changeCountSheet(operator,s.id,'take',{});
  s=await changeCountSheet(operator,s.id,'line',{revision:s.revision,attempt:s.attempt,itemId,values:{layers:5}});
  return changeCountSheet(operator,s.id,'submit',{revision:s.revision,attempt:s.attempt});
}
const options=(s,state)=>({sheetId:s.id,expectedTitle:s.title,expectedFingerprint:state.fingerprint,balances:[row],observedAt:new Date().toISOString()});
test('P5: reconstruction is guarded, auditable, rollback-safe and preserves the physical count',async()=>{
  const s=await submittedSheet(),before=await getCountSheet(manager,s.id,{management:true});
  const state=await countSheetReconstructionState(s.id);
  const rehearsal=await reconstructCountSheetComparison({...options(s,state),rollback:true});
  assert.equal(Number(rehearsal.items[0].actual_on_hand),86.7);
  assert.deepEqual(await getCountSheet(manager,s.id,{management:true}),before,'rollback preserves every original row and audit event');
  const result=await reconstructCountSheetComparison(options(s,state));
  const after=await getCountSheet(manager,s.id,{management:true}),count=after.items[0].count;
  for(const key of ['quantity','unit','values','conversions','operator_id','confirmed_at']) {assert.deepEqual(count[key],before.items[0].count[key],key);}
  assert.equal(after.submitted_at.toISOString(),before.submitted_at.toISOString());
  assert.equal(count.comparison_basis,'reconstructed_current');assert.equal(Number(count.variance),-22.75);
  assert.equal(Number(count.packed_qty),0);assert.ok(count.packed_snapshot_at);
  const event=after.history.find(e=>e.action==='comparison_reconstructed');
  assert.equal(event.actor_id,null);assert.equal(event.details.before[0].system_on_hand,before.items[0].count.system_on_hand);
  assert.equal(event.details.basis,'current_stock');assert.equal(event.details.after[0].variance,result.items[0].variance);
  await assert.rejects(reconstructCountSheetComparison(options(s,state)),/changed/i);
});
test('P5: wrong title, incomplete rows and non-submitted sheets cannot be reconstructed',async()=>{
  const s=await submittedSheet(),state=await countSheetReconstructionState(s.id),input=options(s,state);
  await assert.rejects(reconstructCountSheetComparison({...input,expectedTitle:'Other sheet'}),/target/i);
  await assert.rejects(reconstructCountSheetComparison({...input,balances:[]}),/refresh/i);
  await assert.rejects(reconstructCountSheetComparison({...input,observedAt:'bad date'}),/time/i);
  await query("UPDATE inventory_count_sheets SET status='in_progress' WHERE id=$1",[s.id]);
  await assert.rejects(reconstructCountSheetComparison(input),/submitted/i);
});
test('P6: cycle count waits for a valid refresh, stays blind, and scopes the read to the allowed yard',async()=>{
  let called=0,release,start;
  const ready=new Promise(resolve=>{start=resolve;}),wait=new Promise(resolve=>{release=resolve;});
  const pending=confirmFreshCycleCount(operator,{itemId,locationId:1,layers:5},{fetchBalances:async(ids,yards)=>{
    called++;assert.deepEqual(ids,[itemId]);assert.deepEqual(yards,[1]);start();await wait;return [row];
  }});
  await ready;
  assert.equal((await query('SELECT 1 FROM cycle_count_lines l JOIN cycle_count_records r ON r.id=l.record_id WHERE r.operator_id=$1',[operator.id])).rowCount,0);
  release();const draft=await pending;assert.equal(called,1);
  assert.equal(Number(draft.lines[0].counted_total_qty),63.95);
  for(const key of ['system_on_hand_qty','system_available_qty','system_packed_qty','actual_on_hand_qty','variance_qty']) {assert.equal(key in draft.lines[0],false,key);}
  const saved=(await query('SELECT l.* FROM cycle_count_lines l WHERE l.record_id=$1',[draft.id])).rows[0];
  assert.equal(Number(saved.system_on_hand_qty),86.7);assert.equal(Number(saved.variance_qty),-22.75);
  assert.deepEqual(blindCycleCount({id:1,lines:[{counted_total_qty:5,variance_qty:100,system_on_hand_qty:105,system_packed_qty:3,actual_on_hand_qty:102,system_available_qty:4}]}),{id:1,lines:[{counted_total_qty:5}]});
});
test('P6: failed or invalid cycle refresh never confirms; authorization precedes external reads',async()=>{
  const before=(await query('SELECT * FROM cycle_count_lines ORDER BY id')).rows;
  for(const fetchBalances of [async()=>{throw new Error('offline');},async()=>[],async()=>[{...row,location_id:28}]]) {
    await assert.rejects(confirmFreshCycleCount(operator,{itemId,locationId:1,layers:8},{fetchBalances}),{status:503});
  }
  await assert.rejects(confirmFreshCycleCount(operator,{itemId,locationId:28,layers:8},{fetchBalances:()=>assert.fail('unauthorized external read')}),{status:403});
  assert.deepEqual((await query('SELECT * FROM cycle_count_lines ORDER BY id')).rows,before);
});
