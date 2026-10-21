import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {moneyMinor,expiryDeadline,effectiveStatus} from '../../public/mbr/domain.js';
test('property: decimal CAD values round-trip to cents exactly', () => {
  fc.assert(fc.property(fc.integer({min:0,max:999999999}), cents => {
    assert.equal(moneyMinor(`${Math.floor(cents / 100)}.${String(cents % 100).padStart(2,'0')}`), cents);
  }), {numRuns:300,seed:131026});
});

test('property: unsigned deadlines are monotonic and completed state is permanent', () => {
  fc.assert(fc.property(fc.integer({min:1,max:365}), days => {
    const start = new Date('2026-10-13T12:00:00Z'), end = expiryDeadline(start, days);
    assert.equal(Date.parse(end)-start.getTime(), days*86400000);
    assert.equal(effectiveStatus({status:'completed',expiresAt:end}, new Date('2030-01-01')), 'completed');
    assert.equal(effectiveStatus({status:'pending',expiresAt:end}, new Date(Date.parse(end)+1)), 'expired');
    assert.equal(effectiveStatus({status:'pending',expiresAt:end}, new Date(end)), 'expired');
    assert.equal(effectiveStatus({status:'pending',expiresAt:end}, new Date(Date.parse(end)-1)), 'pending');
  }), {numRuns:200,seed:131026});
});
