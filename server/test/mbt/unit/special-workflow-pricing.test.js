import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { normalizeSpecialCaseDraft, normalizeSpecialSalesOrderDraft } from '../../../src/special-stock-request-domain.js';
import { normalizeSpecialRate, normalizeSpecialDiscount, discountedSpecialRate, earliestSpecialDeliveryDate, assertSpecialDeliveryDate, specialLineSubtotal, specialNativePricing } from '../../../public/special-stock-pricing.js';
import { prepareSpecialMaterial } from '../../../src/special-stock-pricing-domain.js';

function enquiry(rate) {
  return { storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST', vendorName: 'TEST',
    fulfillmentMethod: 'yard_pickup', lines: [{ productName: 'TEST', quantity: 12, uom: 'EACH', rate, requiredDate: '2099-02-01' }] };
}
test('unpriced legacy entry is explicit, and existing native-unit prices keep their recorded basis',()=>{
  const legacy=prepareSpecialMaterial({quantity:3,uom:'SQFT',rate:12},{pricingSource:'legacy',originalRate:null});
  assert.equal(legacy.originalRate,12);assert.equal(legacy.conversionToPc,1);assert.equal(legacy.uom,'SQFT');
  const fixed={pricingSource:'legacy_order',originalRate:12,rateUom:'SQFT',discountPercent:10};
  assert.equal(prepareSpecialMaterial({quantity:3,uom:'SQFT',rate:12},fixed).rate,10.8);
  assert.throws(()=>prepareSpecialMaterial({quantity:23,packageQuantity:2,conversionToPc:12,uom:'PC',rate:120},{pricingSource:'enquiry',originalRate:120,uom:'PLT'}),{code:'SPECIAL_CONVERSION_MISMATCH'});
});
test('pricing rejects unrepresentable totals and converted quantities instead of rounding quantities silently',()=>{
  assert.throws(()=>specialLineSubtotal(1e9,1e9),{code:'SPECIAL_SUBTOTAL_INVALID'});
  for(const value of [null,'',false,-1,Infinity])assert.throws(()=>specialLineSubtotal(value,10),{code:'SPECIAL_QUANTITY_INVALID'});
  for(const [quantity,conversion]of [[1e9,2],[0.000001,0.000001]])assert.throws(()=>specialNativePricing({quantity,rate:1,conversionToPc:conversion}),{code:'SPECIAL_CONVERSION_INVALID'});
  assert.throws(()=>earliestSpecialDeliveryDate(new Date('invalid')),{code:'SPECIAL_DELIVERY_DATE_INVALID'});
});
test('property: line subtotals preserve both discount endpoints and exact cent rounding',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:1000}),fc.integer({min:0,max:100000}),fc.integer({min:0,max:10000}),
    (quantity,cents,percentBasis)=>{
      assert.equal(specialLineSubtotal(quantity,cents/100,0),quantity*cents/100);
      assert.equal(specialLineSubtotal(quantity,cents/100,100),0);
      const expected=Number((BigInt(quantity)*BigInt(cents)*BigInt(10000-percentBasis)+5000n)/10000n)/100;
      assert.equal(specialLineSubtotal(quantity,cents/100,percentBasis/100),expected);
    }),{numRuns:500,seed:24092029});
});
test('property: explicit PC conversion preserves the packaging subtotal and exact piece count',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:1000}),fc.integer({min:1,max:100}),fc.integer({min:1,max:1000}),fc.constantFrom(0,25,50,75,100),
    (quantity,conversion,pcRate,discount)=>{
      const price=specialNativePricing({quantity,conversionToPc:conversion,rate:pcRate*conversion,discountPercent:discount});
      assert.equal(price.quantity,quantity*conversion);assert.equal(price.rate,pcRate*(100-discount)/100);
      assert.equal(price.subtotal,specialLineSubtotal(quantity,pcRate*conversion,discount));
      assert.equal(price.subtotal,specialLineSubtotal(price.quantity,price.rate,0));
    }),{numRuns:300,seed:24092030});
});
for (const [label, value] of [['missing', undefined], ['blank', ''], ['spaces', ' '], ['null', null], ['negative', -1], ['infinite', Infinity], ['NaN', 'x'], ['too large', 1e10], ['excess precision', '1.0000001'], ['boolean', false]]) {
  test(`new enquiry rejects ${label} rate`, () => {
    assert.throws(() => normalizeSpecialCaseDraft(enquiry(value), { authorizedStoreLocationIds: [1] }), { code: 'SPECIAL_RATE_INVALID' });
  });
}
test('enquiry preserves an explicit price including zero', () => {
  for (const rate of [0, '12.345678']) {
    const line = normalizeSpecialCaseDraft(enquiry(rate), { authorizedStoreLocationIds: [1] }).lines[0];
    assert.equal(line.rate, Number(rate));
    assert.equal(normalizeSpecialRate(rate), Number(rate));
  }
});
test('percentage discount uses exact bounded decimal rounding', () => {
  assert.equal(discountedSpecialRate('19.99', '12.5'), 17.49125);
  assert.equal(discountedSpecialRate('0.000001', '50'), 0.000001);
  assert.equal(discountedSpecialRate('123.456789', 100), 0);
  assert.equal(normalizeSpecialDiscount(''), 0);
  for (const value of [-1, 100.01, 'bad', Infinity, false, '1.00001']) {
    assert.throws(() => normalizeSpecialDiscount(value), { code: 'SPECIAL_DISCOUNT_INVALID' });
  }
});
test('property: discounts retain endpoints and are monotone within the original price', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 1e9 }), fc.integer({ min: 0, max: 1e6 }), fc.integer({ min: 0, max: 1e6 }), (micros, a, b) => {
    const rate = micros / 1e6, low = Math.min(a,b)/1e4, high = Math.max(a,b)/1e4;
    const x = discountedSpecialRate(rate, low), y = discountedSpecialRate(rate, high);
    assert.equal(discountedSpecialRate(rate, 0), rate);
    assert.equal(discountedSpecialRate(rate, 100), 0);
    assert.ok(x <= rate && x >= y && y >= 0);
  }), { numRuns: 500, seed: 24092027 });
});
test('delivery minimum counts three following weekdays in Toronto across weekends and DST', () => {
  for (const [now, expected] of [
    ['2026-09-24T15:00:00Z','2026-09-29'], ['2026-09-25T15:00:00Z','2026-09-30'],
    ['2026-09-26T15:00:00Z','2026-09-30'], ['2026-11-01T07:00:00Z','2026-11-04'],
    ['2026-09-25T02:00:00Z','2026-09-29']
  ]) assert.equal(earliestSpecialDeliveryDate(new Date(now)), expected);
});
test('delivery date accepts the boundary and rejects earlier or impossible dates', () => {
  const options = { now: new Date('2026-09-25T15:00:00Z') };
  assert.equal(assertSpecialDeliveryDate('2026-09-30', options), '2026-09-30');
  assert.equal(assertSpecialDeliveryDate('', options), null);
  assert.throws(() => assertSpecialDeliveryDate('2026-09-29', options), { code: 'SPECIAL_DELIVERY_DATE_TOO_SOON' });
  assert.throws(() => assertSpecialDeliveryDate('2027-02-30', options), { code: 'SPECIAL_DELIVERY_DATE_INVALID' });
});
test('SO draft validates its delivery date and retains a discount percentage', () => {
  const draft = { customerId: 8899100, operationalYardLocationId: 1, fulfillmentMethod: 'mbt_delivery', deliveryAddress: 'TEST',
    deliveryDate: '2026-09-29', palletTotal: 0, materialLines: [{ caseLineId: 1, itemId: 2055, quantity: 12, uom: 'PC', description: 'TEST', rate: 20, discountPercent: 10 }] };
  const options = { now: new Date('2026-09-25T15:00:00Z') };
  assert.throws(() => normalizeSpecialSalesOrderDraft(draft, options), { code: 'SPECIAL_DELIVERY_DATE_TOO_SOON' });
  const normalized = normalizeSpecialSalesOrderDraft({ ...draft, deliveryDate: '2026-09-30' }, options);
  assert.equal(normalized.materialLines[0].discountPercent, 10);
});

test('enquiry discounts and per-line subtotals use the original packaging rate', () => {
  const input = enquiry(125);
  input.lines[0].discountPercent = 12.5;
  const line = normalizeSpecialCaseDraft(input, { authorizedStoreLocationIds: [1] }).lines[0];
  assert.equal(line.discountPercent, 12.5);
  assert.equal(line.subtotal, 1312.5);
  assert.equal(specialLineSubtotal(3, '19.99', '12.5'), 52.47);
  assert.equal(specialLineSubtotal(1, '0.005', 0), 0.01);
});
test('explicit PC conversion preserves price basis, native quantity and subtotal', () => {
  assert.deepEqual(specialNativePricing({ quantity: 2, rate: 120, discountPercent: 10, conversionToPc: 12 }), {
    packageQuantity: 2, conversionToPc: 12, quantity: 24, uom: 'PC', rate: 9, subtotal: 216
  });
  assert.equal(specialNativePricing({ quantity: 1, rate: 10, conversionToPc: 3 }).subtotal, 10);
  assert.throws(() => specialNativePricing({ quantity: 1, rate: 10, conversionToPc: '' }), { code: 'SPECIAL_CONVERSION_INVALID' });
  assert.throws(() => specialNativePricing({ quantity: 100000, rate: 10, conversionToPc: 3 }), { code: 'SPECIAL_CONVERSION_ROUNDING' });
});
test('Ontario holidays and weekend observances do not count as working days', () => {
  for (const [now, expected] of [
    ['2026-02-13T15:00:00Z','2026-02-19'], ['2026-04-02T15:00:00Z','2026-04-08'],
    ['2026-05-15T15:00:00Z','2026-05-21'], ['2026-06-30T15:00:00Z','2026-07-06'],
    ['2026-09-04T15:00:00Z','2026-09-10'], ['2026-10-09T15:00:00Z','2026-10-15'],
    ['2026-12-24T15:00:00Z','2026-12-31'], ['2026-12-31T15:00:00Z','2027-01-06'],
    ['2027-12-24T15:00:00Z','2027-12-31'], ['2026-07-31T15:00:00Z','2026-08-05']
  ]) assert.equal(earliestSpecialDeliveryDate(new Date(now)), expected, now);
});
