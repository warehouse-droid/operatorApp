import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';

const source = fs.readFileSync('public/operator.js', 'utf8');
function ui({ mode = 'pallet', stock = false, plate = '', photos = ['photo'] } = {}) {
  const context = vm.createContext({
    returnMode: mode, returnType: 'normal', returnVehiclePlate: plate,
    returnPalletQuantity: 1, returnPalletPhotos: photos, returnRecordPhotos: ['photo'],
    returnValidationMessage: '', returnHeaderNote: '', returnBusy: false, RETURN_QUANTITY_EPSILON: 0.000001,
    t: (_key, fallback) => fallback, tf: (_key, fallback) => fallback, escapeHtml: String,
    returnCustomerId: () => 12, returnOrderId: () => stock ? 34 : null, returnYardGate: () => ({ blocked: false }),
    currentPalletBalance: () => ({ available: 5 }), returnBalanceAvailable: () => 5,
    returnSelectedRows: () => stock ? [{}] : [], returnLines: () => [],
    returnOrderRef: () => stock ? 'SO34' : '', returnCustomerName: () => 'Customer',
    renderReturnPhotoWorkspace: () => '', renderReturnPalletReviewLine: () => 'PALLET',
    renderReturnPostingPolicies: () => '', renderReturnCustomerSummary: () => '', renderReturnYardBanner: () => '',
    renderReturnReviewLine: () => 'Stock', returnPostingReady: () => true,
    renderReturnPhotoSummary: () => ''
  });
  for (const [start, end] of [
    ['function validateReturnForReview(', 'async function uploadReturnPhotoList('],
    ['function renderReturnReview()', 'function returnNetSuiteResultLabel(']
  ]) {
    const from = source.indexOf(start); const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    vm.runInContext(source.slice(from, to), context);
  }
  return context;
}

test('P4 pallet-only review permits blank plate and displays it as optional read-only information', () => {
  const page = ui();
  assert.equal(page.validateReturnForReview(), '');
  const html = page.renderReturnReview();
  assert.match(html, /Vehicle plate[^<]*Optional/);
  assert.doesNotMatch(html, /data-return-input="vehiclePlate"/);
  assert.doesNotMatch(html, /Required before confirm/);
});

test('P3/E1 pallet photos remain optional and stock plates are now optional', () => {
  assert.equal(ui({ photos: [] }).validateReturnForReview(), '');
  assert.equal(ui({ mode: 'stock', stock: true }).validateReturnForReview(), '');
  assert.equal(ui({ mode: 'stock', stock: true, plate: 'AB123' }).validateReturnForReview(), '');
});
