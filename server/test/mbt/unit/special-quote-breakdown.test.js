import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildSpecialQuote } from '../../../src/special-stock-documents.js';
import { quotePdf } from '../../../src/field-sales/pdf.js';
import { pdfText, pdfPages } from '../../field-sales/pdf-text.js';

const profile = { name: 'Mr Bin Building Supply LTD', taxNumber: '719366486',
  address: '3445 Kennedy Road\nToronto ON M1V 4Y3', phone: '(416) 912-9555', taxBps: 1300, validityDays: 30 };
const detail = () => ({ requestRef: 'SPREQ-USER-EXAMPLE', revision: 1, inquiryDate: '2026-09-30',
  customerName: 'sadads', customerPhone: 'asdads', requestedByName: 'testAdmin', storeName: '3445',
  fulfillmentMethod: 'vendor_pickup', salesOrderLines: [],
  lines: [[123, 12, 'sadasd'], [23, 22, 'sdas']].map(([quantity, discountPercent, productName], i) => ({
    id: i + 1, productName, quantity, packageQuantity: quantity, rate: 123, originalRate: 123,
    discountPercent, uom: 'PLT', rateUom: 'PLT', palletQty: 0, sectionQty: 0, layerQty: 0, pieceQty: 0
  })) });

for (const draft of [true, false]) {
  test(`${draft ? 'draft' : 'saved'} user's Ontario example displays original item amounts and the complete gross-to-net tax breakdown`, async () => {
    const quote = buildSpecialQuote(detail(), profile, { draft, operatorName: 'testAdmin' });
    assert.deepEqual(quote.snapshot.lines.map(line => line.grossAmountMinor), [1512900, 282900]);
    assert.deepEqual(quote.snapshot.lines.map(line => line.amountMinor), [1331352, 220662]);
    assert.equal(quote.snapshot.grossSubtotalMinor, 1795800);
    assert.equal(quote.snapshot.discountMinor, 243786);
    assert.equal(quote.snapshot.discountPercent, 13.58);
    assert.equal(quote.snapshot.subtotalMinor, 1552014);
    assert.equal(quote.snapshot.taxMinor, 201762);
    assert.equal(quote.snapshot.totalMinor, 1753776);
    const pdf = await quotePdf(quote), text = pdfText(pdf);
    assert.match(text, /123PLTMBBS-SpecialsadasdDiscount: 12%\$123\.00\$15,129\.000000/);
    assert.match(text, /23PLTMBBS-SpecialsdasDiscount: 22%\$123\.00\$2,829\.000000/);
    assert.match(text, /Subtotal before discount\$17,958\.00Total Discount \(13\.58%\)\$2,437\.86Subtotal after discount\$15,520\.14HST \(13%\)\$2,017\.62Total CAD\$17,537\.76/);
    assert.doesNotMatch(text, /\$13,082\.28|\$1,700\.70|\$14,782\.98/);
    assert.equal(pdfPages(pdf).length, 1);
    if (process.env.SPECIAL_DISCOUNT_OUTPUT) {
      mkdirSync(process.env.SPECIAL_DISCOUNT_OUTPUT, { recursive: true });
      writeFileSync(`${process.env.SPECIAL_DISCOUNT_OUTPUT}/user-${draft ? 'draft' : 'saved'}-quote.pdf`, pdf);
    }
  });
}
