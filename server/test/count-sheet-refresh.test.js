import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import fc from 'fast-check';
import {query,closeDb,hasActiveTransaction} from '../src/db.js';
import {createOperator} from '../src/auth-repository.js';
import {createCountSheet,getCountSheet,changeCountSheet} from '../src/count-sheet-repository.js';
import {refreshCountSheetInventory} from '../src/count-sheet-stock-refresh.js';
import {createCountSheetRouter} from '../src/operator-inventory-router.js';

let operator,manager,other,foreign;
const ids=Array.from({length:201},(_,i)=>981200+i);
const remoteRow=id=>({item_id:id,item_name:`Refresh ${id}`,item_type:'InvtPart',stock_unit:'SQFT',location_id:1,
  location:'3445',quantity_on_hand:'767.24',quantity_available:'76.70',quantity_on_order:'0',quantity_backordered:'0',to_plt:102.3,to_lyr:12.79});
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  const actors=[];
  for(const [role,yards] of [['operator',[1]],['yard_manager',[1]],['operator',[1]],['operator',[28]]]) {
    actors.push(await createOperator({username:`refresh-${crypto.randomUUID()}`,password:crypto.randomUUID(),displayName:role,role,operatorYardLocationIds:yards,yardLocationIds:yards}));
  }
  [operator,manager,other,foreign]=actors;
  for(const id of ids) {
    await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_lyr) VALUES($1,$2,'SQFT',12.79) ON CONFLICT DO NOTHING",[id,`Refresh ${id}`]);
    for(const yard of [1,28]) {await query("INSERT INTO inventory_balances(item_id,location_id,quantity_on_hand,quantity_available,synced_at) VALUES($1,$2,1086.93,396.39,'2000-01-01') ON CONFLICT DO NOTHING",[id,yard]);}
  }
});
after(closeDb);
async function sheetFor(itemIds=ids.slice(0,2)) {
  await query("UPDATE inventory_balances SET quantity_on_hand=1086.93,quantity_available=396.39,synced_at='2000-01-01' WHERE item_id=ANY($1::bigint[])",[itemIds]);
  const sheet=await createCountSheet(manager,{requestId:crypto.randomUUID(),locationId:1,title:'Refresh test',itemIds});
  return changeCountSheet(operator,sheet.id,'take',{});
}
const balances=async itemIds=>(await query('SELECT * FROM inventory_balances WHERE item_id=ANY($1::bigint[]) ORDER BY item_id,location_id',[itemIds])).rows;
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('S1: exact sheet SKU/yard refresh is awaited and next count freezes the fresh stock',async()=>{
  const sheet=await sheetFor(),untouched=await balances([ids[2]]),beforeRows=await balances(ids.slice(0,2));let calls=0;
  const refreshed=await refreshCountSheetInventory(operator,sheet.id,{fetchBalances:async(items,yards)=>{
    calls++;assert.deepEqual(items,ids.slice(0,2));assert.deepEqual(yards,[1]);assert.equal(hasActiveTransaction(),false);
    return items.map(remoteRow);
  }});
  assert.equal(calls,1);assert.equal(refreshed.revision,sheet.revision);assert.equal(refreshed.owner_id,operator.id);
  assert.equal(refreshed.items[0].to_plt,'102.3');
  assert.deepEqual(await balances([ids[2]]),untouched);
  assert.deepEqual((await balances(ids.slice(0,2))).filter(r=>Number(r.location_id)===28),beforeRows.filter(r=>Number(r.location_id)===28));
  await changeCountSheet(operator,sheet.id,'line',{revision:sheet.revision,attempt:sheet.attempt,itemId:ids[0],values:{layers:5}});
  const review=await getCountSheet(manager,sheet.id,{management:true}),count=review.items[0].count;
  assert.equal(Number(count.quantity),63.95);assert.equal(Number(count.system_on_hand),767.24);assert.equal(Number(count.system_available),76.7);
  assert.equal(Number(count.variance),-703.29);assert.ok(new Date(count.inventory_synced_at).getTime()>Date.now()-15000);
  assert.equal('system_on_hand' in refreshed.items[0],false);
});
test('S2: network failure leaves cache unchanged and the next refresh can retry',async()=>{
  const sheet=await sheetFor(),beforeRows=await balances(ids.slice(0,2));let calls=0;
  await assert.rejects(refreshCountSheetInventory(operator,sheet.id,{fetchBalances:async()=>{calls++;throw new Error('NetSuite unavailable');}}),{status:503,code:'COUNT_SHEET_REFRESH_FAILED'});
  assert.equal(calls,1);assert.deepEqual(await balances(ids.slice(0,2)),beforeRows);
  await refreshCountSheetInventory(operator,sheet.id,{fetchBalances:async items=>items.map(remoteRow)});
  assert.equal(Number((await balances(ids.slice(0,1)))[0].quantity_on_hand),767.24);
});
for(const [name,change] of [
  ['missing',rows=>rows.slice(0,1)],['duplicate',rows=>[rows[0],rows[0]]],
  ['foreign SKU',rows=>[rows[0],remoteRow(ids[2])]],['foreign yard',rows=>rows.map(r=>({...r,location_id:28}))],
  ['nonfinite',rows=>rows.map(r=>({...r,quantity_on_hand:'NaN'}))],['missing available',rows=>rows.map(r=>({...r,quantity_available:null}))],
  ['empty quantity',rows=>rows.map(r=>({...r,quantity_on_hand:''}))],['invalid result',()=>null],
  ['boolean quantity',rows=>rows.map(r=>({...r,quantity_on_hand:true}))],['array quantity',rows=>rows.map(r=>({...r,quantity_available:[5]}))]
]) {test(`S2: ${name} response cannot partially update the inventory cache`,async()=>{
  const sheet=await sheetFor(),beforeRows=await balances(ids.slice(0,3));let called=false;
  await assert.rejects(refreshCountSheetInventory(operator,sheet.id,{fetchBalances:async items=>{called=true;return change(items.map(remoteRow));}}),{status:503,code:'COUNT_SHEET_REFRESH_FAILED'});
  assert.equal(called,true);assert.deepEqual(await balances(ids.slice(0,3)),beforeRows);
});}
test('S3: owner and yard authorization run before the remote read',async()=>{
  const sheet=await sheetFor();let calls=0;
  for(const actor of [other,foreign]) {await assert.rejects(refreshCountSheetInventory(actor,sheet.id,{fetchBalances:async()=>{calls++;return [];}}),{status:403});}
  assert.equal(calls,0);
});
for(const action of ['reset','cancel','line']) {test(`S3: ${action} during a delayed read completes immediately and invalidates the response`,async()=>{
  const sheet=await sheetFor(),beforeRows=await balances(ids.slice(0,2)),started=deferred(),release=deferred();
  const refresh=refreshCountSheetInventory(operator,sheet.id,{fetchBalances:async items=>{
    assert.equal(hasActiveTransaction(),false);started.resolve();await release.promise;return items.map(remoteRow);
  }});
  const rejected=assert.rejects(refresh,error=>error.status===409 || error.status===403);
  await Promise.race([started.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Remote read never started')),1500))]);
  const command=action==='line'?changeCountSheet(operator,sheet.id,'line',{revision:sheet.revision,attempt:sheet.attempt,itemId:ids[0],values:{layers:1}})
    :changeCountSheet(manager,sheet.id,action,{revision:sheet.revision},{management:true});
  await Promise.race([command,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Refresh blocked the sheet lock')),1500))]);
  release.resolve();await rejected;assert.deepEqual(await balances(ids.slice(0,2)),beforeRows);
});}
test('S4: refreshing keeps prior confirmed snapshots, count history and blind response intact',async()=>{
  let sheet=await sheetFor();sheet=await changeCountSheet(operator,sheet.id,'line',{revision:sheet.revision,attempt:sheet.attempt,itemId:ids[0],values:{layers:5}});
  const beforeReview=await getCountSheet(manager,sheet.id,{management:true});
  const refreshed=await refreshCountSheetInventory(operator,sheet.id,{fetchBalances:async items=>items.map(remoteRow)});
  const afterReview=await getCountSheet(manager,sheet.id,{management:true});
  assert.deepEqual(afterReview.items[0].count,beforeReview.items[0].count);assert.deepEqual(afterReview.history,beforeReview.history);
  assert.equal(afterReview.revision,beforeReview.revision);assert.equal('variance' in refreshed.items[0].count,false);
  assert.equal(JSON.stringify(refreshed).includes('767.24'),false);
});
test('S4: completed reviews skip remote refresh and preserve their snapshots',async()=>{
  for(const status of ['submitted','cancelled']) {
    let sheet=await sheetFor(ids.slice(0,1));
    if(status==='submitted') {
      sheet=await changeCountSheet(operator,sheet.id,'line',{revision:sheet.revision,attempt:sheet.attempt,itemId:ids[0],values:{layers:5}});
      sheet=await changeCountSheet(operator,sheet.id,'submit',{revision:sheet.revision,attempt:sheet.attempt});
    } else {await changeCountSheet(manager,sheet.id,'cancel',{revision:sheet.revision},{management:true});sheet=await getCountSheet(operator,sheet.id);}
    const result=await refreshCountSheetInventory(operator,sheet.id,{fetchBalances:async()=>{assert.fail('Completed sheets are historical');}});
    assert.deepEqual(result,sheet);
  }
});
test('S5: 181 items batch as 180 plus 1; failed final batch commits no rows',async()=>{
  const sheet=await sheetFor(ids.slice(0,181)),beforeRows=await balances(ids.slice(0,181)),calls=[];
  await assert.rejects(refreshCountSheetInventory(operator,sheet.id,{fetchBalances:async(items,yards)=>{
    calls.push({items,yards});if(calls.length===2){throw new Error('second batch failed');}return items.map(remoteRow);
  }}),{status:503});
  assert.deepEqual(calls.map(c=>c.items.length),[180,1]);assert.deepEqual(calls.flatMap(c=>c.items),ids.slice(0,181));
  assert.ok(calls.every(c=>c.yards.length===1 && c.yards[0]===1));assert.deepEqual(await balances(ids.slice(0,181)),beforeRows);
  await refreshCountSheetInventory(operator,sheet.id,{fetchBalances:async items=>items.map(remoteRow)});
  assert.equal(Number((await balances([ids[180]]))[0].quantity_on_hand),767.24);
});
test('S5: generated assignments refresh every selected SKU exactly once and no other SKU',async()=>{
  await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.integer({min:0,max:25}),{minLength:1,maxLength:15}),async indexes=>{
    const selected=indexes.map(index=>ids[index]),sheet=await sheetFor(selected),calls=[];
    await refreshCountSheetInventory(operator,sheet.id,{fetchBalances:async(items,yards)=>{calls.push(...items);assert.deepEqual(yards,[1]);return items.map(remoteRow);}});
    assert.deepEqual(calls,selected);assert.equal(new Set(calls).size,selected.length);
    const rows=await balances(selected);assert.ok(rows.filter(r=>Number(r.location_id)===1).every(r=>Number(r.quantity_on_hand)===767.24));
  }),{seed:3102026,numRuns:20});
});
test('S1/S3: refresh HTTP route uses server sheet scope and rejects the management route',async()=>{
  const sheet=await sheetFor(),calls=[],app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.operator=operator;next();});
  app.use('/operator',createCountSheetRouter({fetchCountSheetBalances:async(items,yards)=>{calls.push({items,yards});return items.map(remoteRow);}}));
  app.use('/control',createCountSheetRouter({management:true}));
  app.use((error,_req,res,_next)=>res.status(error.status || 500).json({error:error.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try {
    const body=JSON.stringify({locationId:28,itemIds:[ids[2]]}),options={method:'POST',headers:{'content-type':'application/json'},body};
    const response=await fetch(`http://127.0.0.1:${server.address().port}/operator/${sheet.id}/refresh-inventory`,options);
    assert.equal(response.status,200);assert.equal((await response.json()).id,sheet.id);
    assert.deepEqual(calls,[{items:ids.slice(0,2),yards:[1]}]);
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/control/${sheet.id}/refresh-inventory`,options)).status,400);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
