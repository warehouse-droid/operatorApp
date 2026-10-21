import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fc from 'fast-check';
import {normalizeEquipmentInput,equipmentModels,equipmentForModel,validateEquipmentChoice} from '../../public/mbr/equipment.js';

export const roster=JSON.parse(readFileSync(new URL('./equipment-roster.json',import.meta.url),'utf8'))
  .map(([brand,model,description,unitCode,serialNumber])=>({brand,model,description,unitCode,serialNumber,active:true}));
const prior={equipmentModel:'Old model',serialNumber:'Old serial'};

test('all 38 units yield twelve model codes alone and exactly their corresponding SNs',()=>{
  assert.equal(roster.length,38);
  const models=equipmentModels(roster);assert.equal(models.length,12);
  assert.deepEqual(models,[...new Set(roster.map(row=>row.model))].sort((a,b)=>a.localeCompare(b,'en',{numeric:true})));
  for(const model of models) {
    assert.deepEqual(equipmentForModel(roster,model).map(row=>row.serialNumber).sort(),
      roster.filter(row=>row.model===model).map(row=>row.serialNumber).sort());
  }
  assert.deepEqual(equipmentForModel(roster,''),[]);
});

test('inactive units are excluded; historical selections remain in their original model only',()=>{
  const items=[{...roster[0],active:false},roster[2]];
  assert.deepEqual(equipmentModels(items),['TV1100H']);
  assert.deepEqual(equipmentForModel(items,'STR1000H'),[]);
  assert.deepEqual(equipmentModels(items,prior),['Old model','TV1100H']);
  assert.equal(equipmentForModel(items,prior.equipmentModel,prior)[0].serialNumber,prior.serialNumber);
  assert.deepEqual(equipmentForModel(items,'TV1100H',prior).map(row=>row.serialNumber),[roster[2].serialNumber]);
  const original={equipmentModel:roster[0].model,serialNumber:roster[0].serialNumber};
  assert.equal(equipmentForModel(items,original.equipmentModel,original)[0].serialNumber,original.serialNumber);
});

test('setup validates bounded text and boolean activity and preserves numeric unit codes',()=>{
  assert.deepEqual(normalizeEquipmentInput({...roster[4],model:' ATL1000 ',serialNumber:' ATLQ30371RF7789 '}),roster[4]);
  for(const input of [null,[],{}, {...roster[0],brand:''},{...roster[0],model:'x'.repeat(301)},
    {...roster[0],unitCode:'x'.repeat(101)},{...roster[0],serialNumber:'x'.repeat(151)},
    {...roster[0],description:'x'.repeat(501)},{...roster[0],model:'Bad\tModel'},
    {...roster[0],active:'true'}]) {
    assert.throws(()=>normalizeEquipmentInput(input),{status:400});
  }
  assert.equal(normalizeEquipmentInput({...roster[0],description:''}).description,'');
  assert.equal(normalizeEquipmentInput({...roster[0],active:undefined}).active,true);
});

test('contract choice must be an active matching pair; only unchanged historical pairs are grandfathered',()=>{
  const choice={equipmentModel:roster[0].model,serialNumber:roster[0].serialNumber};
  assert.doesNotThrow(()=>validateEquipmentChoice(roster,choice));
  assert.doesNotThrow(()=>validateEquipmentChoice([],prior,prior));
  for(const invalid of [prior,{...choice,serialNumber:roster[2].serialNumber},{...choice,equipmentModel:''}]) {
    assert.throws(()=>validateEquipmentChoice(roster,invalid),{status:400,code:'MBR_EQUIPMENT_INVALID'});
  }
  assert.throws(()=>validateEquipmentChoice([{...roster[0],active:false}],choice),{status:400});
  assert.throws(()=>validateEquipmentChoice([],choice,prior),{status:400});
});

test('model/SN selection remains sound and complete for arbitrary catalog subsets and activity',()=>{
  fc.assert(fc.property(fc.array(fc.boolean(),{minLength:38,maxLength:38}),flags=>{
    const catalog=roster.map((row,index)=>({...row,active:flags[index]}));
    const expectedModels=new Set(catalog.filter(row=>row.active).map(row=>row.model));
    assert.deepEqual(new Set(equipmentModels(catalog)),expectedModels);
    for(const model of new Set(roster.map(row=>row.model))) {
      const expected=catalog.filter(row=>row.active && row.model===model);
      assert.deepEqual(new Set(equipmentForModel(catalog,model).map(row=>row.serialNumber)),new Set(expected.map(row=>row.serialNumber)));
      for(const row of catalog) {
        const choice={equipmentModel:model,serialNumber:row.serialNumber};
        if(row.active && row.model===model) {assert.doesNotThrow(()=>validateEquipmentChoice(catalog,choice));}
        else {assert.throws(()=>validateEquipmentChoice(catalog,choice),{code:'MBR_EQUIPMENT_INVALID'});}
      }
    }
  }),{seed:131026,numRuns:120});
});
