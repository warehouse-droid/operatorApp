import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {normalizeModelRates,ratesForModel} from '../../public/mbr/rates.js';

const empty={dailyRateMinor:null,weeklyRateMinor:null,monthlyRateMinor:null};
test('model rates accept exact CAD cents, zero and nullable prices independently',()=>{
  assert.deepEqual(normalizeModelRates({model:' ER620H ',dailyRate:'280',weeklyRate:'1250.01',monthlyRate:'3300.50'}),
    {model:'ER620H',dailyRateMinor:28000,weeklyRateMinor:125001,monthlyRateMinor:330050});
  assert.deepEqual(normalizeModelRates({model:'AX18'}),{model:'AX18',...empty});
  for(const value of [null,undefined,'','   ']) {
    assert.deepEqual(normalizeModelRates({model:'AX18',dailyRate:value,weeklyRate:value,monthlyRate:value}),{model:'AX18',...empty});
  }
  assert.deepEqual(normalizeModelRates({model:'Zero',dailyRate:'0',weeklyRate:'0.00',monthlyRate:'9999999999.99'}),
    {model:'Zero',dailyRateMinor:0,weeklyRateMinor:0,monthlyRateMinor:999999999999});
});
test('model rates reject malformed, oversized and hostile input',()=>{
  for(const input of [null,[],{},'ER620H',{model:' '},{model:'X'.repeat(301)},{model:'Bad\nmodel'}]) {
    assert.throws(()=>normalizeModelRates(input),{status:400});
  }
  for(const key of ['dailyRate','weeklyRate','monthlyRate']) {
    for(const value of ['-1','1.001','NaN','Infinity','1e3','1,250','$280','10000000000',0,true,{},[]]) {
      assert.throws(()=>normalizeModelRates({model:'ER620H',[key]:value}),{status:400});
    }
  }
});
test('model selection returns only exact matching model defaults and nulls for unpriced models',()=>{
  const rows=[{model:'ER620H',dailyRateMinor:28000,weeklyRateMinor:125000,monthlyRateMinor:330000,revision:1},
    {model:'Zero',dailyRateMinor:0,weeklyRateMinor:null,monthlyRateMinor:200}];
  assert.deepEqual(ratesForModel(rows,'ER620H'),{dailyRateMinor:28000,weeklyRateMinor:125000,monthlyRateMinor:330000});
  assert.deepEqual(ratesForModel(rows,'Zero'),{dailyRateMinor:0,weeklyRateMinor:null,monthlyRateMinor:200});
  for(const model of ['AX18','','ER620','ER620H Cab','__proto__','toString']) {assert.deepEqual(ratesForModel(rows,model),empty);}
  assert.deepEqual(ratesForModel([],'ER620H'),empty);
  assert.equal(rows[0].dailyRateMinor,28000);
});
test('property: arbitrary nullable model prices round-trip without rounding or cross-model defaults',()=>{
  const amount=fc.option(fc.integer({min:0,max:999999999999}),{nil:null});
  fc.assert(fc.property(amount,amount,amount,(dailyRateMinor,weeklyRateMinor,monthlyRateMinor)=>{
    const expected={dailyRateMinor,weeklyRateMinor,monthlyRateMinor};
    const decimal=value=>value===null?null:Math.floor(value/100)+'.'+String(value%100).padStart(2,'0');
    const row=normalizeModelRates({model:'Property',dailyRate:decimal(dailyRateMinor),weeklyRate:decimal(weeklyRateMinor),monthlyRate:decimal(monthlyRateMinor)});
    assert.deepEqual(row,{model:'Property',...expected});
    assert.deepEqual(ratesForModel([row],'Property'),expected);
    assert.deepEqual(ratesForModel([row],'Unpriced'),empty);
  }),{seed:141026,numRuns:300});
});
