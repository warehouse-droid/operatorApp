// Isolated executable rehearsal of the scoped repair, with real local storage.
// Only the remote NetSuite transport is replaced; all reconciliation/retry code runs.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {query,pool} from '../src/db.js';
import {createOperator} from '../src/auth-repository.js';
import {recordDamage,damageRow} from '../src/inventory-damage-repository.js';
import {damageNetSuite} from '../src/inventory-damage-netsuite.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED,'false');
assert.match(process.env.DATABASE_URL,/\/mbt_focus$/);
const mode=process.argv[2] || 'success';
assert.ok(['success','already-repaired','existing-ucara','ambiguous-pisa','bad-backup'].includes(mode));
await query('TRUNCATE inventory_damage_adjustments,inventory_damage_photos,inventory_damage_events,inventory_damage_reports,inventory_damage_months RESTART IDENTITY');
const actor=await createOperator({username:'damage-recovery-'+randomUUID(),displayName:'Recovery rehearsal',password:randomUUID(),operatorYardLocationIds:[1]});
const reports=[
  {id:'63794073-25d1-4911-b2e5-c7fc584fdefb',item:1228,sku:'UNI-PISAS-COP-CG',quantity:9,unit:'PC',unitId:554,reason:6,month:'2026-09',safe:false},
  {id:'a203380a-4471-4cf4-b57a-4a6413f69227',item:2884,sku:'UNI-UCARA-COR-SM-DC',quantity:27.09,unit:'SQFT',unitId:613,reason:8,month:'2026-09',safe:true},
  {id:'bd4d6c99-5431-4dea-b51a-b0d9c86dc46f',item:5022,sku:'UNI-PISAS-COP-SAFARI',quantity:18,unit:'PC',unitId:554,reason:5,month:'2026-10',safe:false},
  {id:'5f2c9876-8fc8-4ac5-bdc3-9ce8f1e9cce1',item:2884,sku:'UNI-UCARA-COR-SM-DC',quantity:27.09,unit:'SQFT',unitId:613,reason:9,month:'2026-10',safe:true}
];
for(const row of reports) {
  await query("INSERT INTO inventory_items(item_id,item_name,item_type,stock_unit) VALUES($1,$2,'InvtPart',$3) ON CONFLICT DO NOTHING",[row.item,row.sku,row.unit]);
  const now=new Date(row.month+'-15T16:00:00Z');
  const values=row.unit==='PC'?{pieces:row.quantity}:{sales:row.quantity};
  await recordDamage(actor,{requestId:row.id,locationId:1,itemId:row.item,values,reasonId:row.reason,
    photos:[`r2://operator/operator-damage-photo/2026/10/01/${actor.id}/yard-1/${row.id}/original.jpg`]},
    {getItem:async()=>({item_id:row.item,item_name:row.sku,location_id:1,item_type:'InvtPart',stock_unit:row.unit,sales_unit:row.unit,sales_unit_id:row.unitId,...(row.unit==='PC'?{to_pcs:1}:{})}),
      verifyPhotos:async()=>{},now:()=>now});
  await query("UPDATE inventory_damage_reports SET status='attention',safe_to_retry=$2,attempt_count=$3 WHERE id=$1",[row.id,row.safe,row.safe?0:1]);
}
await query("UPDATE inventory_damage_months SET transfer_id=CASE month WHEN '2026-09' THEN 998187 ELSE 1031838 END,transfer_ref=CASE month WHEN '2026-09' THEN 'IT00551' ELSE 'IT00571' END");
const snapshot={reports:await Promise.all(reports.map(row=>damageRow(row.id)))};
const bytes=Buffer.from(JSON.stringify(snapshot));
writeFileSync('/tmp/damage-posting-retry-live-before.json',bytes,{mode:0o600});
process.env.DAMAGE_RETRY_BACKUP_SHA=mode==='bad-backup'?'wrong':createHash('sha256').update(bytes).digest('hex');
const line=(key,item,sku,quantity,units,reason)=>({line:key,item:{id:String(item),refName:sku},adjustQtyBy:quantity,units:String(units),custcol_atlas_rc_so:{id:String(reason)},description:'NetSuite item description'});
const records=[{id:998187,tranId:'IT00551',memo:'3445 2026 Sep Damage',location:{id:'1'},transferLocation:{id:'10'},inventory:{items:[line(1,1256,'BWS-GD-CURB-CHAR',6,191,7),line(3,1228,'UNI-PISAS-COP-CG',10,554,7)]}},
  {id:1031838,tranId:'IT00571',memo:'3445 2026 Oct Damage',location:{id:'1'},transferLocation:{id:'10'},inventory:{items:[line(1,5022,'UNI-PISAS-COP-SAFARI',18,554,5)]}}];
if(mode==='existing-ucara')records[0].inventory.items.push(line(4,2884,'UNI-UCARA-COR-SM-DC',27.09,613,8));
if(mode==='ambiguous-pisa')records[1].inventory.items.push(line(2,5022,'UNI-PISAS-COP-SAFARI',18,554,5));
if(mode==='already-repaired') {
  records[1].inventory.items.push(line(2,2884,'UNI-UCARA-COR-SM-DC',27.09,613,9));
  await query("UPDATE inventory_damage_reports SET status='posted',safe_to_retry=false,transfer_line=CASE id WHEN $1 THEN 3 WHEN $2 THEN 1 ELSE 2 END WHERE id<>$3",[reports[0].id,reports[2].id,reports[1].id]);
  await query("UPDATE inventory_damage_reports SET safe_to_retry=false WHERE id=$1",[reports[1].id]);
  await query("INSERT INTO inventory_damage_events(report_id,action,details) VALUES($1,'superseded',$2)",[reports[1].id,JSON.stringify({replacementReportId:reports[3].id})]);
}
let writes=0;
Object.assign(damageNetSuite,{
  directory:async()=>[{id:1,name:'3445',subsidiary:1},{id:10,name:'3445 Damage',parent:1}],
  get:async id=>structuredClone(records.find(row=>Number(row.id)===Number(id))),
  append:async(id,addition,options)=>{
    assert.equal(Number(id),1031838);writes++;
    const record=records.find(row=>row.id===1031838);record.memo=options.memo;
    record.inventory.items.push({...structuredClone(addition),line:2,description:'NetSuite item description'});
  },create:()=>assert.fail('The repair must not create a second transfer')
});
process.argv.push('--apply','--link-september-adjusted');
let result;
const originalLog=console.log;
console.log=value=>{result=JSON.parse(value);};
try {
  await import('./damage-posting-retry-recover.mjs');
  assert.ok(['success','already-repaired'].includes(mode),'Corrupt or already moved evidence must fail closed');
  assert.equal(writes,mode==='success'?1:0);assert.equal(result.stockWrites,writes);
  assert.equal(records[0].inventory.items[1].adjustQtyBy,10);
  assert.equal(records[0].inventory.items[1].custcol_atlas_rc_so.id,'7');
  assert.deepEqual(result.reports.map(row=>row.status),['posted','superseded','posted','posted']);
  assert.deepEqual(result.reports.map(row=>row.photoCount),[1,1,1,1]);
  assert.equal(result.reports.at(-1).transferLine,2);
} catch(error) {
  if(['success','already-repaired'].includes(mode))throw error;
  assert.equal(writes,0,'Fail-closed recovery cannot move stock');
  assert.match(error.message,mode==='bad-backup'?/backup hash/:mode==='existing-ucara'?/UCARA already exists/:/no unique verified line/);
} finally {console.log=originalLog;}
console.log(JSON.stringify({rehearsalPassed:true,mode,stockWrites:writes,transport:'isolated fixture',exactRecoveryScript:true}));
