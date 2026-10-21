import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { resolveSpecialUnits } from '../../../src/special-stock-netsuite-adapter.js';

const href = (typeId, unitId, record = 'unitstype') =>
  `https://example.suitetalk.api.netsuite.com/services/rest/record/v1/${record}/${typeId}/uom/${unitId}`;
const nativeUnit = (typeId, unitId, label = 'SQFT') => ({
  links: [{ rel: 'self', href: href(typeId, unitId), method: 'GET' }],
  abbreviation: label, baseUnit: false, conversionRate: 1, inUse: true,
  pluralAbbreviation: label, pluralName: label, unitName: label
});
function boundary(items, typeId = 353) {
  const reads = [];
  return {
    reads,
    queryAll: async sql => {
      reads.push(sql);
      return [{ unitstype: typeId, sales_unit_id: 865, sales_unit: 'PC', purchase_unit_id: 865, purchase_unit: 'PC' }];
    },
    rest: async (path, options) => {
      assert.equal(options, undefined, 'Unit lookup must not write to NetSuite');
      reads.push(path);
      return { data: { uom: { items } } };
    }
  };
}

test('SPREQ-000032 resolves SQFT from the native self link and preserves complete line values', async () => {
  const lines = [
    { itemId: 2055, quantity: 120, uom: 'SQFT', rate: 22.88, unitPurchaseCost: 18.88, description: 'Bullnose coping' },
    { itemId: 2055, quantity: 45, uom: ' sqft ', rate: 17, description: 'Other material' }
  ];
  const dependencies = boundary([nativeUnit(353, 865, 'PC'), nativeUnit(353, 866)]);
  const result = await resolveSpecialUnits(lines, dependencies);
  assert.deepEqual(result, lines.map(line => ({ ...line, unitId: 866 })));
  assert.equal(Object.hasOwn(lines[0], 'unitId'), false);
  assert.equal(dependencies.reads.length, 2);
  assert.equal(dependencies.reads[1], '/record/v1/unitsType/353?expandSubResources=true');
});

test('property: native self links resolve exactly across supported UOM label fields', async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 1000000 }), fc.integer({ min: 1, max: 1000000 }),
    fc.constantFrom('abbreviation', 'pluralAbbreviation', 'unitName', 'pluralName'),
    fc.constantFrom('unitstype', 'unitsType'), fc.boolean(),
    async (typeId, unitId, labelField, record, stringType) => {
      const unit = { [labelField]: 'SQFT', links: [{ rel: 'self', href: href(typeId, unitId, record) }] };
      const line = { itemId: 2055, quantity: 120, uom: ' sqft ', rate: 22.88 };
      const result = await resolveSpecialUnits([line], boundary([unit], stringType ? String(typeId) : typeId));
      assert.deepEqual(result, [{ ...line, unitId }]);
    }
  ), { seed: 5102026, numRuns: 100 });
});

const hostile = [
  ['missing self link', { links: [] }],
  ['missing href', { links: [{ rel: 'self' }] }],
  ['nonstring href', { links: [{ rel: 'self', href: 866 }] }],
  ['nonarray links', { links: {} }],
  ['wrong relationship', { links: [{ rel: 'alternate', href: href(353, 866) }] }],
  ['wrong units type', { links: [{ rel: 'self', href: href(354, 866) }] }],
  ['wrong record', { links: [{ rel: 'self', href: href(353, 866, 'salesOrder') }] }],
  ['missing unit', { links: [{ rel: 'self', href: href(353, '') }] }],
  ['zero unit', { links: [{ rel: 'self', href: href(353, 0) }] }],
  ['negative unit', { links: [{ rel: 'self', href: href(353, -1) }] }],
  ['fractional unit', { links: [{ rel: 'self', href: href(353, 1.5) }] }],
  ['unsafe unit', { links: [{ rel: 'self', href: href(353, '9007199254740993') }] }],
  ['appended subresource', { links: [{ rel: 'self', href: href(353, 866) + '/other' }] }],
  ['ambiguous self links', { links: [{ rel: 'self', href: href(353, 866) }, { rel: 'self', href: href(353, 867) }] }]
];
for (const [name, patch] of hostile) {
  test(`native UOM lookup rejects ${name} before any remote write`, async () => {
    await assert.rejects(resolveSpecialUnits([{ itemId: 2055, uom: 'SQFT', quantity: 120 }],
      boundary([{ ...nativeUnit(353, 866), ...patch }])), { code: 'SPECIAL_UOM_INVALID', status: 409 });
  });
}

test('explicit native IDs retain their precedence over link fallback', async () => {
  for (const [unit, expected] of [
    [{ ...nativeUnit(353, 868), internalId: '866', id: '867' }, 866],
    [{ ...nativeUnit(353, 868), id: '867' }, 867]
  ]) {
    const result = await resolveSpecialUnits([{ itemId: 2055, uom: 'SQFT', quantity: 120 }], boundary([unit]));
    assert.equal(result[0].unitId, expected);
  }
});

test('property: foreign units types and invalid link IDs cannot acquire a native identity', async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 1000000 }), fc.integer({ min: 1, max: 1000000 }),
    fc.constantFrom('0', '-1', '1.5', '9007199254740993', 'not-an-id'),
    async (typeId, unitId, invalidId) => {
      for (const unit of [nativeUnit(typeId + 1, unitId), nativeUnit(typeId, invalidId)]) {
        await assert.rejects(resolveSpecialUnits([{ itemId: 2055, uom: 'SQFT', quantity: 120 }],
          boundary([unit], typeId)), { code: 'SPECIAL_UOM_INVALID', status: 409 });
      }
    }
  ), { seed: 5102027, numRuns: 100 });
});

test('property: explicit native IDs retain exact precedence and preserve quantities', async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 1000000 }), fc.integer({ min: 1, max: 1000000 }), fc.boolean(),
    async (unitId, quantity, internal) => {
      const unit = { ...nativeUnit(353, unitId + 2), id: String(unitId) };
      if (internal) unit.internalId = String(unitId + 1);
      const line = { itemId: 2055, uom: 'SQFT', quantity, rate: 22.88 };
      const result = await resolveSpecialUnits([line], boundary([unit]));
      assert.deepEqual(result, [{ ...line, unitId: internal ? unitId + 1 : unitId }]);
    }
  ), { seed: 5102028, numRuns: 100 });
});
