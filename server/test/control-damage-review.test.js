import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {query,closeDb} from '../src/db.js';
import {createOperator} from '../src/auth-repository.js';
import {submitDamageReport,reviewDamageMonth,processDamageReport} from '../src/inventory-damage-service.js';
import {reviewControlDamageMonth} from '../src/control-damage-review.js';
import {assertDamagePhotoAccess} from '../src/inventory-damage-repository.js';
let manager,operator,report,photo,record,remote;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  await query(await readFile(new URL('./support/control-damage-schema.sql',import.meta.url),'utf8'));
  manager=await createOperator({username:`damage-review-manager-${crypto.randomUUID()}`,displayName:'Review Manager',password:crypto.randomUUID(),role:'yard_manager',yardLocationIds:[1],operatorYardLocationIds:[]});
  operator=await createOperator({username:`damage-review-operator-${crypto.randomUUID()}`,displayName:'Damage Operator',password:crypto.randomUUID(),operatorYardLocationIds:[1]});
  await query("INSERT INTO inventory_items(item_id,item_name,item_type,stock_unit) VALUES(980610,'Reported SKU','InvtPart','PCS') ON CONFLICT DO NOTHING");
});
beforeEach(async()=>{
  await query('TRUNCATE inventory_damage_adjustments,inventory_damage_photos,inventory_damage_events,inventory_damage_reports,inventory_damage_months RESTART IDENTITY');
  const id=crypto.randomUUID();photo=`r2://operator/operator-damage-photo/2026/09/23/${operator.id}/yard-1/${id}/photo.jpg`;
  report=await submitDamageReport(operator,{requestId:id,locationId:1,itemId:980610,reasonId:7,values:{pieces:3},photos:[photo]},
    {getItem:async()=>({item_id:980610,item_name:'Reported SKU',location_id:1,item_type:'InvtPart',sales_unit:'PCS',sales_unit_id:191,stock_unit:'PCS',to_pcs:1}),verifyPhotos:async()=>{},now:()=>new Date('2026-09-23T12:00:00Z')});
  await query("UPDATE inventory_damage_months SET transfer_id=998187,transfer_ref='IT00551'");
  await query("UPDATE inventory_damage_reports SET status='posted',safe_to_retry=false,transfer_line=2,posted_at=now() WHERE id=$1",[id]);
  record={id:'998187',tranId:'IT00551',memo:'3445 2026 Sep Damage',location:{id:'1'},transferLocation:{id:'10'},inventory:{items:[
    {line:1,item:{id:'1256',refName:'Manual SKU'},adjustQtyBy:5,units:'191',custcol_atlas_rc_so:{id:'5',refName:'R1 - Broken'},description:'Manual line'},
    {line:2,item:{id:'980610',refName:'Reported SKU'},adjustQtyBy:3,units:'191',custcol_atlas_rc_so:{id:'7',refName:'R3 - Chipping / Crack'},description:`DMG:${id}`} ]}};
  remote={findMonthly:async()=>[structuredClone(record)],units:async()=>({'191':'PCS','188':'SQFT'})};
});
after(closeDb);
test('CR1: assigned manager can review all NetSuite lines and linked operator photographs',async()=>{
  const result=await reviewControlDamageMonth(manager,1,'2026-09',{remote});
  assert.equal(result.transfers.length,1);assert.equal(result.transfers[0].ref,'IT00551');
  assert.match(result.transfers[0].revision,/^[0-9a-f]{64}$/);assert.equal(result.transfers[0].lines.length,2);
  assert.deepEqual(result.transfers[0].lines[1].photos,[photo]);assert.deepEqual(result.transfers[0].lines[0].photos,[]);
  assert.equal(await assertDamagePhotoAccess(manager,photo),true);
  await assert.rejects(reviewControlDamageMonth({...manager,yardLocationIds:[28]},1,'2026-09',{remote}),{status:403});
  await assert.rejects(reviewControlDamageMonth(operator,1,'2026-09',{remote}),{status:403});
});
test('CR2: operator monthly review reflects adjusted NetSuite values and retains original submitted evidence',async()=>{
  const line=record.inventory.items[1];line.item={id:'5020',refName:'Revised SKU'};line.adjustQtyBy=2.5;line.units='188';line.custcol_atlas_rc_so={id:'8',refName:'R4 - Surface'};
  const result=await reviewDamageMonth(operator,1,'2026-09',{remote}),current=result.reports.find(row=>row.id===report.id);
  assert.equal(current.item_name,'Revised SKU');assert.equal(Number(current.quantity),2.5);assert.equal(current.unit,'SQFT');assert.equal(current.reason_label,'R4 - Surface');
  assert.equal(current.adjusted,true);assert.equal(Number(current.original.quantity),3);assert.equal(current.original.item_name,'Reported SKU');
  assert.deepEqual(current.photos,[photo]);assert.equal(result.reports.length,2);
});
test('CR3: removed transfer line remains an audited report with original photos and cannot repost',async()=>{
  record.inventory.items.pop();
  const result=await reviewDamageMonth(operator,1,'2026-09',{remote}),removed=result.reports.find(row=>row.id===report.id);
  assert.equal(removed.status,'removed');assert.equal(Number(removed.quantity),0);assert.equal(Number(removed.original.quantity),3);assert.deepEqual(removed.photos,[photo]);
  assert.equal((await query('SELECT status FROM inventory_damage_reports WHERE id=$1',[report.id])).rows[0].status,'posted');
  await processDamageReport(report.id,{remote:{get:()=>assert.fail('A removed posted report must not post again')}});
});
test('CR4: a replacement Control line cannot inherit another report’s photos even if NetSuite reuses its line key',async()=>{
  record.inventory.items[1]={line:2,item:{id:'5020',refName:'Added in Control'},adjustQtyBy:9,units:'191',custcol_atlas_rc_so:{id:'8',refName:'R4 - Surface'},description:`C:${crypto.randomUUID().replaceAll('-','')}:0`};
  const result=await reviewDamageMonth(operator,1,'2026-09',{remote});
  const original=result.reports.find(row=>row.id===report.id),added=result.reports.find(row=>row.item_name==='Added in Control');
  assert.equal(original.status,'removed');assert.deepEqual(original.photos,[photo]);
  assert.ok(added);assert.deepEqual(added.photos,[]);assert.equal(result.reports.length,3);
  const control=await reviewControlDamageMonth(manager,1,'2026-09',{remote});
  assert.deepEqual(control.transfers[0].lines.find(line=>line.line===2).photos,[]);
});
test('CR5: a deleted transfer is distinguished from a failed refresh and retains report evidence',async()=>{
  remote.findMonthly=async()=>[];
  let result=await reviewControlDamageMonth(manager,1,'2026-09',{remote});
  assert.equal(result.reports[0].status,'missing');assert.deepEqual(result.reports[0].photos,[photo]);
  remote.findMonthly=async()=>{throw new Error('NetSuite unavailable');};
  result=await reviewControlDamageMonth(manager,1,'2026-09',{remote});
  assert.match(result.syncError,/unavailable/);assert.equal(result.reports[0].status,'posted');assert.deepEqual(result.reports[0].photos,[photo]);
});
