/* global structuredClone */
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { buildSpecialSalesOrderPayload } from '../../../src/special-stock-request-netsuite.js';
import { prepareSpecialAdjustmentPlan } from '../../../src/special-stock-adjustment-adapter.js';
import { assertSpecialRestSalesPayload } from '../../../src/special-stock-rest-orders.js';
import { synchronizeSpecialDescriptions } from '../../../src/special-stock-netsuite-adapter.js';
import { sumSpecialAmounts } from '../../../src/special-stock-discount-total.js';

const material = (quantity, rate, discountPercent) => ({ itemId: 2055, quantity, rate, discountPercent, description: 'Material', unitId: 865 });
const payload = lines => buildSpecialSalesOrderPayload({ caseId: 9, netsuiteLocationId: 1, pickupMethodId: 2,
  draft: { customerId: 10, materialLines: lines, ancillaryLines: [{ itemId: 1784, quantity: 2, rate: 40, unitId: 246, description: 'PALLET' }] } });

test('SO has one combined discount last, including individually rounded pennies and excluding pallets', () => {
  const p = payload([material(1,100,15), material(1,200,15), material(3,0.01,50), material(1,5,0)]);
  assert.deepEqual(p.item.items.map(l => [l.item.id,l.rate]), [['2055',100],['2055',200],['2055',0.01],['2055',5],['1784',40]]);
  assert.deepEqual(p.discountItem, { id: '10716' });
  assert.equal(p.discountRate, -45.02);
  assert.doesNotThrow(() => assertSpecialRestSalesPayload(p));
  assert.deepEqual(payload([material(1,100,0)]).item.items.map(l => l.item.id), ['2055','1784']);
});

test('property: the final SO discount equals the exact sum of independently rounded material discounts', () => {
  fc.assert(fc.property(fc.array(fc.record({ quantity: fc.integer({min:1,max:1000}), rateCents: fc.integer({min:0,max:100000}), percent: fc.integer({min:1,max:1000000}) }), { minLength: 1, maxLength: 20 }), rows => {
    const p = payload(rows.map(r => material(r.quantity,r.rateCents/100,r.percent/10000)));
    const cents = rows.reduce((total,r) => total + (BigInt(r.quantity*r.rateCents)*BigInt(r.percent)+500000n)/1000000n, 0n);
    assert.equal(p.item.items.length, rows.length+1);
    assert.deepEqual(p.item.items.at(-1), { item: {id:'1784'}, location: {id:'1'}, quantity:2, description:'PALLET', price:{id:'-1'}, units:'246', rate:40 });
    assert.equal(p.discountItem.id, '10716');
    assert.equal(p.discountRate, cents === 0n ? 0 : -Number(cents)/100);
    assert.doesNotThrow(() => assertSpecialRestSalesPayload(p));
  }), { seed: 20260928, numRuns: 250 });
});

test('later adjustments update one final summary while preserving untouched discounts and material identities', async () => {
  const line = (remoteLineId,itemId,quantity,rate,description='Material') => ({remoteLineId,itemId,quantity,rate:String(rate),description,unitId:itemId===10716?null:865,locationId:1,taxCode:'13',createdPoId:null,createPo:''});
  const baseline = { header:{entity:'10',discountItem:'10716',discountRate:'-30'}, lines: [line(101,2055,10,10),line(102,2055,5,20),line(103,1784,2,40,'PALLET')] };
  const plan = await prepareSpecialAdjustmentPlan({orders:[{ id:11,kind:'sales_order',discountMode:'total',lines:[{ remoteLineId:101,itemId:2055,quantity:10,rate:10,description:'Material',unitId:865,nativeDiscountPercent:10,toQuantity:20,toRate:10,toNativeDiscountPercent:25 }] }]}, { snapshot:async()=>structuredClone(baseline) });
  assert.deepEqual(plan.orders[0].target.lines.map(l => [l.remoteLineId,l.quantity,l.rate]), [[101,20,'10'],[102,5,'20'],[103,2,'40']]);
  assert.equal(plan.orders[0].target.header.discountRate, '-70');
  assert.deepEqual(plan.orders[0].baseline, baseline);
});

test('SCM quantity review recalculates the total SO discount once and recovers a lost response', async () => {
  const record={discountItem:{id:'10716'},discountRate:-30,item:{items:[{line:1,item:{id:'2055'},quantity:10,units:'865',rate:10,description:'Material'}]}};
  let writes=0,lose=true;
  const boundary={queryAll:async()=>[{uniquekey:101,rest_line_id:1,item:2055,execution_quantity:0,billed_quantity:0,line_closed:'F'}],rest:async(_path,options={})=>{
    if(options.method){writes++;const {item,...header}=options.body;Object.assign(record,header);Object.assign(record.item.items[0],item.items[0]);if(lose){lose=false;throw Error('Lost response');}}
    return {data:structuredClone(record)};
  }};
  const input={salesOrderId:11,discountTotal:{before:-30,after:-40},changes:[{remoteLineId:101,itemId:2055,quantity:20,unitId:865,uom:'PC',rate:10,description:'Material',previousDescription:'Material',previousQuantity:10,previousUnitId:865}]};
  await assert.rejects(synchronizeSpecialDescriptions(input,boundary),/Lost response/);
  await synchronizeSpecialDescriptions(input,boundary);
  assert.equal(writes,1);assert.equal(record.discountRate,-40);assert.equal(record.item.items[0].rate,10);
});

test('oversized totals and conflicting remote header discounts cannot become a financial update', async () => {
  assert.throws(() => sumSpecialAmounts([Number.MAX_SAFE_INTEGER]), { code: 'SPECIAL_SUBTOTAL_INVALID' });
  for (const header of [{discountItem:'999',discountRate:'-30'}, {discountItem:'10716',discountRate:'15'}, {discountItem:'10716',discountRate:'-15%'}]) {
    await assert.rejects(prepareSpecialAdjustmentPlan({orders:[{id:11,kind:'sales_order',discountMode:'total',lines:[]}]},
      {snapshot:async()=>({header,lines:[]})}), {code:'SPECIAL_ADJUSTMENT_CONFLICT'});
  }
});
