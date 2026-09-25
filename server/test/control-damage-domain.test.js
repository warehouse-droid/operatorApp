import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fc from 'fast-check';
import {damageTransferRevision,planDamageAdjustment,damageAdjustmentApplied} from '../src/control-damage-domain.js';
const uuid='4d479511-b15c-4878-9fa8-6b5a94e8d1fd';
const line=(number,item=1256)=>({line:number,item:{id:String(item),refName:`SKU ${item}`},adjustQtyBy:3,units:'191',custcol_atlas_rc_so:{id:'7'},description:`Existing ${number}`,customPreserved:'keep me'});
const record=()=>({id:'998187',tranId:'IT00551',memo:'3445 2026 Sep Damage',location:{id:'1'},transferLocation:{id:'10'},lastModifiedDate:'2026-09-23T20:00:00Z',inventory:{items:[line(1),line(4,5020),line(8)]}});
const input=(r,changes)=>({requestId:uuid,revision:damageTransferRevision(r),note:'Correct the damage inspection',changes});
const update=(number,overrides={})=>({action:'update',line:number,itemId:1256,quantity:6,unitId:191,reasonId:8,...overrides});
const addition=(overrides={})=>({action:'add',itemId:5020,quantity:9,unitId:191,reasonId:5,...overrides});
function apply(r,plan) {
  const next=structuredClone(r),old=next.inventory.items;
  const merge=entry=>entry.line?{...old.find(row=>row.line===entry.line),...entry}:{...entry,line:Math.max(0,...old.map(row=>row.line))+10};
  next.inventory.items=plan.replace?plan.payload.inventory.items.map(merge):[
    ...old.map(row=>({...row,...plan.payload.inventory.items.find(entry=>entry.line===row.line)})),
    ...plan.payload.inventory.items.filter(entry=>!entry.line).map(merge)
  ];return next;
}
test('CD1: keyed update changes only its selected line and preserves the report identity',()=>{
  const r=record();r.inventory.items[1].description=`DMG:${uuid}`;
  const plan=planDamageAdjustment(r,input(r,[update(4)]));
  assert.equal(plan.replace,false);assert.equal(plan.payload.inventory.items.length,1);
  assert.deepEqual(plan.payload.inventory.items[0],{line:4,item:{id:'1256'},adjustQtyBy:6,units:'191',custcol_atlas_rc_so:{id:'8'},description:`DMG:${uuid}`});
  const after=apply(r,plan);assert.equal(damageAdjustmentApplied(after,plan),true);
  assert.deepEqual(after.inventory.items[0],r.inventory.items[0]);
  after.inventory.items[1].adjustQtyBy=7;assert.equal(damageAdjustmentApplied(after,plan),false);
});
test('CD2: removal preserves every other keyed line, additions have bounded unique markers, and reconciliation detects a missing edit',()=>{
  const r=record(),plan=planDamageAdjustment(r,input(r,[{action:'remove',line:4},update(8),addition()]));
  assert.equal(plan.replace,true);
  assert.deepEqual(plan.payload.inventory.items[0],{line:1});
  assert.equal(plan.payload.inventory.items.some(row=>row.line===4),false);
  const added=plan.payload.inventory.items.find(row=>!row.line);
  assert.ok(added.description.length<=40);assert.ok(added.description.includes(uuid.replaceAll('-','')));
  const after=apply(r,plan);assert.equal(damageAdjustmentApplied(after,plan),true);
  after.inventory.items.push(line(4,5020));assert.equal(damageAdjustmentApplied(after,plan),false);
  after.inventory.items.pop();after.inventory.items[0].customPreserved='changed';
  assert.equal(damageAdjustmentApplied(after,plan),false,'unrelated line fields must survive');
});
test('CD3: stale revision, foreign or duplicate keys, removing every line, invalid quantities and reasons are rejected',()=>{
  const r=record();
  assert.throws(()=>planDamageAdjustment(r,{...input(r,[update(4)]),revision:'0'.repeat(64)}),/changed|refresh/i);
  for(const changes of [[update(9)],[update(4),{action:'remove',line:4}],r.inventory.items.map(row=>({action:'remove',line:row.line})),[addition({quantity:0})],[addition({quantity:-1})],[addition({quantity:Infinity})],[addition({quantity:true})],[addition({unitId:0})],[addition({reasonId:4})],[]]) {
    assert.throws(()=>planDamageAdjustment(r,input(r,changes)));
  }
  assert.throws(()=>planDamageAdjustment(r,{...input(r,[update(4)]),note:''}),/note/i);
  assert.throws(()=>planDamageAdjustment(r,{...input(r,[update(4)]),requestId:'bad'}),/ID/i);
});
test('CD4: revisions detect NetSuite edits and incomplete transfer reads are rejected',()=>{
  const r=record(),revision=damageTransferRevision(r),changed=structuredClone(r);
  changed.inventory.items[0].adjustQtyBy=4;assert.notEqual(damageTransferRevision(changed),revision);
  assert.equal(damageTransferRevision(structuredClone(r)),revision);
  r.inventory.totalResults=4;assert.throws(()=>planDamageAdjustment(r,input(r,[update(4)])),/complete/i);
});
test('CD5: properties preserve every untouched line and addition markers distinguish all request IDs',()=>{
  fc.assert(fc.property(fc.uuid(),fc.integer({min:1,max:100000}),fc.integer({min:1,max:100000}), (requestId,quantity,itemId)=>{
    const r=record(),plan=planDamageAdjustment(r,{...input(r,[addition({quantity,itemId})]),requestId});
    const added=plan.payload.inventory.items[0];assert.ok(added.description.length<=40);
    assert.ok(added.description.includes(requestId.replaceAll('-','')));
    const after=apply(r,plan);assert.equal(damageAdjustmentApplied(after,plan),true);
    assert.deepEqual(after.inventory.items.slice(0,3),r.inventory.items);
    const other=planDamageAdjustment(r,{...input(r,[addition({quantity,itemId})]),requestId:crypto.randomUUID()});
    assert.notEqual(other.payload.inventory.items[0].description,added.description);
  }),{numRuns:100,seed:230926});
});
test('CD6: hostile input and mixed-edit properties reject stale writes and preserve unmodified lines',()=>{
 const r=record();
 for(const changes of [[null],[{action:'unknown'}],[addition({line:1})],[addition({quantity:0.00000001})],Array.from({length:101},()=>addition())]) assert.throws(()=>planDamageAdjustment(r,input(r,changes)));
 assert.throws(()=>damageTransferRevision({...r,inventory:{items:[line(1),line(1)]}}),/duplicate/);
 fc.assert(fc.property(fc.uuid(),fc.integer({min:1,max:10000}), (requestId,quantity)=>{
  const current=record(),changes=[{action:'remove',line:4},update(8,{quantity}),addition({quantity})];
  const plan=planDamageAdjustment(current,{...input(current,changes),requestId});
  assert.equal(plan.replace,true);assert.equal(plan.payload.inventory.items.some(row=>row.line===4),false);
  const after=apply(current,plan);assert.equal(damageAdjustmentApplied(after,plan),true);assert.deepEqual(after.inventory.items[0],current.inventory.items[0]);
  assert.throws(()=>planDamageAdjustment(current,{...input(current,changes),revision:'stale',requestId}),{status:409});
 }),{numRuns:100,seed:240926});
});
