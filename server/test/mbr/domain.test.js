import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyMinor, normalizeContractFields, expiryDeadline, effectiveStatus,
  isMbrOnly, staffPathAllowed, requireMbrAuthority, normalizeSigningRequest } from '../../public/mbr/domain.js';
import { fields } from './fixtures.js';

test('money uses exact CAD cents and never converts a missing rate into zero', () => {
  assert.equal(moneyMinor('250.01'), 25001);
  assert.equal(moneyMinor('0'), 0);
  for (const input of ['', undefined, '-1', '1.001', '1e3', 'Infinity', '1,000', {}, '9'.repeat(25)]) {
    assert.throws(() => moneyMinor(input), /amount/i);
  }
});

test('sales fields fill every blank and reject invalid periods and inputs', () => {
  const value = normalizeContractFields(fields());
  assert.equal(value.dailyRateMinor, 25000);
  assert.equal(value.securityDepositMinor, 50000);
  assert.equal(normalizeContractFields(fields({expiryDays: undefined})).expiryDays, null);
  for (const override of [{rentalEnd:'2026-10-14'}, {effectiveDate:'2026-02-30'},
    {expiryDays:0}, {expiryDays:1.5},
    {expiryDays:Number.MAX_SAFE_INTEGER}, {lessee:'x'.repeat(301)}]) {
    assert.throws(() => normalizeContractFields(fields(override)));
  }
  for (const input of [null,[],true]) {assert.throws(()=>normalizeContractFields(input),{status:400});}
});

test('expiry is exactly 72 hours and inclusive at the boundary; completed never expires', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  assert.equal(expiryDeadline(now, 3), '2026-11-03T12:00:00.000Z');
  const pending = {status:'pending', expiresAt:expiryDeadline(now, 3)};
  assert.equal(effectiveStatus(pending, new Date('2026-11-03T11:59:59.999Z')), 'pending');
  assert.equal(effectiveStatus(pending, new Date(pending.expiresAt)), 'expired');
  assert.equal(effectiveStatus({status:'pending',expiresAt:null}, now), 'pending');
  assert.equal(effectiveStatus({...pending,status:'completed'}, new Date('2027-01-01')), 'completed');
});

test('MBR role grants only MBR and shared session APIs while mixed-role access survives', () => {
  const mbr = {role:'mbr_sales',roles:['mbr_sales']};
  const mixed = {role:'mbr_sales',roles:['mbr_sales','sales']};
  assert.equal(isMbrOnly(mbr), true);
  assert.equal(isMbrOnly(mixed), false);
  assert.equal(staffPathAllowed(mbr, '/api/auth/me'), true);
  assert.equal(staffPathAllowed(mbr, '/api/mbr/contracts'), true);
  assert.equal(staffPathAllowed(mbr, '/api/orders'), false);
  assert.equal(staffPathAllowed(mbr, '/api/mbr-other'), false);
  assert.equal(staffPathAllowed(mixed, '/api/sales/orders'), true);
  assert.doesNotThrow(() => requireMbrAuthority(mbr));
  assert.doesNotThrow(() => requireMbrAuthority({role:'admin'}));
  assert.throws(() => requireMbrAuthority({role:'sales'}), {status:403});
});

test('signing requires explicit choices, consent and reviewed revision', () => {
  const valid = {revision:1, protectionPlanAccepted:false, consent:true,
    signerName:'Alice Customer', signatureDataUrl:'data:image/png;base64,abc',
    submissionId:'12345678-1234-4234-8234-123456789abc'};
  assert.equal(normalizeSigningRequest(valid).protectionPlanAccepted, false);
  for (const override of [{protectionPlanAccepted:undefined},{protectionPlanAccepted:'false'},
    {consent:false},{revision:0},{signerName:''},{dailyRate:1},{submissionId:'bad'}]) {
    assert.throws(() => normalizeSigningRequest({...valid,...override}));
  }
  for (const input of [null,[],true]) {assert.throws(()=>normalizeSigningRequest(input),{status:400});}
});

