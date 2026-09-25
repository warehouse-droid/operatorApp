import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb} from '../src/db.js';
import {createOperator} from '../src/auth-repository.js';
import {submitDamageReport,getDamageReport,processDamageReport,reviewDamageMonth,retryDamageReport,damagePostingTick} from '../src/inventory-damage-service.js';
let actor;
const item={item_id:980200,item_name:'Damage SKU',location_id:1,item_type:'InvtPart',stock_unit:'PCS',sales_unit:'PCS',sales_unit_id:191,to_plt:40,to_pcs:1};
const dependencies={getItem:async()=>item,verifyPhotos:async()=>{},now:()=>new Date('2026-09-23T12:00:00Z')};
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  actor=await createOperator({username:`damage-${crypto.randomUUID()}`,displayName:'Damage Test',password:crypto.randomUUID(),operatorYardLocationIds:[1]});
  await query("INSERT INTO inventory_items(item_id,item_name,item_type,stock_unit) VALUES(980200,'Damage SKU','InvtPart','PCS') ON CONFLICT DO NOTHING");
});
beforeEach(async()=>query('TRUNCATE inventory_damage_adjustments,inventory_damage_photos,inventory_damage_events,inventory_damage_reports,inventory_damage_months RESTART IDENTITY'));
after(closeDb);
function input(overrides={}) {
  const requestId=crypto.randomUUID();
  return {requestId,locationId:1,itemId:item.item_id,values:{pieces:3},reasonId:7,photos:[`r2://operator/operator-damage-photo/2026/09/23/${actor.id}/yard-1/${requestId}/photo.jpg`],...overrides};
}
function transport(existing=[]) {
  const records=new Map(existing.map(r=>[Number(r.id),structuredClone(r)])); let next=990000;
  const calls=[];
  return {records,calls,
    directory:async()=>[{id:1,name:'3445',subsidiary:1},{id:10,name:'3445 Damage',parent:1}],
    findMonthly:async()=>[...records.values()],
    findExternal:async id=>[...records.values()].find(r=>r.externalId===id) || null,
    get:async id=>structuredClone(records.get(Number(id))),
    create:async payload=>{calls.push(['create',structuredClone(payload)]); const id=next++; const row={...structuredClone(payload),id,tranId:`IT${id}`,inventory:{items:payload.inventory.items.map((l,i)=>({...l,line:i+1}))}};records.set(id,row);return row;},
    append:async(id,line)=>{calls.push(['append',structuredClone(line)]); const record=records.get(Number(id)); record.inventory.items.push({...structuredClone(line),line:record.inventory.items.length+1});return record;}
  };
}
function existing(id=998187) {return {id,tranId:'IT00551',memo:'3445 2026 Sep Damage',location:{id:'1'},transferLocation:{id:'10'},inventory:{items:[{item:{id:'1256',refName:'BWS-GD-CURB-CHAR'},adjustQtyBy:3,units:'191',line:1,description:'Manual existing line'}]}};}
for(const mode of ['create','append']) {
  test(`D8: ${mode} respects the 40-character NetSuite description contract and reconciles once`,async()=>{
    const remote=transport(mode==='append'?[existing()]:[]);
    const {create,append}=remote;
    const validate=line=>{
      if(line.description.length>40) throw Object.assign(new Error('The field description contained more than the maximum number ( 40 ) of characters allowed.'),{status:400,netsuiteResponseReceived:true});
    };
    remote.create=async payload=>{payload.inventory.items.forEach(validate);return create(payload);};
    remote.append=async(id,line)=>{validate(line);return append(id,line);};
    const report=await submitDamageReport(actor,input(),{...dependencies,getItem:async()=>({...item,item_name:'UNI-WIN70S-0714-DC with a long display name'})});
    await processDamageReport(report.id,{remote});
    const saved=await getDamageReport(actor,report.id);
    assert.equal(saved.status,'posted',saved.last_error);
    const record=remote.records.get(Number(saved.transfer_id));
    const line=record.inventory.items.at(-1);
    assert.ok(line.description.length<=40);
    assert.ok(line.description.includes(report.id),'complete unique report identity must survive');
    await retryDamageReport(actor,report.id,{remote});
    assert.equal(remote.calls.length,1);
    const review=await reviewDamageMonth(actor,1,'2026-09',{remote});
    assert.equal(review.reports.length,mode==='append'?2:1);
    assert.equal(review.reports.filter(row=>row.id===report.id).length,1);
    if(mode==='append') assert.equal(record.inventory.items[0].description,'Manual existing line');
  });
}
test('D8: original report markers reconcile and remain linked to photos in monthly review',async()=>{
  const remote=transport([existing()]);
  const report=await submitDamageReport(actor,input(),dependencies);
  remote.records.get(998187).inventory.items.push({line:2,item:{id:String(item.item_id)},adjustQtyBy:3,units:'191',custcol_atlas_rc_so:{id:'7'},description:`Damage SKU [Damage report ${report.id}]`});
  await query("UPDATE inventory_damage_reports SET status='posting',safe_to_retry=false WHERE id=$1",[report.id]);
  await retryDamageReport(actor,report.id,{remote});
  assert.equal((await getDamageReport(actor,report.id)).status,'posted');
  assert.equal(remote.calls.length,0);
  const review=await reviewDamageMonth(actor,1,'2026-09',{remote});
  assert.equal(review.reports.length,2);
  assert.equal(review.reports.find(row=>row.id===report.id).photos.length,1);
});
test('D2/D4: acceptance, photo ownership, immutable request ID and original month',async()=>{
  const request=input(); const first=await submitDamageReport(actor,request,dependencies);
  assert.equal(first.status,'pending'); assert.equal(first.month,'2026-09');
  const retry=await submitDamageReport(actor,request,{...dependencies,now:()=>new Date('2026-10-01T15:00:00Z')});
  assert.equal(retry.id,first.id);assert.equal(retry.month,'2026-09');
  await assert.rejects(submitDamageReport(actor,{...request,values:{pieces:4}},dependencies),{status:409});
  for(const invalid of [input({photos:[]}),input({photos:['r2://other/photo.jpg']}),input({reasonId:10}),input({values:{pieces:-1}})]) await assert.rejects(submitDamageReport(actor,invalid,dependencies));
  await assert.rejects(submitDamageReport({...actor,operatorYardLocationIds:[28]},input(),dependencies),{status:403});
});
test('D5: adopt IT00551, append repeated SKU reports and preserve manual line',async()=>{
  const remote=transport([existing()]);
  const a=await submitDamageReport(actor,input(),dependencies),b=await submitDamageReport(actor,input(),dependencies);
  await processDamageReport(a.id,{remote});await processDamageReport(b.id,{remote});
  assert.deepEqual(remote.calls.map(c=>c[0]),['append','append']);
  const lines=remote.records.get(998187).inventory.items;
  assert.equal(lines.length,3);assert.equal(lines[0].description,'Manual existing line');
  assert.equal(lines[1].custcol_atlas_rc_so.id,'7');assert.equal(lines[1].units,'191');
  await processDamageReport(a.id,{remote});assert.equal(remote.records.get(998187).inventory.items.length,3);
  const review=await reviewDamageMonth(actor,1,'2026-09',{remote});assert.equal(review.reports.length,3);
  assert.equal(review.reports.filter(r=>r.photos.length>0).length,2);
});
test('D5: simultaneous submit/retry and workers produce one monthly record',async()=>{
  const remote=transport();const request=input();
  const repeats=await Promise.all(Array.from({length:8},()=>submitDamageReport(actor,request,dependencies)));
  assert.equal(new Set(repeats.map(r=>r.id)).size,1);
  const reports=await Promise.all(Array.from({length:5},()=>submitDamageReport(actor,input(),dependencies)));
  await Promise.all([...reports,repeats[0]].map(r=>processDamageReport(r.id,{remote})));
  for(const report of [...reports,repeats[0]]) await processDamageReport(report.id,{remote});
  assert.equal(remote.calls.filter(c=>c[0]==='create').length,1);
  assert.equal([...remote.records.values()][0].inventory.items.length,6);
  assert.equal(Number((await query('SELECT count(*) FROM inventory_damage_months')).rows[0].count),1);
});
test('D6: lost append response reconciles marker without adding twice',async()=>{
  const remote=transport([existing()]);const append=remote.append;
  remote.append=async(...args)=>{await append(...args);throw new Error('lost response');};
  const report=await submitDamageReport(actor,input(),dependencies);
  await processDamageReport(report.id,{remote});
  assert.equal((await getDamageReport(actor,report.id)).status,'attention');
  await retryDamageReport(actor,report.id,{remote});
  assert.equal((await getDamageReport(actor,report.id)).status,'posted');
  assert.equal(remote.calls.length,1);assert.equal(remote.records.get(998187).inventory.items.length,2);
});
test('D6: unknown outcome with no marker never blindly retries; definite failure can retry',async()=>{
  const remote=transport([existing()]);
  remote.append=async()=>{remote.calls.push(['append']);throw new Error('timeout');};
  let report=await submitDamageReport(actor,input(),dependencies);await processDamageReport(report.id,{remote});
  await retryDamageReport(actor,report.id,{remote});
  assert.equal(remote.calls.length,1);assert.equal((await getDamageReport(actor,report.id)).safe_to_retry,false);
  // Separate month so the deliberately uncertain operation cannot block this scenario.
  remote.records.clear();remote.create=async()=>{throw Object.assign(new Error('closed period'),{status:400,netsuiteResponseReceived:true});};
  report=await submitDamageReport(actor,input(),{...dependencies,now:()=>new Date('2026-10-02T12:00:00Z')});
  await processDamageReport(report.id,{remote});assert.equal((await getDamageReport(actor,report.id)).safe_to_retry,true);
});
test('D6/A1: duplicate monthly transfers and foreign access are blocked',async()=>{
  const remote=transport([existing(),existing(998188)]);const report=await submitDamageReport(actor,input(),dependencies);
  await processDamageReport(report.id,{remote});assert.equal(remote.calls.length,0);
  assert.equal((await getDamageReport(actor,report.id)).status,'attention');
  await assert.rejects(getDamageReport({...actor,operatorYardLocationIds:[28]},report.id),{status:403});
  await assert.rejects(reviewDamageMonth({...actor,operatorYardLocationIds:[28]},1,'2026-09',{remote}),{status:403});
});
test('D6: a readback permission failure after an acknowledged write cannot permit reposting',async()=>{
  const remote=transport([existing()]);const get=remote.get;
  remote.get=async id=>{
    if(remote.calls.length) throw Object.assign(new Error('readback permission denied'),{status:403,netsuiteResponseReceived:true});
    return get(id);
  };
  const report=await submitDamageReport(actor,input(),dependencies);
  await processDamageReport(report.id,{remote});
  assert.equal((await getDamageReport(actor,report.id)).safe_to_retry,false);
  await retryDamageReport(actor,report.id,{remote});
  assert.equal(remote.calls.length,1);
  remote.get=get;
  await retryDamageReport(actor,report.id,{remote});
  assert.equal((await getDamageReport(actor,report.id)).status,'posted');
  assert.equal(remote.records.get(998187).inventory.items.length,2);
});
test('D6: accepted create with lost acknowledgment is discovered by monthly identity after restart',async()=>{
  const remote=transport(),create=remote.create;
  remote.create=async payload=>{await create(payload);throw new Error('connection lost');};
  const report=await submitDamageReport(actor,input(),dependencies);
  await processDamageReport(report.id,{remote});assert.equal((await getDamageReport(actor,report.id)).safe_to_retry,false);
  await retryDamageReport(actor,report.id,{remote});assert.equal((await getDamageReport(actor,report.id)).status,'posted');
  assert.equal(remote.calls.length,1);
});
test('D6: marker corruption or wrong destination prevents any further write',async()=>{
  const remote=transport([existing()]);const report=await submitDamageReport(actor,input(),dependencies);
  await processDamageReport(report.id,{remote});const stored=remote.records.get(998187);
  await query("UPDATE inventory_damage_reports SET status='posting' WHERE id=$1",[report.id]);
  stored.inventory.items[1].adjustQtyBy=99;await processDamageReport(report.id,{remote});
  assert.match((await getDamageReport(actor,report.id)).last_error,/differs/);
  stored.inventory.items[1].adjustQtyBy=3;stored.inventory.items.push({...stored.inventory.items[1],line:3});
  await retryDamageReport(actor,report.id,{remote});assert.match((await getDamageReport(actor,report.id)).last_error,/More than one/);
  stored.transferLocation={id:'8'};await retryDamageReport(actor,report.id,{remote});assert.match((await getDamageReport(actor,report.id)).last_error,/locations/);
  assert.equal(remote.calls.length,1);
});
test('D6/D7: uncertain report fences the whole month and history outages preserve local reports',async()=>{
  const remote=transport([existing()]);remote.append=async()=>{throw new Error('timeout');};
  const a=await submitDamageReport(actor,input(),dependencies),b=await submitDamageReport(actor,input(),dependencies);
  await processDamageReport(a.id,{remote});await processDamageReport(b.id,{remote});
  assert.match((await getDamageReport(actor,b.id)).last_error,/Another report/);
  remote.findMonthly=async()=>{throw new Error('NetSuite unavailable');};
  const review=await reviewDamageMonth(actor,1,'2026-09',{remote});assert.equal(review.reports.length,2);assert.equal(review.syncError,'NetSuite unavailable');
  await processDamageReport(crypto.randomUUID(),{remote});await assert.rejects(getDamageReport(actor,crypto.randomUUID()),{status:404});
});
test('D6: background worker drains queued reports and ignores overlapping ticks',async()=>{
  const remote=transport();const report=await submitDamageReport(actor,input(),dependencies);
  await Promise.all([damagePostingTick({remote}),damagePostingTick({remote})]);
  assert.equal((await getDamageReport(actor,report.id)).status,'posted');assert.equal(remote.calls.length,1);
});
