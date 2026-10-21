import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { normalizeSpecialSupplyResponse } from '../../../src/special-stock-request-domain.js';
import { specialTransferAvailableDate, specialSupplyEtaLabel, isSpecialTransferEta } from '../../../public/special-stock-transfer-eta.js';
import { isSpecialWorkingDay } from '../../../public/special-stock-calendar.js';

const response = () => ({ supplyStatus: 'vendor_transfer', vendorId: 8899200, vendorName: 'TEST Vendor', vendorYard: 'TEST Vendor Yard' });

test('new transfer checks accept no date and discard stale or hostile client ETA inputs', () => {
  for (const patch of [{}, { availabilityMode: 'no_projection' }, { availabilityMode: 'so_placement' },
    { availabilityMode: 'dated', availableDate: '2099-02-01' }, { availabilityMode: 'dated', availableDate: 'invalid' }]) {
    const saved = normalizeSpecialSupplyResponse({ ...response(), ...patch });
    assert.equal(saved.supplyStatus, 'vendor_transfer');
    assert.equal(saved.availabilityMode, 'so_placement');
    assert.equal(saved.availableDate, null);
    assert.equal(saved.createsInternalTransfer, false);
  }
});

test('relative transfer mode cannot bypass date validation for other statuses', () => {
  assert.throws(() => normalizeSpecialSupplyResponse({ ...response(), supplyStatus: 'production', availabilityMode: 'so_placement' }), { code: 'SPECIAL_RESPONSE_AVAILABILITY_INVALID' });
  assert.throws(() => normalizeSpecialSupplyResponse({ ...response(), supplyStatus: 'production', availabilityMode: 'dated' }), { code: 'SPECIAL_RESPONSE_DATE_REQUIRED' });
});

test('transfer ETA counts five working days after placement, skipping Ontario holidays and weekends', () => {
  for (const [placed, expected] of [['2026-10-09', '2026-10-19'], ['2026-10-16', '2026-10-23'],
    ['2026-10-17', '2026-10-23'], ['2026-12-24', '2027-01-05'], ['2028-02-28', '2028-03-06']]) {
    assert.equal(specialTransferAvailableDate(placed), expected);
  }
  assert.equal(specialTransferAvailableDate(null), null);
  for (const invalid of ['2026-02-30', '2026-1-1', 'not a date']) assert.throws(() => specialTransferAvailableDate(invalid));
});

test('only new relative transfer lines show SO placement text; concrete and legacy dates keep their date', () => {
  const line = { supplyStatus: 'vendor_transfer', availabilityMode: 'so_placement', availableDate: null };
  assert.equal(isSpecialTransferEta(line), true);
  assert.equal(specialSupplyEtaLabel(line), 'SO placement +5 working days');
  assert.equal(specialSupplyEtaLabel({ ...line, availableDate: '2026-10-19' }), '2026-10-19');
  assert.equal(specialSupplyEtaLabel({ ...line, availabilityMode: 'dated', availableDate: '2020-01-10' }), '2020-01-10');
  assert.equal(specialSupplyEtaLabel({ ...line, supplyStatus: 'production' }, 'Not available'), 'Not available');
});

test('property: every calculated ETA is the fifth working day, independent of invocation time', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 365 * 15 }), offset => {
    const start = new Date('2025-01-01T12:00:00Z'); start.setUTCDate(start.getUTCDate() + offset);
    const input = start.toISOString().slice(0, 10), result = specialTransferAvailableDate(input);
    assert.equal(specialTransferAvailableDate(input), result);
    const target = new Date(result + 'T12:00:00Z');
    assert.ok(target > start && isSpecialWorkingDay(target));
    let count = 0;
    for (const day = new Date(start); day < target;) { day.setUTCDate(day.getUTCDate() + 1); if (isSpecialWorkingDay(day)) count++; }
    assert.equal(count, 5);
  }), { numRuns: 250, seed: 16102026 });
});
