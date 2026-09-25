import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb} from '../src/db.js';
import {createOperator} from '../src/auth-repository.js';
import {createCountSheet,listCountSheets,getCountSheet,changeCountSheet} from '../src/count-sheet-repository.js';
let a,b,manager,other;
const items=Array.from({length:10},(_,i)=>980100+i);
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  for(const [name,role,yards] of [['a','operator',[1]],['b','operator',[1]],['manager','yard_manager',[1]],['other','yard_manager',[28]]]) {
    const actor=await createOperator({username:`sheet-${name}-${crypto.randomUUID()}`,displayName:name,password:crypto.randomUUID(),role,operatorYardLocationIds:yards,yardLocationIds:yards});
    if(name==='a') a=actor; else if(name==='b') b=actor; else if(name==='manager') manager=actor; else other=actor;
  }
  for(const id of items) {
    await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_plt,to_pcs) VALUES($1,$2,'PCS',10,1) ON CONFLICT(item_id) DO NOTHING",[id,`Count SKU ${id}`]);
    await query('INSERT INTO inventory_balances(item_id,location_id,quantity_on_hand,quantity_available) VALUES($1,1,100,90) ON CONFLICT DO NOTHING',[id]);
  }
});
after(closeDb);
const create=(ids=items)=>createCountSheet(manager,{locationId:1,title:'Ten SKUs',itemIds:ids,requestId:crypto.randomUUID()});
test('C1/A1: scoped explicit list; duplicate/foreign SKU and manager access rejected',async()=>{
  const sheet=await create(); assert.equal(sheet.items.length,10); assert.equal(sheet.status,'available');
  assert.equal((await listCountSheets(a)).some(row=>row.id===sheet.id),true);
  await assert.rejects(getCountSheet(other,sheet.id,{management:true}),{status:403});
  await assert.rejects(createCountSheet(a,{locationId:1,itemIds:items,requestId:crypto.randomUUID()}),{status:403});
  await assert.rejects(create([items[0],items[0]])); await assert.rejects(create([999999999]));
});
test('C2: concurrent claims have exactly one owner and private counts',async()=>{
  const sheet=await create();
  const claims=await Promise.allSettled([changeCountSheet(a,sheet.id,'take',{}),changeCountSheet(b,sheet.id,'take',{})]);
  assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
  const claimed=claims.find(r=>r.status==='fulfilled').value;
  const loser=claimed.owner_id===a.id?b:a;
  await assert.rejects(getCountSheet(loser,sheet.id),{status:403});
  assert.equal(claimed.items.some(line=>'system_on_hand' in line || 'quantity_on_hand' in line),false);
  const resumed=await getCountSheet(claimed.owner_id===a.id?a:b,sheet.id); assert.equal(resumed.attempt,1);
});
test('C3/C5: all ten SKU counts required; zero is counted; only managers see variance',async()=>{
  let sheet=await create(); sheet=await changeCountSheet(a,sheet.id,'take',{});
  await assert.rejects(changeCountSheet(a,sheet.id,'line',{revision:sheet.revision,attempt:sheet.attempt,itemId:999999,values:{pieces:1}}));
  for(const itemId of items.slice(0,9)) sheet=await changeCountSheet(a,sheet.id,'line',{revision:sheet.revision,attempt:sheet.attempt,itemId,values:{pallets:10}});
  await assert.rejects(changeCountSheet(a,sheet.id,'submit',{revision:sheet.revision,attempt:sheet.attempt}),{status:409});
  sheet=await changeCountSheet(a,sheet.id,'line',{revision:sheet.revision,attempt:sheet.attempt,itemId:items[9],values:{pieces:0}});
  sheet=await changeCountSheet(a,sheet.id,'submit',{revision:sheet.revision,attempt:sheet.attempt});
  assert.equal(sheet.status,'submitted'); assert.equal(sheet.counted,10);
  const review=await getCountSheet(manager,sheet.id,{management:true});
  assert.equal(Number(review.items.find(i=>Number(i.item_id)===items[9]).count.variance),-100);
  assert.equal('variance' in sheet.items[9].count,false);
  await assert.rejects(changeCountSheet(manager,sheet.id,'reset',{revision:sheet.revision},{management:true}),{status:409});
  assert.equal(Number((await query('SELECT quantity_on_hand FROM inventory_balances WHERE item_id=$1 AND location_id=1',[items[9]])).rows[0].quantity_on_hand),100);
});
test('C4: reset preserves audit and invalidates old owner and old generation',async()=>{
  let sheet=await create([items[0]]); sheet=await changeCountSheet(a,sheet.id,'take',{});
  sheet=await changeCountSheet(a,sheet.id,'line',{revision:sheet.revision,attempt:sheet.attempt,itemId:items[0],values:{pieces:7}});
  const stale={revision:sheet.revision,attempt:sheet.attempt,itemId:items[0],values:{pieces:9}};
  sheet=await changeCountSheet(manager,sheet.id,'reset',{revision:sheet.revision},{management:true});
  assert.equal(sheet.counted,0); assert.equal(sheet.status,'available');
  await assert.rejects(changeCountSheet(a,sheet.id,'line',stale),{status:409});
  sheet=await changeCountSheet(b,sheet.id,'take',{}); assert.equal(sheet.attempt,2);
  await assert.rejects(changeCountSheet(a,sheet.id,'submit',stale),{status:409});
  const review=await getCountSheet(manager,sheet.id,{management:true});
  assert.equal(review.history.some(e=>e.action==='reset'),true);
  assert.equal(review.attempts.some(c=>Number(c.quantity)===7),true);
});
test('C1/C4: available editing and cancellation are fenced',async()=>{
  let sheet=await create([items[0]]);
  await assert.rejects(changeCountSheet(manager,sheet.id,'reset',{revision:sheet.revision},{management:true}),{status:409});
  sheet=await changeCountSheet(manager,sheet.id,'edit',{revision:sheet.revision,title:'Updated',itemIds:[items[1]]},{management:true});
  assert.equal(Number(sheet.items[0].item_id),items[1]);
  sheet=await changeCountSheet(a,sheet.id,'take',{});
  await assert.rejects(changeCountSheet(manager,sheet.id,'edit',{revision:sheet.revision,itemIds:items},{management:true}),{status:409});
  sheet=await changeCountSheet(manager,sheet.id,'cancel',{revision:sheet.revision},{management:true});
  assert.equal(sheet.status,'cancelled'); await assert.rejects(changeCountSheet(a,sheet.id,'take',{}),{status:409});
});
test('C4: a reset racing with a save never leaks a count into the next attempt',async()=>{
  let sheet=await create([items[0]]);sheet=await changeCountSheet(a,sheet.id,'take',{});
  const outcomes=await Promise.allSettled([
    changeCountSheet(a,sheet.id,'line',{revision:sheet.revision,attempt:sheet.attempt,itemId:items[0],values:{pieces:11}}),
    changeCountSheet(manager,sheet.id,'reset',{revision:sheet.revision},{management:true})
  ]);
  assert.equal(outcomes.filter(outcome=>outcome.status==='fulfilled').length,1);
  sheet=await getCountSheet(manager,sheet.id,{management:true});
  if(sheet.status==='in_progress') sheet=await changeCountSheet(manager,sheet.id,'reset',{revision:sheet.revision},{management:true});
  const next=await changeCountSheet(b,sheet.id,'take',{});
  assert.equal(next.counted,0);assert.equal(next.attempt,2);assert.equal(next.items[0].count,null);
});
test('C1: creation retries are identical; malformed request IDs and changed retries fail',async()=>{
  const input={locationId:1,itemIds:[items[0]],requestId:crypto.randomUUID(),title:'Stable'};
  const sheets=await Promise.all(Array.from({length:4},()=>createCountSheet(manager,input)));
  assert.equal(new Set(sheets.map(sheet=>sheet.id)).size,1);
  await assert.rejects(createCountSheet(manager,{...input,title:'Different'}),{status:409});
  await assert.rejects(createCountSheet(manager,{...input,requestId:'-'.repeat(36)}),{status:400});
});
