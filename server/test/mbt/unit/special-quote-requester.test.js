import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpecialQuote, createSpecialQuoteService } from '../../../src/special-stock-documents.js';
import { quotePdf } from '../../../src/field-sales/pdf.js';
import { pdfText } from '../../field-sales/pdf-text.js';

const profile = { name: 'MBBS', taxBps: 1300, validityDays: 30 };
const request = () => ({
  requestRef: 'SPREQ-TEST', revision: 1, requestedByName: 'Original Sales Rep',
  inquiryDate: '2099-01-01', customerName: 'Test customer', vendorName: 'Test vendor',
  fulfillmentMethod: 'yard_pickup', storeLocationId: 1,
  lines: [{ productName: 'Test slab', quantity: 2, packageQuantity: 2, uom: 'PLT', rateUom: 'PLT', rate: 10, originalRate: 10, requiredDate: '2099-01-01' }]
});

test('saved quote always credits the requester when a different Sales or SCM user opens it', async () => {
  for (const operatorName of ['Other Sales Viewer', 'SCM Viewer']) {
    const quote = buildSpecialQuote(request(), profile, { operatorName });
    assert.equal(quote.snapshot.salesRep, 'Original Sales Rep');
    const text = pdfText(await quotePdf(quote));
    assert.match(text, /Original Sales Rep/);
    assert.ok(!text.includes(operatorName));
  }
});

test('a saved quote without requester information never attributes ownership to its viewer', () => {
  assert.equal(buildSpecialQuote({ ...request(), requestedByName: '' }, profile, { operatorName: 'SCM Viewer' }).snapshot.salesRep, '');
});

test('the saved quote service ignores draft and operator overrides from a viewer', async () => {
  const quotes = [], scopes = [];
  const service = createSpecialQuoteService({
    getCase: async (id, scope) => { scopes.push({ id, ...scope }); return request(); },
    getProfile: async () => profile,
    renderPdf: async quote => { quotes.push(quote); return Buffer.from('PDF'); }
  });
  await service.savedQuote(1, { operatorName: 'SCM Viewer', draft: true, authorizedStoreLocationIds: [1] });
  assert.equal(quotes[0].snapshot.salesRep, 'Original Sales Rep');
  assert.equal(quotes[0].number, 'Q-SPREQ-TEST');
  assert.deepEqual(scopes, [{ id: 1, audience: 'sales', authorizedStoreLocationIds: [1] }]);
  await service.previewDraft({ ...request(), requestedByName: 'Untrusted browser value' }, {
    operatorName: 'Rep Creating Request', authorizedStoreLocationIds: [1]
  });
  assert.equal(quotes[1].snapshot.salesRep, 'Rep Creating Request');
  assert.equal(quotes[1].number, 'MBBS-QUOTE-DRAFT');
});
