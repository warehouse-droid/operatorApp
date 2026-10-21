import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {damageTransferRevision,planDamageAdjustment,damageAdjustmentApplied} from '../src/control-damage-domain.js';
const id='00000000-0000-4000-8000-000000000573';
const record=()=>({id:'1031838',memo:'3445 2026 Oct Damage',location:{id:'1'},transferLocation:{id:'10'},inventory:{items:[
  {line:1,item:{id:'5022'},adjustQtyBy:18,units:'554',custcol_atlas_rc_so:{id:'5'},description:'Pisa Smooth Coping Safari 36pcs/plt, 6pcs/lyr, 6lyrs/plt',customPreserved:'keep'}
]}});
const add=(quantity=27.09)=>({action:'add',itemId:6176,quantity,unitId:613,reasonId:9});
function plan(before,changes) {return planDamageAdjustment(before,{requestId:id,revision:damageTransferRevision(before),note:'Reviewed damage',changes});}
function applyNetSuite(before,plan) {
  const after=structuredClone(before);if(plan.payload.memo!==undefined)after.memo=plan.payload.memo;
  after.inventory.items=before.inventory.items.filter(line=>!plan.removed.includes(line.line)).map(line=>{
    const update=plan.updated.find(row=>row.line===line.line);
    return update?{...line,...update,description:line.description}:structuredClone(line);
  });
  let next=Math.max(...before.inventory.items.map(line=>line.line))+1;
  for(const addition of plan.added)after.inventory.items.push({...structuredClone(addition),line:next++,description:'NetSuite item description'});
  return after;
}
test('C1: Control confirms a quantity update when NetSuite retains its long item description',()=>{
  const before=record(),operation=plan(before,[{action:'update',line:1,itemId:5022,quantity:20,unitId:554,reasonId:5}]);
  const after=applyNetSuite(before,operation);
  assert.equal(damageAdjustmentApplied(after,operation),true);assert.equal(after.inventory.items[0].description,before.inventory.items[0].description);
  after.inventory.items[0].customPreserved='changed';assert.equal(damageAdjustmentApplied(after,operation),false);
});
for(const count of [1,2]) {
  test(`C2: Control confirms ${count} added lines using the receipt when descriptions are replaced`,()=>{
    const before=record(),operation=plan(before,Array.from({length:count},()=>add()));
    const after=applyNetSuite(before,operation);
    assert.ok(after.memo.includes(id),'The transfer receipt identifies the Control adjustment');
    assert.equal(damageAdjustmentApplied(after,JSON.parse(JSON.stringify(operation))),true);
    assert.equal(after.inventory.items.length,1+count);assert.deepEqual(after.inventory.items[0],before.inventory.items[0]);
    after.memo=before.memo;assert.equal(damageAdjustmentApplied(after,operation),false);
  });
}
test('C3 properties: changed quantities, extra lines, wrong receipts and unrelated edits never confirm',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:10000}),quantity=>{
    const before=record(),operation=plan(before,[add(quantity)]),after=applyNetSuite(before,operation);
    assert.equal(damageAdjustmentApplied(after,operation),true);
    for(const kind of ['quantity','extra','receipt','old']) {
      const changed=structuredClone(after);
      if(kind==='quantity')changed.inventory.items[1].adjustQtyBy+=1;
      if(kind==='extra')changed.inventory.items.push({...changed.inventory.items[1],line:3});
      if(kind==='receipt')changed.memo='3445 2026 Oct Damage';
      if(kind==='old')changed.inventory.items[0].adjustQtyBy+=1;
      assert.equal(damageAdjustmentApplied(changed,operation),false,kind);
    }
  }),{numRuns:150,seed:573});
});
