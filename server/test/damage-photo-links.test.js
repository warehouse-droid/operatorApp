import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fc from 'fast-check';
import {readFile} from 'node:fs/promises';
import {query,closeDb} from '../src/db.js';
import {createOperator} from '../src/auth-repository.js';
import {reviewControlDamageMonth} from '../src/control-damage-review.js';
import {recoverDamagePhotoLines} from '../src/inventory-damage-photo-links.js';

const id='bd4d6c99-5431-4dea-b51a-b0d9c86dc46f';
const photo=`r2://operator/operator-damage-photo/2026/10/01/operator/yard-1/${id}/photo.jpg`;
function fixture() {
  const report={id,status:'attention',safe_to_retry:false,transfer_id:'1031838',transfer_line:null,
    item_id:'5022',item_name:'UNI-PISAS-COP-SAFARI',quantity:'18',unit_id:'554',reason_id:5,photos:[photo]};
  const transfer={id:'1031838',tranId:'IT00571',memo:'3445 2026 Oct Damage',location:{id:'1'},transferLocation:{id:'10'},inventory:{items:[
    {line:1,item:{id:'5022',refName:'UNI-PISAS-COP-SAFARI'},adjustQtyBy:18,units:'554',custcol_atlas_rc_so:{id:'5',refName:'R1 - Color Variation'},description:'Pisa Smooth Coping Safari 36pcs/plt'}]}};
  return {report,transfer};
}
test('P1: unique IT00571 line recovers photo identity without mutating its inputs',()=>{
  const {report,transfer}=fixture(),before=structuredClone({report,transfer});
  assert.deepEqual([...recoverDamagePhotoLines([transfer],[report])],[[id,{transferId:'1031838',line:1}]]);
  assert.deepEqual({report,transfer},before);
});
test('P2: ambiguity in either direction leaves photographs on the saved report',()=>{
  const {report,transfer}=fixture();
  transfer.inventory.items.push({...transfer.inventory.items[0],line:2});
  assert.equal(recoverDamagePhotoLines([transfer],[report]).size,0);
  transfer.inventory.items.pop();
  assert.equal(recoverDamagePhotoLines([transfer],[report,{...report,id:crypto.randomUUID()}]).size,0);
});
test('P2: changed values, foreign transfer, known markers and safe retries never inherit photos',()=>{
  for(const update of [r=>r.item_id='5020',r=>r.quantity='19',r=>r.unit_id='191',r=>r.reason_id=8,
    r=>r.transfer_id='998187',r=>r.safe_to_retry=true,r=>r.status='pending',r=>r.transfer_line=2]) {
    const {report,transfer}=fixture();update(report);
    assert.equal(recoverDamagePhotoLines([transfer],[report]).size,0);
  }
  for(const description of [`DMG:${crypto.randomUUID()}`,`Control [Damage report ${crypto.randomUUID()}]`,`C:${crypto.randomUUID().replaceAll('-','')}:0`]) {
    const {report,transfer}=fixture();transfer.inventory.items[0].description=description;
    assert.equal(recoverDamagePhotoLines([transfer],[report]).size,0);
  }
  const {report,transfer}=fixture();
  assert.equal(recoverDamagePhotoLines([transfer],[report,{...report,id:crypto.randomUUID(),status:'posted',transfer_line:1}]).size,0);
});
test('P2 property: each unique matching SKU retains its own line independent of ordering',()=>{
  fc.assert(fc.property(fc.uniqueArray(fc.integer({min:1,max:100000}),{minLength:1,maxLength:30}),items=>{
    const reports=items.map((item,index)=>({...fixture().report,id:`report-${index}`,item_id:String(item)}));
    const transfer=fixture().transfer;
    transfer.inventory.items=items.map((item,index)=>({...transfer.inventory.items[0],line:index+1,item:{id:String(item)}})).reverse();
    const matches=recoverDamagePhotoLines([transfer],reports.slice().reverse());
    assert.equal(matches.size,items.length);
    for(const [index,report] of reports.entries()) {assert.deepEqual(matches.get(report.id),{transferId:'1031838',line:index+1});}
  }),{numRuns:100});
});

let manager;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  await query(await readFile(new URL('./support/control-damage-schema.sql',import.meta.url),'utf8'));
  await query("INSERT INTO inventory_items(item_id,item_name,item_type,stock_unit) VALUES(5022,'UNI-PISAS-COP-SAFARI','InvtPart','PC') ON CONFLICT DO NOTHING");
  manager=await createOperator({username:`damage-photo-manager-${crypto.randomUUID()}`,displayName:'Photo Manager',password:crypto.randomUUID(),role:'yard_manager',yardLocationIds:[1],operatorYardLocationIds:[]});
});
after(closeDb);
test('P1/R1: review attaches the saved photo to line 1 while database status stays uncertain',async()=>{
  await query('TRUNCATE inventory_damage_adjustments,inventory_damage_photos,inventory_damage_events,inventory_damage_reports,inventory_damage_months RESTART IDENTITY');
  const {transfer}=fixture();
  await query("INSERT INTO inventory_damage_months(location_id,month,external_id,transfer_id,transfer_ref) VALUES(1,'2026-10','mbbs-damage-1-2026-10',1031838,'IT00571')");
  await query(`INSERT INTO inventory_damage_reports(id,payload_hash,month_id,operator_id,item_id,item_name,quantity,unit,unit_id,values,conversions,reason_id,reason_label,accepted_date,status,safe_to_retry,last_error)
    SELECT $1,'photo-regression',id,$2,5022,'UNI-PISAS-COP-SAFARI',18,'PC',554,'{}','{}',5,'R1 - Color Variation','2026-10-01','attention',false,'Needs reconciliation' FROM inventory_damage_months`,[id,manager.id]);
  await query('INSERT INTO inventory_damage_photos(report_id,photo_reference,position) VALUES($1,$2,0)',[id,photo]);
  const before=(await query('SELECT * FROM inventory_damage_reports WHERE id=$1',[id])).rows[0];
  let unitCalls=0;
  const remote={findMonthly:async()=>[structuredClone(transfer)],units:async()=>{unitCalls++;return {'554':'PC'};}};
  const review=await reviewControlDamageMonth(manager,1,'2026-10',{remote});
  assert.deepEqual(review.transfers[0].lines[0].photos,[photo]);
  assert.equal(review.transfers[0].lines[0].reportId,id);
  assert.equal(review.reports.length,1);
  assert.equal(review.reports[0].status,'attention');
  assert.equal(review.reports[0].transfer_line,1);
  assert.equal(unitCalls,0,'Saved unit labels must avoid an extra NetSuite query');
  assert.deepEqual((await query('SELECT * FROM inventory_damage_reports WHERE id=$1',[id])).rows[0],before);
  await assert.rejects(reviewControlDamageMonth({...manager,yardLocationIds:[28]},1,'2026-10',{remote}),{status:403});
});
