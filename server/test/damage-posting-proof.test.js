import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {damagePostingProof,damageReceiptMemo,confirmedDamageProofLine} from '../src/inventory-damage-posting-proof.js';
import {createDamageNetSuite} from '../src/inventory-damage-netsuite.js';
const id='00000000-0000-4000-8000-000000000571';
const report={id,item_id:5022,quantity:18,unit_id:554,reason_id:5,external_id:'mbbs-damage-1-2026-10'};
const line=(number=1)=>({line:number,item:{id:'5022'},adjustQtyBy:18,units:'554',custcol_atlas_rc_so:{id:'5'},description:'Pisa item description'});
const record=()=>({id:'1031838',externalId:report.external_id,memo:'3445 2026 Oct Damage',inventory:{items:[line()]}});
test('P2: the REST append writes the receipt and one new line in the same request',async()=>{
  const calls=[],remote=createDamageNetSuite({rest:async(...args)=>{calls.push(args);return {};}});
  const memo=damageReceiptMemo('3445 2026 Oct Damage',id);
  await remote.append(1031838,line(),{memo});
  assert.deepEqual(calls,[['/1031838',{method:'PATCH',body:{memo,inventory:{items:[line()]}}}]]);
  await remote.append(1031838,line());assert.equal('memo' in calls[1][1].body,false,'Legacy callers preserve the header');
});
for(const invalid of ['duplicate ID','foreign identity']) {
  test(`P3: ${invalid} cannot be claimed by the receipt`,()=>{
    const before=record(),memo=damageReceiptMemo(before.memo,id),proof=damagePostingProof(report,before,memo);
    const added=line(invalid==='duplicate ID'?1:2);if(invalid==='foreign identity')added.description='C:another-command';
    const after={...before,memo,inventory:{items:[...before.inventory.items,added]}};
    assert.equal(confirmedDamageProofLine(after,report,proof),null,invalid);
  });
}
test('P3: incomplete records raise a reconciliation error instead of confirming a partial list',()=>{
  const before=record(),memo=damageReceiptMemo(before.memo,id),proof=damagePostingProof(report,before,memo);
  for(const inventory of [{items:[line(),line(2)],hasMore:true},{items:[line(),line(2)],totalResults:3}]) {
    assert.throws(()=>confirmedDamageProofLine({...before,memo,inventory},report,proof),/complete transfer/);
  }
});
test('P2/P3 properties: generated snapshots survive JSON storage and confirm exactly one added line',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:100000}),fc.integer({min:1,max:100000}),fc.integer({min:0,max:8}),
    (item,quantity,count)=>{
      const row={...report,item_id:item,quantity};
      const before={id:'1031838',memo:'3445 2026 Oct Damage',inventory:{items:Array.from({length:count},(_,index)=>({...line(index+1),adjustQtyBy:index+1}))}};
      const memo=damageReceiptMemo(before.memo,id);
      const proof=JSON.parse(JSON.stringify(damagePostingProof(row,before,memo)));
      proof.lines=proof.lines.map(snapshot=>Object.fromEntries(Object.entries(snapshot).reverse()));
      const added={...line(count+1),item:{id:String(item)},adjustQtyBy:quantity};
      const after={...before,memo,inventory:{items:[...before.inventory.items,added]}};
      assert.equal(confirmedDamageProofLine(after,row,proof),added);
      assert.equal(confirmedDamageProofLine({...after,memo:'3445 2026 Oct Damage'},row,proof),null);
      assert.equal(confirmedDamageProofLine({...after,memo:'Changed '+memo},row,proof),null);
      assert.equal(confirmedDamageProofLine({...after,inventory:{items:[...after.inventory.items,{...added,line:count+2}]}},row,proof),null);
      assert.equal(confirmedDamageProofLine({...after,inventory:{items:[...before.inventory.items,{...added,adjustQtyBy:quantity+1}]}},row,proof),null);
      if(count) {const changed=structuredClone(after);changed.inventory.items[0].adjustQtyBy+=1;assert.equal(confirmedDamageProofLine(changed,row,proof),null);}
    }),{numRuns:250,seed:571});
});
test('P2 properties: replacing a receipt retains the original memo and only the latest report identity',()=>{
  fc.assert(fc.property(fc.string({maxLength:100}),prefix=>{
    const first=damageReceiptMemo(prefix,id),second=damageReceiptMemo(first,'00000000-0000-4000-8000-000000000572');
    assert.equal(second,prefix+' [DMG:00000000-0000-4000-8000-000000000572]');
  }),{numRuns:250,seed:572});
});
