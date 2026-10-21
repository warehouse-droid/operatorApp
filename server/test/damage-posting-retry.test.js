import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import {query,closeDb} from '../src/db.js';
import {createOperator} from '../src/auth-repository.js';
import {submitDamageReport,getDamageReport,processDamageReport,retryDamageReport,damagePostingTick,reviewDamageMonth} from '../src/inventory-damage-service.js';
import {createInventoryDamageRouter} from '../src/operator-inventory-router.js';

let actor;
const item={item_id:980571,item_name:'UNI-PISAS-COP-SAFARI',location_id:1,item_type:'InvtPart',stock_unit:'PC',sales_unit:'PC',sales_unit_id:554,to_pcs:1};
const dependencies={getItem:async()=>item,verifyPhotos:async()=>{},now:()=>new Date('2026-10-01T12:00:00Z')};
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  actor=await createOperator({username:`damage-retry-${crypto.randomUUID()}`,displayName:'Damage Retry',password:crypto.randomUUID(),operatorYardLocationIds:[1]});
  await query("INSERT INTO inventory_items(item_id,item_name,item_type,stock_unit) VALUES(980571,'UNI-PISAS-COP-SAFARI','InvtPart','PC') ON CONFLICT DO NOTHING");
});
beforeEach(async()=>query('TRUNCATE inventory_damage_adjustments,inventory_damage_photos,inventory_damage_events,inventory_damage_reports,inventory_damage_months RESTART IDENTITY'));
after(closeDb);
function input() {
  const requestId=crypto.randomUUID();
  return {requestId,locationId:1,itemId:item.item_id,values:{pieces:18},reasonId:5,
    photos:[`r2://operator/operator-damage-photo/2026/10/01/${actor.id}/yard-1/${requestId}/original.jpg`]};
}
const manualLine={line:1,item:{id:String(item.item_id),refName:item.item_name},adjustQtyBy:18,units:'554',custcol_atlas_rc_so:{id:'5'},description:'Pisa Smooth Coping Safari'};
function transport(existing=false) {
  let record=existing?{id:1031838,tranId:'IT00571',memo:'3445 2026 Oct Damage / retain manual note',location:{id:'1'},transferLocation:{id:'10'},inventory:{items:[structuredClone(manualLine)]}}:null;
  const calls=[];
  const result={calls,
    directory:async()=>[{id:1,name:'3445',subsidiary:1},{id:10,name:'3445 Damage',parent:1}],
    findMonthly:async()=>record?[structuredClone(record)]:[],
    findExternal:async id=>record?.externalId===id?structuredClone(record):null,
    get:async()=>structuredClone(record),
    create:async payload=>{calls.push('create');record={...structuredClone(payload),id:1031838,tranId:'IT00571',inventory:{items:payload.inventory.items.map((line,index)=>({...structuredClone(line),line:index+1,description:'Pisa Smooth Coping Safari'}))}};return structuredClone(record);},
    append:async(_id,line,options={})=>{calls.push('append');if(options.memo!==undefined)record.memo=options.memo;record.inventory.items.push({...structuredClone(line),line:record.inventory.items.length+1,description:'Pisa Smooth Coping Safari'});},
    record:()=>record
  };
  return result;
}
for(const mode of ['create','append']) {
  test(`P1/P2: ${mode} confirms an accepted line when NetSuite ignores description; identical old line is preserved`,async()=>{
    const remote=transport(mode==='append');
    const report=await submitDamageReport(actor,input(),dependencies);
    await processDamageReport(report.id,{remote});
    const saved=await getDamageReport(actor,report.id);
    assert.equal(saved.status,'posted',saved.last_error);
    assert.equal(saved.transfer_line,mode==='append'?2:1);
    assert.equal(saved.photos.length,1);assert.equal(Number(saved.quantity),18);
    assert.ok(remote.record().memo.includes(report.id),'The durable transfer receipt must identify this report');
    if(mode==='append') {assert.deepEqual(remote.record().inventory.items[0],manualLine);assert.match(remote.record().memo,/retain manual note/);}
    await retryDamageReport(actor,report.id,{remote});assert.deepEqual(remote.calls,[mode]);
    const review=await reviewDamageMonth(actor,1,'2026-10',{remote});
    const linked=review.reports.find(row=>row.id===report.id);assert.equal(linked.status,'posted');assert.equal(linked.photos.length,1);
    assert.equal(review.reports.filter(row=>row.id===report.id).length,1);
  });
  test(`P3: ${mode} lost response recovers the saved proof after restart without another transfer`,async()=>{
    const remote=transport(mode==='append'),write=remote[mode];
    remote[mode]=async(...args)=>{await write(...args);throw new Error('Connection lost after NetSuite committed');};
    const report=await submitDamageReport(actor,input(),dependencies);
    await processDamageReport(report.id,{remote});
    let saved=await getDamageReport(actor,report.id);assert.equal(saved.status,'attention');assert.equal(saved.safe_to_retry,false);
    await retryDamageReport(actor,report.id,{remote});
    saved=await getDamageReport(actor,report.id);assert.equal(saved.status,'posted',saved.last_error);
    assert.deepEqual(remote.calls,[mode]);assert.equal(remote.record().inventory.items.length,mode==='append'?2:1);
  });
}
test('P4: two identical reports are distinct appended lines and parallel retries never append twice',async()=>{
  const remote=transport(true);
  const a=await submitDamageReport(actor,input(),dependencies),b=await submitDamageReport(actor,input(),dependencies);
  await processDamageReport(a.id,{remote});await processDamageReport(b.id,{remote});
  await Promise.all(Array.from({length:12},()=>retryDamageReport(actor,b.id,{remote})));
  const savedA=await getDamageReport(actor,a.id),savedB=await getDamageReport(actor,b.id);
  assert.equal(savedA.status,'posted');assert.equal(savedB.status,'posted');
  assert.equal(savedA.transfer_line,2);assert.equal(savedB.transfer_line,3);
  assert.equal(remote.record().inventory.items.length,3);assert.deepEqual(remote.calls,['append','append']);
  const review=await reviewDamageMonth(actor,1,'2026-10',{remote});assert.equal(review.reports.filter(row=>!row.legacy).length,2);
});
for(const corruption of ['missing receipt','different receipt','old quantity changed','extra identical line','wrong new quantity','wrong new unit','wrong new reason','wrong destination']) {
  test(`P3: ${corruption} prevents false confirmation and another write`,async()=>{
    const remote=transport(true),append=remote.append;
    remote.append=async(...args)=>{await append(...args);throw new Error('Lost response');};
    const report=await submitDamageReport(actor,input(),dependencies);await processDamageReport(report.id,{remote});
    const record=remote.record(),newLine=record.inventory.items[1];
    if(corruption==='missing receipt')record.memo='3445 2026 Oct Damage';
    if(corruption==='different receipt')record.memo=`3445 2026 Oct Damage [DMG:${crypto.randomUUID()}]`;
    if(corruption==='old quantity changed')record.inventory.items[0].adjustQtyBy=99;
    if(corruption==='extra identical line')record.inventory.items.push({...structuredClone(newLine),line:3});
    if(corruption==='wrong new quantity')newLine.adjustQtyBy=19;
    if(corruption==='wrong new unit')newLine.units='555';
    if(corruption==='wrong new reason')newLine.custcol_atlas_rc_so.id='6';
    if(corruption==='wrong destination')record.transferLocation.id='11';
    await retryDamageReport(actor,report.id,{remote});
    const saved=await getDamageReport(actor,report.id);assert.equal(saved.status,'attention');assert.equal(saved.safe_to_retry,false);
    assert.deepEqual(remote.calls,['append']);
  });
}
test('P4: definite failure waits for operator retry and retains original quantity and photos',async()=>{
  const remote=transport(),create=remote.create;
  remote.create=async()=>{remote.calls.push('rejected');throw Object.assign(new Error('Closed inventory period'),{status:400,netsuiteResponseReceived:true});};
  const report=await submitDamageReport(actor,input(),dependencies);await processDamageReport(report.id,{remote});
  let saved=await getDamageReport(actor,report.id);assert.equal(saved.safe_to_retry,true);assert.equal(Number(saved.quantity),18);assert.equal(saved.photos.length,1);
  await damagePostingTick({remote});assert.deepEqual(remote.calls,['rejected']);
  remote.create=create;await retryDamageReport(actor,report.id,{remote});
  saved=await getDamageReport(actor,report.id);assert.equal(saved.status,'posted',saved.last_error);assert.equal(saved.photos.length,1);
  assert.deepEqual(remote.calls,['rejected','create']);
});
test('P5: a superseded report retains evidence, cannot retry, and does not fence the month',async()=>{
  const remote=transport(true),duplicate=await submitDamageReport(actor,input(),dependencies);
  const replacement=await submitDamageReport(actor,input(),dependencies);
  await query("UPDATE inventory_damage_reports SET status='attention',safe_to_retry=false WHERE id=$1",[duplicate.id]);
  await query("INSERT INTO inventory_damage_events(report_id,action,details) VALUES($1,'superseded',$2)",[duplicate.id,JSON.stringify({replacementReportId:replacement.id})]);
  const saved=await retryDamageReport(actor,duplicate.id,{remote});assert.equal(saved.status,'superseded');
  assert.equal(saved.photos.length,1);assert.equal(Number(saved.quantity),18);assert.equal(saved.superseded_by,replacement.id);
  assert.equal(remote.calls.length,0);
  await processDamageReport(replacement.id,{remote});assert.equal((await getDamageReport(actor,replacement.id)).status,'posted');
  assert.deepEqual(remote.calls,['append']);
});
test('P2: the durable before-write audit and posting state are committed before the network mutation',async()=>{
  const remote=transport(true),append=remote.append,report=await submitDamageReport(actor,input(),dependencies);
  remote.append=async(...args)=>{
    const saved=await getDamageReport(actor,report.id);
    const proof=(await query("SELECT details FROM inventory_damage_events WHERE report_id=$1 AND action='posting_started'",[report.id])).rows;
    assert.equal(saved.status,'posting');assert.equal(saved.safe_to_retry,false);assert.equal(saved.attempt_count,1);
    assert.equal(proof.length,1);assert.equal(proof[0].details.reportId,report.id);assert.equal(proof[0].details.lines.length,1);
    assert.equal(proof[0].details.lines[0].quantity,18);assert.equal(proof[0].details.lines[0].line,1);
    assert.equal(proof[0].details.memo,args[2].memo);
    await append(...args);
  };
  await processDamageReport(report.id,{remote});assert.equal((await getDamageReport(actor,report.id)).status,'posted');
});
test('P4: concurrent rechecks of an uncertain accepted append do not send it again',async()=>{
  const remote=transport(true),append=remote.append,report=await submitDamageReport(actor,input(),dependencies);
  remote.append=async(...args)=>{await append(...args);throw new Error('Lost response');};
  await processDamageReport(report.id,{remote});
  await Promise.all(Array.from({length:12},()=>retryDamageReport(actor,report.id,{remote})));
  assert.equal((await getDamageReport(actor,report.id)).status,'posted');assert.deepEqual(remote.calls,['append']);
  assert.equal(remote.record().inventory.items.length,2);
});
test('D5: the local status endpoint reads the saved report and photos without querying NetSuite',async()=>{
  const report=await submitDamageReport(actor,input(),dependencies),remote=transport();
  remote.findMonthly=()=>assert.fail('Initial entry must not query NetSuite history');
  const app=express();app.use((req,_res,next)=>{req.operator=actor;next();});app.use(createInventoryDamageRouter({remote}));
  app.use((error,_req,res,_next)=>res.status(error.status || 500).json({error:error.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const response=await fetch(base+'/reports?locationId=1&month=2026-10&local=true');assert.equal(response.status,200);
    const body=await response.json();assert.equal(body.reports.length,1);assert.equal(body.reports[0].id,report.id);assert.equal(body.reports[0].photos.length,1);
    assert.equal((await fetch(base+'/reports?locationId=28&month=2026-10&local=true')).status,403);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
