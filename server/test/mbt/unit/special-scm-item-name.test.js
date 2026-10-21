import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { normalizeSpecialSupplyResponse } from '../../../src/special-stock-request-domain.js';

const response = { supplyStatus: 'in_stock', availabilityMode: 'no_projection',
  vendorId: 330, vendorName: 'BWS', vendorYard: 'Vendor yard' };

test('SCM stock response normalizes a corrected item name and keeps omission compatible', () => {
  assert.equal(normalizeSpecialSupplyResponse({ ...response, productName: '  Fire Pit 32" Square Insert  ' }).productName,
    'Fire Pit 32" Square Insert');
  assert.equal(normalizeSpecialSupplyResponse(response).productName, undefined);
});

test('SCM rejects an explicitly empty or oversized item name', () => {
  for (const productName of ['', '  ', null]) {
    assert.throws(() => normalizeSpecialSupplyResponse({ ...response, productName }), { code: 'SPECIAL_RESPONSE_PRODUCT_REQUIRED' });
  }
  assert.throws(() => normalizeSpecialSupplyResponse({ ...response, productName: 'x'.repeat(501) }), { code: 'SPECIAL_FIELD_TOO_LONG' });
  assert.equal(normalizeSpecialSupplyResponse({ ...response, productName: 'x'.repeat(500) }).productName.length, 500);
});

test('property: SCM item-name normalization preserves bounded Unicode and is idempotent', () => {
  fc.assert(fc.property(fc.array(fc.constantFrom('A', '火', 'é', '"', '&', '<', '>'), { minLength: 1, maxLength: 100 }), chars => {
    const productName = chars.join('');
    const normalized = normalizeSpecialSupplyResponse({ ...response, productName: `  ${productName}\r\n ` }).productName;
    assert.equal(normalized, productName);
    assert.equal(normalizeSpecialSupplyResponse({ ...response, productName: normalized }).productName, normalized);
  }), { seed: 33016, numRuns: 100 });
});
