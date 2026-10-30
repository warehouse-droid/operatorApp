import assert from 'node:assert/strict';
import test from 'node:test';
import { quotePdf } from '../../src/field-sales/pdf.js';
import { pdfText } from './pdf-text.js';

const fields = ['palletQty', 'sectionQty', 'layerQty', 'pieceQty'];
const summary = 'Subtotal$1,040.00HST (13%)$135.20Total CAD$1,175.20';
const row = '2PLTPacking fixture$520.00$1,040.00';
function savedQuote(packQuantities, schemaVersion = 2) {
  const totals = { subtotalMinor: 104000, taxMinor: 13520, totalMinor: 117520, taxBps: 1300 };
  return { number: 'Q-PACKING-FIXTURE', selected_revision: 1, snapshot: {
    schemaVersion, company: 'MBBS', simpleDetails: true, showPackQuantities: true,
    customerName: 'Example Builder', jobsite: { address: 'Pickup at 3445' },
    quoteDate: '2026-10-26', companyProfiles: { MBBS: { name: 'MBBS', taxBps: 1300 } },
    companies: { MBBS: totals }, ...totals,
    lines: [{ company: 'MBBS', description: 'Packing fixture', quantity: '2',
      unit: 'PLT', unitRate: '520', amountMinor: 104000, packQuantities }]
  } };
}

for (const schemaVersion of [2, 3]) {
  test(`saved schema ${schemaVersion} PDF leaves every zero or missing packing cell blank`, async () => {
    for (const value of [0, -0, '0', '0.000', '-0.00', null, undefined, '', '  ']) {
      const quote = savedQuote(Object.fromEntries(fields.map(field => [field, value])), schemaVersion);
      const before = structuredClone(quote);
      const text = pdfText(await quotePdf(quote));
      assert(text.includes('AmountPLTSECLYRPCS'));
      assert(text.includes(row + summary), `Packing cells must be empty for ${JSON.stringify(value)}`);
      assert.deepEqual(quote, before, 'Rendering must preserve the saved snapshot');
    }
  });
}

test('PDF preserves positive packing values while blanking each zero column independently', async () => {
  const values = [2, '4.250', 3.5, 6];
  for (let emptyIndex = 0; emptyIndex < fields.length; emptyIndex++) {
    const expected = values.map((value, index) => index === emptyIndex ? '' : String(value)).join('');
    const packs = Object.fromEntries(fields.map((field, index) => [field, index === emptyIndex ? '0.00' : values[index]]));
    const text = pdfText(await quotePdf(savedQuote(packs)));
    assert(text.includes(row + expected + summary), `Correct packing values after blanking ${fields[emptyIndex]}`);
  }
});

test('PDF keeps zero prices and totals visible when packing cells are empty', async () => {
  const quote = savedQuote(Object.fromEntries(fields.map(field => [field, 0])));
  Object.assign(quote.snapshot.lines[0], { unitRate: '0', amountMinor: 0 });
  for (const totals of [quote.snapshot, quote.snapshot.companies.MBBS]) {
    Object.assign(totals, { subtotalMinor: 0, taxMinor: 0, totalMinor: 0 });
  }
  const text = pdfText(await quotePdf(quote));
  assert(text.includes('2PLTPacking fixture$0.00$0.00Subtotal$0.00HST (13%)$0.00Total CAD$0.00'));
});
