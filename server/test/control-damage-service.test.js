import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {query,closeDb} from '../src/db.js';
import {createOperator} from '../src/auth-repository.js';
import {damageTransferRevision} from '../src/control-damage-domain.js';
import {queueDamageAdjustment,processDamageAdjustment,getDamageAdjustment,retryDamageAdjustment,damageAdjustmentTick} from '../src/control-damage-service.js';
import {submitDamageReport,processDamageReport,getDamageReport} from '../src/inventory-damage-service.js';
let manager,operator;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  await query(await readFile(new URL('./support/control-damage-schema.sql',import.meta.url),'utf8'));
  manager=await createOperator({username:`damage-manager-${crypto.randomUUID()}`,displayName:'Damage Manager',password:crypto.randomUUID(),role:'yard_manager',yardLocationIds:[1],operatorYardLocationIds:[]});
  operator=await createOperator({username:`damage-posting-${crypto.randomUUID()}`,displayName:'Posting Operator',password:crypto.randomUUID(),operatorYardLocationIds:[1]});
  await query("INSERT INTO inventory_items(item_id,item_name,item_type,stock_unit) VALUES(980620,'Posting SKU','InvtPart','PCS') ON CONFLICT DO NOTHING");
});
beforeEach(async()=>query('TRUNCATE inventory_damage_adjustments,inventory_damage_photos,inventory_damage_events,inventory_damage_reports,inventory_damage_months RESTART IDENTITY'));
after(closeDb);
function boundary() {
  let record={id:'998187',tranId:'IT00551',memo:'3445 2026 Sep Damage',location:{id:'1'},transferLocation:{id:'10'},inventory:{items:[
    {line:1,item:{id:'1256',refName:'Original SKU'},adjustQtyBy:3,units:'191',custcol_atlas_rc_so:{id:'7'},description:'Manual line'},
    {line:4,item:{id:'5020',refName:'Second SKU'},adjustQtyBy:8,units:'191',custcol_atlas_rc_so:{id:'8'},description:'Another line'}]}};
  const calls=[];
  return {calls,get record(){return record;},
    directory:async()=>[{id:1,name:'3445',subsidiary:1},{id:10,name:'3445 Damage',parent:1}],
    findMonthly:async()=>[structuredClone(record)],get:async()=>structuredClone(record),
    item:async id=>({item_id:Number(id),location_id:1,item_type:'InvtPart',item_name:`SKU ${id}`,sales_unit_id:191,sales_unit:'PCS',stock_unit_id:191,stock_unit:'PCS'}),
    itemUnits:async()=>[{id:'191',label:'PCS',conversionRate:1}],
    apply:async(id,plan)=>{
      calls.push({id,plan:structuredClone(plan)});
      const before=record.inventory.items,next=plan.payload.inventory.items;
      const merge=line=>line.line?{...before.find(old=>old.line===line.line),...structuredClone(line)}:{...structuredClone(line),line:Math.max(...before.map(old=>old.line))+1};
      record={...record,inventory:{items:plan.replace?next.map(merge):[
        ...before.map(old=>({...old,...next.find(line=>line.line===old.line)})),...next.filter(line=>!line.line).map(merge)]}};
    }
  };
}
function request(remote,overrides={}) {
  return {requestId:crypto.randomUUID(),locationId:1,month:'2026-09',transferId:998187,
    revision:damageTransferRevision(remote.record),note:'Warehouse reviewed the quantity',
    changes:[{action:'update',line:4,itemId:5020,quantity:10,unitId:191,reasonId:8}],...overrides};
}
test('CS1: manager queues an audited correction, updates the same IT, and repeated requests write once',async()=>{
  const remote=boundary(),input=request(remote);
  const queued=await queueDamageAdjustment(manager,input,{remote});assert.equal(queued.status,'pending');assert.equal(remote.calls.length,0);
  await processDamageAdjustment(queued.id,{remote});
  const saved=await getDamageAdjustment(manager,queued.id);assert.equal(saved.status,'posted',saved.last_error);assert.equal(saved.actor_id,manager.id);
  assert.equal(saved.plan.note,input.note);assert.equal(saved.plan.before[1].adjustQtyBy,8);
  assert.equal(remote.record.inventory.items[1].adjustQtyBy,10);assert.equal(remote.record.inventory.items[0].adjustQtyBy,3);
  assert.equal((await queueDamageAdjustment(manager,input,{remote})).id,queued.id);
  await retryDamageAdjustment(manager,queued.id,{remote});assert.equal(remote.calls.length,1);
  await assert.rejects(queueDamageAdjustment(manager,{...input,note:'different'},{remote}),{status:409});
});
test('CS2: operator role, wrong manager yard, foreign transfer, invalid SKU/UOM and stale versions fail before writing',async()=>{
  const remote=boundary();
  await assert.rejects(queueDamageAdjustment({...manager,role:'operator',roles:['operator']},request(remote),{remote}),{status:403});
  await assert.rejects(queueDamageAdjustment({...manager,yardLocationIds:[28]},request(remote),{remote}),{status:403});
  await assert.rejects(queueDamageAdjustment(manager,request(remote,{transferId:99}),{remote}));
  await assert.rejects(queueDamageAdjustment(manager,request(remote,{revision:'f'.repeat(64)}),{remote}),{status:409});
  const invalid=request(remote);invalid.changes[0].unitId=999;
  await assert.rejects(queueDamageAdjustment(manager,invalid,{remote}),/unit/i);
  remote.item=async()=>({item_id:5020,location_id:1,item_type:'NonInvtPart'});
  await assert.rejects(queueDamageAdjustment(manager,request(remote),{remote}),/inventory SKU/i);
  assert.equal(remote.calls.length,0);assert.equal(Number((await query('SELECT count(*) FROM inventory_damage_adjustments')).rows[0].count),0);
});
test('CS3: external edits after acceptance cause a conflict before a NetSuite mutation',async()=>{
  const remote=boundary(),queued=await queueDamageAdjustment(manager,request(remote),{remote});
  remote.record.inventory.items[0].adjustQtyBy=9;
  await processDamageAdjustment(queued.id,{remote});
  assert.equal((await getDamageAdjustment(manager,queued.id)).status,'conflict');assert.equal(remote.calls.length,0);
});
test('CS3: a NetSuite edit during SKU validation is checked again immediately before writing',async()=>{
  const remote=boundary(),queued=await queueDamageAdjustment(manager,request(remote),{remote}),item=remote.item;
  remote.item=async(...args)=>{remote.record.inventory.items[0].adjustQtyBy=17;return item(...args);};
  await processDamageAdjustment(queued.id,{remote});
  assert.equal((await getDamageAdjustment(manager,queued.id)).status,'conflict');assert.equal(remote.calls.length,0);
});
test('CS4: lost response after adding/removing lines reconciles without another write',async()=>{
  const remote=boundary(),apply=remote.apply;
  remote.apply=async(...args)=>{await apply(...args);throw new Error('lost response');};
  const input=request(remote,{changes:[{action:'remove',line:4},{action:'add',itemId:5020,quantity:5,unitId:191,reasonId:5}]});
  const queued=await queueDamageAdjustment(manager,input,{remote});
  await processDamageAdjustment(queued.id,{remote});
  const uncertain=await getDamageAdjustment(manager,queued.id);assert.equal(uncertain.status,'attention');assert.equal(uncertain.safe_to_retry,false);
  await retryDamageAdjustment(manager,queued.id,{remote});
  assert.equal((await getDamageAdjustment(manager,queued.id)).status,'posted');assert.equal(remote.calls.length,1);
  assert.equal(remote.record.inventory.items.length,2);assert.equal(remote.record.inventory.items[0].description,'Manual line');
});
test('CS5: unresolved writes cannot resend or admit another monthly adjustment; definite rejection can retry',async()=>{
  const remote=boundary(),apply=remote.apply;
  remote.apply=async()=>{remote.calls.push('timeout');throw new Error('timeout');};
  const queued=await queueDamageAdjustment(manager,request(remote),{remote});
  await processDamageAdjustment(queued.id,{remote});await retryDamageAdjustment(manager,queued.id,{remote});
  assert.equal(remote.calls.length,1);assert.equal((await getDamageAdjustment(manager,queued.id)).safe_to_retry,false);
  await assert.rejects(queueDamageAdjustment(manager,request(remote),{remote}),{status:409});
  // New fixture month isolates the uncertain operation rather than clearing its status.
  remote.record.memo='3445 2026 Oct Damage';remote.record.id='998188';
  remote.apply=async()=>{throw Object.assign(new Error('closed period'),{status:400,netsuiteResponseReceived:true});};
  const next=await queueDamageAdjustment(manager,request(remote,{month:'2026-10',transferId:998188}),{remote});
  await processDamageAdjustment(next.id,{remote});assert.equal((await getDamageAdjustment(manager,next.id)).safe_to_retry,true);
  remote.apply=apply;await retryDamageAdjustment(manager,next.id,{remote});
  assert.equal((await getDamageAdjustment(manager,next.id)).status,'posted');
});
test('CS6: concurrent queue requests and posting workers retain one accepted monthly edit',async()=>{
  const remote=boundary(),input=request(remote);
  const results=await Promise.allSettled(Array.from({length:6},()=>queueDamageAdjustment(manager,input,{remote})));
  assert.ok(results.some(row=>row.status==='fulfilled'));
  const row=(await query('SELECT id FROM inventory_damage_adjustments')).rows;
  assert.equal(row.length,1);
  await Promise.all(Array.from({length:5},()=>processDamageAdjustment(row[0].id,{remote})));
  await processDamageAdjustment(row[0].id,{remote});
  assert.equal(remote.calls.length,1);assert.equal((await getDamageAdjustment(manager,row[0].id)).status,'posted');
  await assert.rejects(getDamageAdjustment({...manager,yardLocationIds:[28]},row[0].id),{status:403});
});
async function operatorReport() {
  const id=crypto.randomUUID();
  return submitDamageReport(operator,{requestId:id,locationId:1,itemId:980620,reasonId:7,values:{pieces:2},photos:[`r2://operator/operator-damage-photo/2026/09/23/${operator.id}/yard-1/${id}/photo.jpg`]},
    {getItem:async()=>({item_id:980620,item_name:'Posting SKU',location_id:1,item_type:'InvtPart',sales_unit:'PCS',sales_unit_id:191,stock_unit:'PCS',to_pcs:1}),verifyPhotos:async()=>{},now:()=>new Date('2026-09-23T12:00:00Z')});
}
test('CS7: an uncertain Control replacement fences operator appends to the same month',async()=>{
  const remote=boundary();remote.apply=async()=>{throw new Error('timeout');};
  let appends=0;remote.append=async(_id,line)=>{appends++;remote.record.inventory.items.push({...line,line:5});};
  const adjustment=await queueDamageAdjustment(manager,request(remote,{changes:[{action:'remove',line:4}]}),{remote});
  await processDamageAdjustment(adjustment.id,{remote});
  const report=await operatorReport();await processDamageReport(report.id,{remote});
  assert.equal(appends,0);assert.equal((await getDamageReport(operator,report.id)).status,'attention');
  assert.match((await getDamageReport(operator,report.id)).last_error,/reconciliation|adjustment/i);
});
test('CS8: Control and Operator use the same monthly lock and preserve both accepted changes',async()=>{
  const remote=boundary(),apply=remote.apply;
  let entered,release;
  const enteredPromise=new Promise(resolve=>{entered=resolve;}),releasePromise=new Promise(resolve=>{release=resolve;});
  remote.apply=async(...args)=>{entered();await releasePromise;await apply(...args);};
  let appends=0;remote.append=async(_id,line)=>{appends++;remote.record.inventory.items.push({...line,line:5});};
  const adjustment=await queueDamageAdjustment(manager,request(remote),{remote}),report=await operatorReport();
  const posting=processDamageAdjustment(adjustment.id,{remote});await enteredPromise;
  try {await processDamageReport(report.id,{remote});assert.equal(appends,0);assert.equal((await getDamageReport(operator,report.id)).status,'pending');}
  finally {release();await posting;}
  await processDamageReport(report.id,{remote});
  assert.equal((await getDamageAdjustment(manager,adjustment.id)).status,'posted');assert.equal((await getDamageReport(operator,report.id)).status,'posted');
  assert.equal(remote.record.inventory.items.find(line=>line.line===4).adjustQtyBy,10);assert.equal(appends,1);
});
test('CS9: bin assignments prevent quantity edits but permit reason corrections; restarted workers process once',async()=>{
  const remote=boundary();remote.record.inventory.items[1].inventoryDetail={inventoryAssignment:{items:[{binNumber:{id:'7'},quantity:8}]}};
  await assert.rejects(queueDamageAdjustment(manager,request(remote),{remote}),/bin or lot/);
  const input=request(remote);input.changes[0].quantity=8;input.changes[0].reasonId=9;
  const queued=await queueDamageAdjustment(manager,input,{remote});
  await Promise.all([damageAdjustmentTick({remote}),damageAdjustmentTick({remote})]);
  assert.equal((await getDamageAdjustment(manager,queued.id)).status,'posted');assert.equal(remote.calls.length,1);
  assert.deepEqual(remote.record.inventory.items[1].inventoryDetail.inventoryAssignment.items,[{binNumber:{id:'7'},quantity:8}]);
  await assert.rejects(getDamageAdjustment(manager,crypto.randomUUID()),{status:404});
  await processDamageAdjustment(crypto.randomUUID(),{remote});
});

test('CS10: a verified existing unit can be retained, but cannot be assigned to a different SKU',async()=>{
 const remote=boundary();remote.record.inventory.items[1].units='188';
 const input=request(remote);input.changes[0].unitId=188;
 const changedSku=structuredClone(input);changedSku.changes[0].itemId=1256;
 await assert.rejects(queueDamageAdjustment(manager,changedSku,{remote}),/unit/i);
 const adjustment=await queueDamageAdjustment(manager,input,{remote});await processDamageAdjustment(adjustment.id,{remote});
 assert.equal((await getDamageAdjustment(manager,adjustment.id)).status,'posted');
 assert.equal(remote.record.inventory.items[1].units,'188');assert.equal(remote.calls.length,1);
});
