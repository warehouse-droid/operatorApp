import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { specialPackPayload } from '../../../public/special-stock-line-details.js';
import { changedSpecialLineFields, specialLineFieldValues, specialLineFields } from '../../../public/special-stock-line-fields.js';
import { normalizeSpecialCaseDraft, normalizeSpecialAdditionalLines } from '../../../src/special-stock-request-domain.js';
import { buildSpecialSalesOrderPayload, buildSpecialPurchaseOrderPayload } from '../../../src/special-stock-request-netsuite.js';
import { createSpecialDiscountSalesOrderInNetSuite, createSalesOrderInNetSuite, transformEstimateToSalesOrderInNetSuite } from '../../../src/netsuite.js';
import { normalizePackQuantity, normalizeSalesOrderPackPayload } from '../../../public/order-pack-quantities.js';
import { buildWaitlistSalesOrder } from '../../../src/regular-waitlist-netsuite.js';
import { sandbox, payload as fieldSalesPayload } from '../../field-sales/order-restlet-fixture.js';

const fields = ['palletQty', 'layerQty', 'sectionQty', 'pieceQty'];
const native = ['custcol_plt', 'custcol_lyr', 'custcol_sec', 'custcol_pcs'];
const blanks = [undefined, null, '', ' \t ', 0, -0, '0', '0.00', '-0', ' 0 '];
const packs = value => Object.fromEntries(fields.map(field => [field, value]));
const material = extra => ({ productName: 'Stone', quantity: 24, uom: 'SQFT', rate: 10, requiredDate: '2099-02-01', ...extra });
const draft = line => ({ storeLocationId: 1, customerName: 'Test customer', vendorName: 'Test vendor', inquiryDate: '2099-01-01', fulfillmentMethod: 'yard_pickup', lines: [material(line)] });
const options = { authorizedStoreLocationIds: [1], minimumRequiredDate: '2099-01-01' };
const salesPayload = line => buildSpecialSalesOrderPayload({ caseId: 9, netsuiteLocationId: 1, pickupMethodId: 2,
  draft: { customerId: 10, fulfillmentMethod: 'yard_pickup', materialLines: [{ itemId: 2055, quantity: 24, rate: 10, unitId: 865, nativeDiscountPercent: 10, ...line }], ancillaryLines: [{ itemId: 1784, quantity: 2, rate: 40 }] } });

for (const [index, value] of blanks.entries()) {
  test(`empty or zero pack input ${index} is null in requests, additional lines and NetSuite columns`, () => {
    const line = normalizeSpecialCaseDraft(draft(packs(value)), options).lines[0];
    assert.deepEqual(fields.map(field => line[field]), [null, null, null, null]);
    const [added] = normalizeSpecialAdditionalLines([material(packs(value))], { existingLineCount: 1, minimumRequiredDate: '2099-01-01' });
    assert.deepEqual(fields.map(field => added[field]), [null, null, null, null]);
    assert.deepEqual(native.map(field => specialPackPayload(packs(value))[field]), [null, null, null, null]);
    const payload = salesPayload(packs(value));
    assert.deepEqual(native.map(field => payload.item.items[0][field]), [null, null, null, null]);
    assert.equal(payload.item.items[0].quantity, 24);
    assert.equal(payload.item.items[0].rate, 10);
    assert.equal(payload.discountRate, -24);
  });
}

test('pack edits can clear values to null and empty/legacy zero values render blank', () => {
  for (const value of blanks) {
    assert.deepEqual(changedSpecialLineFields(packs(value), packs(3)), packs(null));
    assert.deepEqual(changedSpecialLineFields(packs(value), packs(0)), {});
    const values = specialLineFieldValues(packs(value));
    const markup = specialLineFields(values);
    for (const field of fields) assert.match(markup, new RegExp(`name="${field}"[^>]*value=""`));
  }
});

test('property: independent positive packing quantities survive without modifying SO pricing or input', () => {
  fc.assert(fc.property(fc.tuple(...fields.map(() => fc.oneof(fc.constantFrom(...blanks), fc.integer({ min: 1, max: 1e9 }).map(n => n / 1000)))), values => {
    const input = Object.fromEntries(fields.map((field, i) => [field, values[i]]));
    const before = structuredClone(input), payload = salesPayload(input);
    assert.deepEqual(native.map(field => payload.item.items[0][field]), values.map(value => Number(value) > 0 ? Number(value) : null));
    assert.deepEqual(input, before);
    assert.equal(payload.item.items[0].quantity, 24);
    assert.equal(payload.item.items[0].rate, 10);
    assert.equal(payload.discountRate, -24);
    assert.equal(payload.item.items[0].units, '865');
  }), { seed: 20261016, numRuns: 250 });
});

test('invalid pack quantities are rejected before SO submission', () => {
  for (const value of [-1, Infinity, -Infinity, NaN, 1e9 + 1, 'bad', 'NaN', true, false, [], {}, [1]]) {
    for (const field of fields) {
      assert.throws(() => specialPackPayload({ [field]: value }), { status: 400 });
      assert.throws(() => normalizeSpecialCaseDraft(draft({ [field]: value }), options), { status: 400 });
    }
  }
});

test('discounted direct and estimate SO transports explicitly send null for every empty pack field', async () => {
  for (const estimateId of [null, 7]) {
    const payload = salesPayload({});
    Object.assign(payload.item.items[0], { custcol_plt: '0', custcol_lyr: 0, custcol_sec: null, custcol_pcs: '2.5' });
    const before = structuredClone(payload), calls = [];
    await createSpecialDiscountSalesOrderInNetSuite(payload, { estimateId, mutate: run => run(), rest: async (path, options) => { calls.push({ path, ...options }); return { id: 99 }; } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, estimateId === null ? '/record/v1/salesOrder' : '/record/v1/estimate/7/!transform/salesOrder?replace=item');
    assert.deepEqual(native.map(field => calls[0].body.item.items[0][field]), [null, null, null, 2.5]);
    assert.deepEqual(native.map(field => calls[0].body.item.items[1][field]), [null, null, null, null]);
    assert.deepEqual(payload, before);
  }
});

test('PO payloads retain existing behavior and independent purchase quantities', () => {
  const payload = buildSpecialPurchaseOrderPayload({ caseId: 9, vendorId: 5, netsuiteLocationId: 1,
    lines: [{ itemId: 2055, quantity: 24, rate: 10, ...packs(0) }] });
  assert.ok(native.every(field => !Object.hasOwn(payload.item.items[0], field)));
  assert.equal(payload.item.items[0].quantity, 24);
  assert.equal(payload.item.items[0].rate, 10);
});

test('Field Sales SO creation writes blank pack columns without changing accepted amounts', () => {
  const s = sandbox(), p = fieldSalesPayload('MBBS');
  s.records.set('customer:700', { id: '700', type: 'customer', fields: { entityid: 'Test', subsidiary: '1', currency: '1', isinactive: false }, sublists: {} });
  const result = s.post({ ...p, linkedCustomerId: '700', customerNetsuiteId: '700', action: 'order.create' });
  assert.equal(result.ok, true, result.message);
  const [line] = s.records.get('salesorder:' + result.internalId).sublists.item;
  assert.deepEqual(native.map(field => line[field]), [null, null, null, null]);
  assert.equal(result.totals.totalMinor, 6777);
});

test('direct, waitlist and quote conversion SO transports preserve positive counts and serialize all other packs as null', async () => {
  const waitlist = buildWaitlistSalesOrder({ id: '11111111-1111-4111-8111-111111111111', customerId: 10, itemId: 2055, quantity: 24,
    requestRef: 'TEST', fulfillment: { fulfillmentMethod: 'pickup' } }, { locationId: 1, unitsId: 865, subsidiaryId: 1 });
  for (const payload of [salesPayload({ palletQty: 1.5 }), waitlist]) {
    const before = structuredClone(payload);
    for (const transform of [false, true]) {
      const calls = [], boundary = { mutate: run => run(), rest: async (path, options) => { calls.push({ path, ...options }); return { id: 99 }; } };
      const result = transform ? await transformEstimateToSalesOrderInNetSuite(7, payload, boundary) : await createSalesOrderInNetSuite(payload, boundary);
      assert.equal(result.id, 99);
      assert.equal(calls[0].path, transform ? '/record/v1/estimate/7/!transform/salesOrder?replace=item' : '/record/v1/salesOrder');
      const sent = JSON.parse(JSON.stringify(calls[0].body));
      assert.deepEqual(native.map(field => sent.item.items[0][field]), [payload === waitlist ? null : 1.5, null, null, null]);
      assert.equal(sent.item.items[0].quantity, 24);
      assert.deepEqual(payload, before);
    }
  }
});

test('normalization is idempotent, retains sublist metadata and rejects invalid values before transport', async () => {
  const input = salesPayload({}); input.item.replaceAll = true;
  const normalized = normalizeSalesOrderPackPayload(input);
  assert.deepEqual(normalizeSalesOrderPackPayload(normalized), normalized);
  assert.equal(normalized.item.replaceAll, true);
  assert.equal(normalizeSalesOrderPackPayload(null), null);
  assert.deepEqual(normalizeSalesOrderPackPayload({ memo: 'Incomplete' }), { memo: 'Incomplete' });
  for (const value of [1e-6, '2.5', 1e9]) assert.equal(normalizePackQuantity(value), Number(value));
  input.item.items[0].custcol_sec = -1;
  let submitted = false;
  await assert.rejects(() => createSalesOrderInNetSuite(input, { rest: async () => { submitted = true; }, mutate: run => run() }), { status: 400 });
  assert.equal(submitted, false);
});

test('Field Sales normalizes zero and positive text packing, rejecting invalid counts before save', () => {
  for (const value of [null, '', '0', 0, '2.5', -1, true, 'bad', Infinity, 1e9 + 1]) {
    const s = sandbox(), p = fieldSalesPayload('MBBS');
    s.records.set('customer:700', { id: '700', type: 'customer', fields: { entityid: 'Test', subsidiary: '1', currency: '1', isinactive: false }, sublists: {} });
    for (const field of native) p.lines[0][field] = value;
    const result = s.post({ ...p, linkedCustomerId: '700', customerNetsuiteId: '700', action: 'order.create' });
    if ([-1, true, 'bad', Infinity, 1e9 + 1].includes(value)) {
      assert.equal(result.ok, false); assert.equal(s.saves.length, 0);
    } else {
      assert.equal(result.ok, true, result.message);
      assert.deepEqual(native.map(field => s.records.get('salesorder:' + result.internalId).sublists.item[0][field]), native.map(() => value === '2.5' ? 2.5 : null));
    }
  }
});
