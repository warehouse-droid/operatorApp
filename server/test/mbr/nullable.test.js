import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {normalizeContractFields,formatMoney,formatRentalPeriod} from '../../public/mbr/domain.js';
import {snapshotForFields,agreementParagraphs} from '../../src/mbr/agreement.js';
import {summaryHtml} from '../../public/mbr/ui.js';
import {validateEquipmentChoice} from '../../public/mbr/equipment.js';
import {fields} from './fixtures.js';

export const inputNames=['effectiveDate','lessee','equipmentModel','serialNumber','rentalStart','rentalEnd',
  'pickupLocation','returnLocation','dailyRate','weeklyRate','monthlyRate','securityDeposit','expiryDays'];
const storedNames=['effectiveDate','lessee','equipmentModel','serialNumber','rentalStart','rentalEnd',
  'pickupLocation','returnLocation','dailyRateMinor','weeklyRateMinor','monthlyRateMinor','securityDepositMinor','expiryDays'];
test('all contract fields accept omitted, null, empty or whitespace input and store actual nulls',()=>{
  for(const blank of [undefined,null,'','  ']) {
    const normalized=normalizeContractFields(Object.fromEntries(inputNames.map(key=>[key,blank])));
    assert.deepEqual(normalized,Object.fromEntries(storedNames.map(key=>[key,null])));
  }
  assert.deepEqual(normalizeContractFields({}),Object.fromEntries(storedNames.map(key=>[key,null])));
});
test('each field may be cleared individually; dates are ordered only when both are present',()=>{
  for(const key of inputNames) {
    assert.equal(normalizeContractFields(fields({[key]:null}))[storedNames[inputNames.indexOf(key)]],null);
  }
  assert.equal(normalizeContractFields(fields({rentalStart:null})).rentalEnd,'2026-10-22');
  assert.equal(normalizeContractFields(fields({rentalEnd:null})).rentalStart,'2026-10-15');
  for(const override of [{rentalEnd:'2026-10-14'},{effectiveDate:'2026-02-30'},{dailyRate:'-1'},
    {dailyRate:0},{expiryDays:0},{expiryDays:1.5},{lessee:'\nX'},{lessee:'x'.repeat(301)}]) {
    assert.throws(()=>normalizeContractFields(fields(override)),{status:400});
  }
});
test('optional rates are blank rather than zero in agreement text and customer summary',()=>{
  const normalized=normalizeContractFields(Object.fromEntries(inputNames.map(key=>[key,null])));
  const paragraphs=agreementParagraphs(snapshotForFields(normalized));
  assert.ok(paragraphs.some(text=>/_{3,}/u.test(text)));
  assert.ok(!/\b(?:null|undefined)\b|0\.00/u.test(paragraphs.join('\n')));
  const markup=summaryHtml({fields:normalized});
  assert.ok(!/\b(?:null|undefined)\b|0\.00/u.test(markup));
  assert.equal(formatMoney(null),'');assert.equal(formatMoney(0),'$0.00');
  assert.equal(normalizeContractFields(fields({dailyRate:'0'})).dailyRateMinor,0);
});
test('rental summary displays complete, start-only, end-only and blank periods accurately',()=>{
  assert.equal(formatRentalPeriod('2026-10-15','2026-10-22'),'2026-10-15 to 2026-10-22');
  assert.equal(formatRentalPeriod('2026-10-15',null),'From 2026-10-15');
  assert.equal(formatRentalPeriod(null,'2026-10-22'),'Until 2026-10-22');
  assert.equal(formatRentalPeriod(null,null),'');
});
test('equipment may be blank or model-only; entered SN still requires the corresponding model',()=>{
  const catalog=[{brand:'SDLG',model:'STR1000H',unitCode:'L1000-1',serialNumber:'VLGST1KHAT0610007',description:'Loader',active:true}];
  for(const pair of [{equipmentModel:null,serialNumber:null},{equipmentModel:'STR1000H',serialNumber:null}]) {
    assert.doesNotThrow(()=>validateEquipmentChoice(catalog,pair));
  }
  assert.doesNotThrow(()=>validateEquipmentChoice([],{equipmentModel:'Legacy',serialNumber:null},{equipmentModel:'Legacy',serialNumber:'OLD-SN'}));
  for(const pair of [{equipmentModel:null,serialNumber:catalog[0].serialNumber},{equipmentModel:'Unknown',serialNumber:null},
    {equipmentModel:'STR1000H',serialNumber:'Wrong'}]) {
    assert.throws(()=>validateEquipmentChoice(catalog,pair),{code:'MBR_EQUIPMENT_INVALID'});
  }
});
test('property: arbitrary subsets of populated contract fields clear to null without changing the other values',()=>{
  const original=normalizeContractFields(fields());
  fc.assert(fc.property(fc.array(fc.boolean(),{minLength:13,maxLength:13}),flags=>{
    const input=fields(Object.fromEntries(inputNames.filter((_key,index)=>flags[index]).map(key=>[key,null])));
    const normalized=normalizeContractFields(input);
    for(let index=0;index<13;index+=1) {
      assert.equal(normalized[storedNames[index]],flags[index]?null:original[storedNames[index]]);
    }
  }),{seed:131027,numRuns:160});
});
