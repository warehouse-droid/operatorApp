import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { priceLevel,suggestedRate,sameDecimal } from '../../public/field-sales/pricing.js';
import { createNetSuiteCatalogReader } from '../../src/field-sales/netsuite-catalog.js';
const item={company:'MBBS',unit_rate:'15.5',pricing:{priceLevel:'TRADE-A',tiers:[{minimumQuantity:'0',unitRate:'15.5'},{minimumQuantity:'49',unitRate:'13.95'},{minimumQuantity:'98',unitRate:'12.55'}]}};
test('T1 exact Trade policy and quantity thresholds including missing prices',()=>{
  assert.equal(priceLevel('MBBS'),'TRADE-A');assert.equal(priceLevel('MBR'),'TRADE');assert.equal(priceLevel('MBT'),'TRADE');assert.throws(()=>priceLevel('OTHER'));
  for(const [q,r] of [['0.01','15.5'],['48.999999','15.5'],['49','13.95'],['98','12.55']]){assert.equal(suggestedRate(item,q),r);}
  assert.equal(suggestedRate({...item,pricing:{...item.pricing,tiers:[]}},'1'),null);
  assert.equal(suggestedRate({...item,pricing:{...item.pricing,priceLevel:'Base Price'}},'1'),null);
  for(const q of ['-1','NaN','1e3','0','1.0000001']){assert.throws(()=>suggestedRate(item,q));}
  assert.equal(sameDecimal('1.000000','01'),true);assert.equal(sameDecimal('999999999999.999998','999999999999.999999'),false);assert.equal(sameDecimal(null,'0'),false);
});
test('T2 SuiteQL reader selects company, currency, named level and resolved quantity; rejects bad metadata',async()=>{
  const queries=[];let rows=[{id:'692',sku:'Salt',description:'Bag salt',unit:'Bag',unit_id:'625',price_unit_id:'625',price_level:'TRADE-A',price_level_id:'3',currency_id:'1',currency_name:'CAN',minimum_quantity:'0',unit_rate:'15.5'},{id:'692',sku:'Salt',description:'Bag salt',unit:'Bag',unit_id:'625',price_unit_id:'625',price_level:'TRADE-A',price_level_id:'3',currency_id:'1',currency_name:'CAN',minimum_quantity:'49',unit_rate:'13.95'}];
  const reader=createNetSuiteCatalogReader({queryAll:async sql=>{queries.push(sql);return rows;}});
  const cfg={subsidiaryId:'1',currencyId:'1'};const items=await reader.items('MBBS',cfg);
  assert.equal(items.length,1);assert.equal(items[0].unit,'Bag');assert.equal(items[0].pricing.unitId,'625');assert.equal(suggestedRate(items[0],'49'),'13.95');
  assert.match(queries[0],/BUILTIN\.DF\(p.quantity\)/);assert.match(queries[0],/TRADE-A/);assert.match(queries[0],/MN_INCLUDE/);assert.match(queries[0],/Purchase/);assert.match(queries[0],/p.currency=1/);
  rows=[{...rows[0],price_level:'TRADE',price_level_id:'2'}];assert.equal((await reader.items('MBR',{subsidiaryId:'7',currencyId:'1'},'692'))[0].company,'MBR');assert.match(queries.at(-1),/i.id=692/);
  await assert.rejects(reader.items('MBBS',{...cfg,subsidiaryId:'1 OR 1=1'}),/Configure/);
  await assert.rejects(reader.items('MBBS',cfg,'1 OR 1=1'),/item ID/);
  await assert.rejects(reader.items('MBBS',cfg),/price level/);
  rows=[{...rows[0],price_level:'TRADE-A',currency_id:'2'}];await assert.rejects(reader.items('MBBS',cfg),/currency/);
  rows=[{...rows[0],currency_id:'1',price_unit_id:'9'}];await assert.rejects(reader.items('MBBS',cfg),/sales unit/);
  rows=[{...rows[0],price_unit_id:'625',unit_rate:'-1'}];await assert.rejects(reader.items('MBBS',cfg),/unsupported price/);
  rows=[{...rows[0],unit_rate:null,price_level:null,price_level_id:null}];assert.equal((await reader.items('MBBS',cfg))[0].unit_rate,null);
});
test('property Trade threshold selection agrees with independent integer oracle',()=>{
  fc.assert(fc.property(fc.constantFrom('MBBS','MBR','MBT'),fc.integer({min:1,max:100000}),fc.integer({min:1,max:100000}),fc.integer({min:0,max:100000}),fc.integer({min:0,max:100000}),(company,threshold,q,first,second)=>{
    const catalog={company,unit_rate:String(first),pricing:{priceLevel:company==='MBBS'?'TRADE-A':'TRADE',tiers:[{minimumQuantity:'0',unitRate:String(first)},{minimumQuantity:(threshold/1000).toFixed(3),unitRate:String(second)}]}};
    assert.equal(suggestedRate(catalog,(q/1000).toFixed(3)),String(q>=threshold?second:first));
    assert.equal(suggestedRate(catalog,(threshold/1000).toFixed(3)),String(second));
    assert.equal(suggestedRate({...catalog,pricing:{...catalog.pricing,tiers:[]}},'1'),null);
    assert.equal(priceLevel(company),company==='MBBS'?'TRADE-A':'TRADE');
  }),{seed:20260919,numRuns:600});
});
test('T8 a single NetSuite price without a quantity break starts at zero',async()=>{
  const reader=createNetSuiteCatalogReader({queryAll:async()=>[{id:'5010',sku:'Bin 14YD',unit_id:'1',unit:'Each',price_unit_id:'1',price_level:'TRADE',price_level_id:'2',currency_id:'1',currency_name:'CAN',unit_rate:'500'}]});
  const [single]=await reader.items('MBT',{subsidiaryId:'3',currencyId:'1'});assert.equal(single.unit_rate,'500');assert.equal(suggestedRate(single,'0.5'),'500');assert.deepEqual(single.pricing.tiers,[{minimumQuantity:'0',unitRate:'500'}]);
});
test('T9 old offline catalog sources cannot supply base or local prices as Trade suggestions',()=>{
  for(const [company,source] of [['MBBS','NetSuite base price, first quantity tier (CAD)'],['MBR','Legacy catalog'],['MBT','MBT configured catalog']]){
    assert.equal(suggestedRate({company,unit_rate:'100',pricing:{source}},'1'),null);
  }
});
test('T11 ambiguous quantity prices and a non-CAD currency label fail closed',async()=>{
  const base={id:'7',sku:'Ambiguous',unit:'Each',unit_id:'1',price_unit_id:'1',price_level:'TRADE',price_level_id:'2',currency_id:'1',currency_name:'CAN',minimum_quantity:'0',unit_rate:'50'};
  let rows=[base,{...base,unit_rate:'60'}];const reader=createNetSuiteCatalogReader({queryAll:async()=>rows});
  await assert.rejects(reader.items('MBT',{subsidiaryId:'3',currencyId:'1'}),/ambiguous quantity/);
  rows=[{...base,currency_name:'US Dollar'}];await assert.rejects(reader.items('MBT',{subsidiaryId:'3',currencyId:'1'}),/currency/);
  rows=[base,{...base}];assert.equal((await reader.items('MBT',{subsidiaryId:'3',currencyId:'1'}))[0].pricing.tiers.length,1);
});
