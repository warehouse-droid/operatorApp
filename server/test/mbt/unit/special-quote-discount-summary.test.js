import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import fc from 'fast-check';
import { buildSpecialQuote } from '../../../src/special-stock-documents.js';
import { quotePdf } from '../../../src/field-sales/pdf.js';
import { pdfText, pdfPages } from '../../field-sales/pdf-text.js';

const profile = { name: 'Mr Bin Building Supply LTD', address: '3445 Kennedy Road, Toronto',
  phone: '416-555-0100', taxBps: 1300, validityDays: 30 };
const material = (quantity, rate, discountPercent = 0, id = 1) => ({ id, productName: 'Stone',
  quantity, packageQuantity: quantity, uom: 'PLT', rateUom: 'PLT', rate, originalRate: rate, discountPercent });
const detail = lines => ({ requestRef: 'SPREQ-DISCOUNT-SAMPLE', revision: 2, inquiryDate: '2026-09-30',
  customerName: 'Example Landscaping', requestedByName: 'Example Sales', storeName: '3445',
  fulfillmentMethod: 'yard_pickup', lines, salesOrderLines: [] });

for (const draft of [true, false]) {
  test(`${draft ? 'draft' : 'saved'} quote shows positive total discount and percentage before the unchanged subtotal`, async () => {
    const input = detail([{ ...material(2, 520, 5), productName: 'Natural stone coping 建筑材料',
      color: 'Buff', size: '12 × 24 in', palletQty: 2, sectionQty: 4, layerQty: 3.5, pieceQty: 6 }]);
    const quote = buildSpecialQuote(input, profile, { draft });
    assert.equal(quote.snapshot.grossSubtotalMinor, 104000);
    assert.equal(quote.snapshot.discountMinor, 5200);
    assert.equal(quote.snapshot.discountPercent, 5);
    assert.equal(quote.snapshot.subtotalMinor, 98800);
    assert.equal(quote.snapshot.taxMinor, 12844);
    assert.equal(quote.snapshot.totalMinor, 111644);
    const pdf = await quotePdf(quote), text = pdfText(pdf);
    assert.match(text, /Subtotal before discount\$1,040\.00Total Discount \(5%\)\$52\.00Subtotal after discount\$988\.00/);
    assert.match(text, /HST \(13%\)\$128\.44Total CAD\$1,116\.44/);
    assert.equal(text.split('Total Discount').length, 2);
    assert.doesNotMatch(text, /-\$52\.00|\$936\.00/);
    assert(text.includes('建筑材料'));
    if (process.env.SPECIAL_DISCOUNT_OUTPUT) {
      mkdirSync(process.env.SPECIAL_DISCOUNT_OUTPUT, { recursive: true });
      writeFileSync(`${process.env.SPECIAL_DISCOUNT_OUTPUT}/${draft ? 'draft' : 'saved'}-quote.pdf`, pdf);
    }
  });
}

test('mixed percentages include undiscounted charges in the original quote amount', async () => {
  const input = detail([material(1, 100, 10, 1), material(1, 200, 20, 2)]);
  input.salesOrderLines = [{ caseLineId: 1 }, { caseLineId: 2 },
    { ancillary: true, description: 'PALLET', quantity: 2, uom: 'EACH', rate: 40, discountPercent: 99 }];
  const quote = buildSpecialQuote(input, profile);
  assert.equal(quote.snapshot.grossSubtotalMinor, 38000);
  assert.equal(quote.snapshot.discountMinor, 5000);
  assert.equal(quote.snapshot.discountPercent, 13.16);
  assert.equal(quote.snapshot.subtotalMinor, 33000);
  assert.equal(quote.snapshot.taxMinor, 4290);
  assert.equal(quote.snapshot.totalMinor, 37290);
  assert.equal(quote.snapshot.lines.at(-1).amountMinor, 8000);
  assert.match(pdfText(await quotePdf(quote)), /Subtotal before discount\$380\.00Total Discount \(13\.16%\)\$50\.00Subtotal after discount\$330\.00/);
});

test('summary adds independently rounded pennies rather than rounding an aggregate discount', async () => {
  const quote = buildSpecialQuote(detail([material(3, .01, 50, 1), material(3, .01, 50, 2)]), profile);
  assert.equal(quote.snapshot.grossSubtotalMinor, 6);
  assert.equal(quote.snapshot.discountMinor, 4);
  assert.equal(quote.snapshot.discountPercent, 66.67);
  assert.equal(quote.snapshot.subtotalMinor, 2);
  assert.equal(quote.snapshot.taxMinor, 0);
  assert.equal(quote.snapshot.totalMinor, 2);
  assert.match(pdfText(await quotePdf(quote)), /Subtotal before discount\$0\.06Total Discount \(66\.67%\)\$0\.04Subtotal after discount\$0\.02/);
});

for (const draft of [true, false]) {
  test(`${draft ? 'draft' : 'saved'} zero-discount quote shows Subtotal and HST without any discount wording`, async () => {
    for (const [rate, percent, subtotalMinor, taxMinor, totalMinor, summary] of [
      [100, 0, 10000, 1300, 11300, 'Subtotal$100.00HST (13%)$13.00Total CAD$113.00'],
      [0, 100, 0, 0, 0, 'Subtotal$0.00HST (13%)$0.00Total CAD$0.00'],
      [.01, 1, 1, 0, 1, 'Subtotal$0.01HST (13%)$0.00Total CAD$0.01']
    ]) {
      const input = { ...detail([material(1, rate, percent)]), requestRef: 'SPREQ-ZERO-SAMPLE' };
      const quote = buildSpecialQuote(input, profile, { draft });
      assert.equal(quote.snapshot.discountMinor, 0);
      assert.equal(quote.snapshot.subtotalMinor, subtotalMinor);
      assert.equal(quote.snapshot.taxMinor, taxMinor);
      assert.equal(quote.snapshot.totalMinor, totalMinor);
      const pdf = await quotePdf(quote), text = pdfText(pdf);
      assert(text.includes(summary));
      assert.doesNotMatch(text, /discount/i);
      assert.equal(text.split('Subtotal').length, 2);
      if (rate === 100 && process.env.SPECIAL_DISCOUNT_OUTPUT) {
        mkdirSync(process.env.SPECIAL_DISCOUNT_OUTPUT, { recursive: true });
        writeFileSync(`${process.env.SPECIAL_DISCOUNT_OUTPUT}/zero-${draft ? 'draft' : 'saved'}-quote.pdf`, pdf);
      }
    }
  });
}

test('full discounts and rounded positive discounts retain their summaries', async () => {
  for (const [rate, percent, discountMinor, discountPercent, subtotalMinor] of [
    [100, 100, 10000, 100, 0], [.2, 10, 1, 20, 4]
  ]) {
    const quote = buildSpecialQuote(detail([material(rate === .2 ? .25 : 1, rate, percent)]), profile);
    assert.equal(quote.snapshot.discountMinor, discountMinor);
    assert.equal(quote.snapshot.discountPercent, discountPercent);
    assert.equal(quote.snapshot.subtotalMinor, subtotalMinor);
    const text = pdfText(await quotePdf(quote));
    assert(text.includes(`Total Discount (${discountPercent}%)`));
    assert.doesNotMatch(text, /NaN|Infinity|Total Discount \(-/);
  }
});

test('legacy saved net prices do not fabricate unavailable original discounts', async () => {
  const input = detail([material(2, 999, 50)]);
  input.requestRef = 'SPREQ-LEGACY-SAMPLE';
  delete input.lines[0].originalRate;
  input.salesOrderLines = [{ caseLineId: 1, description: 'Legacy stone', quantity: 3, uom: 'PC', rate: 25 }];
  const quote = buildSpecialQuote(input, profile);
  assert.equal(quote.snapshot.subtotalMinor, 7500);
  assert.equal(quote.snapshot.grossSubtotalMinor, 7500);
  assert.equal(quote.snapshot.discountMinor, 0);
  assert.equal(quote.snapshot.discountPercent, 0);
  const text = pdfText(await quotePdf(quote));
  assert.match(text, /Subtotal\$75\.00HST \(13%\)\$9\.75Total CAD\$84\.75/);
  assert.doesNotMatch(text, /discount/i);
});

test('the discount and all totals stay together when the last item is near the page boundary', async () => {
  const input = detail(Array.from({ length: 9 }, (_, i) => material(1, 100, i === 0 ? 10 : 0, i + 1)));
  const pdf = await quotePdf(buildSpecialQuote(input, profile)), pages = pdfPages(pdf);
  assert.equal(pages.length, 2);
  assert(!pages[0].includes('Total Discount'));
  for (const label of ['Subtotal before discount', 'Total Discount (1.11%)', 'Subtotal after discount', 'HST (13%)', 'Total CAD', 'Signature']) {
    assert(pages[1].includes(label), label);
  }
  if (process.env.SPECIAL_DISCOUNT_OUTPUT) {
    writeFileSync(`${process.env.SPECIAL_DISCOUNT_OUTPUT}/boundary-quote.pdf`, pdf);
  }
});

test('invalid discounts and oversized original totals cannot produce a financial summary', () => {
  for (const percent of [-1, 100.0001, NaN, Infinity, 'invalid']) {
    assert.throws(() => buildSpecialQuote(detail([material(1, 10, percent)]), profile), { code: 'SPECIAL_DISCOUNT_INVALID' });
  }
  const tooLarge = detail([material(1e6, 8e7, 100, 1), material(1e6, 8e7, 100, 2)]);
  assert.throws(() => buildSpecialQuote(tooLarge, profile), { code: 'SPECIAL_QUOTE_INVALID' });
});

test('property: positive savings plus existing subtotal equal the original quote with a weighted percentage', () => {
  const row = fc.record({ quantity: fc.integer({ min: 1, max: 1000 }), cents: fc.integer({ min: 0, max: 100000 }),
    basis: fc.integer({ min: 0, max: 1000000 }) });
  fc.assert(fc.property(fc.array(row, { minLength: 1, maxLength: 15 }), fc.boolean(), (rows, draft) => {
    const quote = buildSpecialQuote(detail(rows.map((r, i) => material(r.quantity, r.cents / 100, r.basis / 10000, i + 1))), profile, { draft });
    const gross = rows.reduce((sum, r) => sum + BigInt(r.quantity) * BigInt(r.cents), 0n);
    const savings = rows.reduce((sum, r) => sum + (BigInt(r.quantity) * BigInt(r.cents) * BigInt(r.basis) + 500000n) / 1000000n, 0n);
    const net = gross - savings, tax = (net * 1300n + 5000n) / 10000n;
    const percentage = gross === 0n ? 0 : Number((savings * 10000n + gross / 2n) / gross) / 100;
    assert.equal(quote.snapshot.grossSubtotalMinor, Number(gross));
    assert.equal(quote.snapshot.discountMinor, Number(savings));
    assert.equal(quote.snapshot.discountPercent, percentage);
    assert.equal(quote.snapshot.subtotalMinor, Number(net));
    assert.equal(quote.snapshot.taxMinor, Number(tax));
    assert.equal(quote.snapshot.totalMinor, Number(net + tax));
    assert(quote.snapshot.discountMinor >= 0 && quote.snapshot.discountMinor <= quote.snapshot.grossSubtotalMinor);
  }), { seed: 20260930, numRuns: 250 });
});

test('property: actual PDF discounts remain positive and precede the subtotal', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 9999 }), fc.integer({ min: 1, max: 100 }),
    async (dollars, percent) => {
      const quote = buildSpecialQuote(detail([material(1, dollars, percent)]), profile);
      const text = pdfText(await quotePdf(quote));
      const money = value => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(value);
      assert(text.includes(`PLTMBBS-SpecialStoneDiscount: ${percent}%${money(dollars)}${money(dollars)}`));
      assert(text.includes(`Subtotal before discount${money(dollars)}Total Discount (${percent}%)${money(dollars * percent / 100)}Subtotal after discount${money(dollars * (100 - percent) / 100)}`));
    }), { seed: 20260931, numRuns: 8 });
});
