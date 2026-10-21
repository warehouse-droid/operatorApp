import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import * as payloads from '../../../src/special-stock-request-netsuite.js';

test('confirmed rejection classification excludes uncertain responses and duplicate identities', () => {
  assert.equal(typeof payloads.isDefinitiveSpecialOrderRejection, 'function');
  const cases = fc.constantFrom(
    [400, true], [401, true], [403, true], [404, true], [422, true],
    [200, false], [408, false], [409, false], [429, false], [500, false], [503, false]
  );
  fc.assert(fc.property(cases, fc.boolean(), fc.constantFrom('', 'USER_ERROR', 'INVALID_FLD_VALUE',
    'DUPLICATE_EXTERNAL_ID', 'RECORD_ALREADY_EXISTS'), ([status, rejected], received, code) => {
    const duplicate = code === 'DUPLICATE_EXTERNAL_ID' || code === 'RECORD_ALREADY_EXISTS';
    assert.equal(payloads.isDefinitiveSpecialOrderRejection({ status, netsuiteResponseReceived: received,
      netsuiteErrorCodes: code ? [code] : [] }), rejected && received && !duplicate);
  }), { numRuns: 250, seed: 174 });
  for (const error of [null, undefined, new Error('Timeout'), { status: 400 }, { status: 400, netsuiteResponseReceived: 'true' }]) {
    assert.equal(payloads.isDefinitiveSpecialOrderRejection(error), false);
  }
});
