import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { prepareSpecialMaterial } from '../../../src/special-stock-pricing-domain.js';
import { buildSpecialSalesOrderPayload } from '../../../src/special-stock-request-netsuite.js';

function sqft(quantity, rate, discountPercent = 0, conversionToPc = 1) {
  return prepareSpecialMaterial({ itemId: 2055, description: 'TEST SQFT', quantity,
    packageQuantity: quantity, uom: 'SQFT', rate, discountPercent, conversionToPc },
  { pricingSource: 'enquiry', originalRate: rate, rateUom: 'SQFT', uom: 'SQFT', quantity });
}

test('new SQFT enquiry retains its native unit, quantity, gross rate and discount in the SO payload', () => {
  const material = { ...sqft(125.75, 10.67, 12.5), unitId: 866 };
  assert.equal(material.uom, 'SQFT');
  assert.equal(material.quantity, 125.75);
  assert.equal(material.rate, 10.67);
  assert.equal(material.nativeDiscountPercent ?? material.discountPercent, 12.5);
  const payload = buildSpecialSalesOrderPayload({ caseId: 1, netsuiteLocationId: 1, pickupMethodId: 1,
    discountMode: 'line', draft: { customerId: 1, fulfillmentMethod: 'yard_pickup', materialLines: [material] } });
  assert.equal(payload.item.items[0].units, '866');
  assert.equal(payload.item.items[0].quantity, 125.75);
  assert.equal(payload.item.items[0].rate, 10.67);
  assert.equal(payload.item.items[1].item.id, '10716');
});

test('SQFT rejects accidental PC relabeling and a nonidentity piece conversion', () => {
  assert.throws(() => sqft(20, 12, 0, 2), { code: 'SPECIAL_CONVERSION_MISMATCH' });
  assert.throws(() => prepareSpecialMaterial({ quantity: 40, packageQuantity: 20, conversionToPc: 2,
    uom: 'SQFT', rate: 12 }, { pricingSource: 'enquiry', originalRate: 12, rateUom: 'SQFT', uom: 'SQFT' }),
  { code: 'SPECIAL_CONVERSION_MISMATCH' });
  assert.throws(() => prepareSpecialMaterial({ quantity: 20, packageQuantity: 20, conversionToPc: 1,
    uom: 'PC', rate: 12 }, { pricingSource: 'enquiry', originalRate: 12, rateUom: 'SQFT', uom: 'SQFT' }),
  { code: 'SPECIAL_CONVERSION_MISMATCH' });
});

test('property: native SQFT draft never changes a valid quantity or rate', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 1000000 }), fc.integer({ min: 0, max: 100000 }),
    fc.integer({ min: 0, max: 1000000 }), (quantityCents, rateCents, percentUnits) => {
      const quantity = quantityCents / 100, rate = rateCents / 100, discount = percentUnits / 10000;
      const result = sqft(quantity, rate, discount);
      assert.equal(result.quantity, quantity);
      assert.equal(result.rate, rate);
      assert.equal(result.uom, 'SQFT');
      assert.equal(result.discountPercent, discount);
    }), { numRuns: 300, seed: 6102026 });
});
