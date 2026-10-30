import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('public/operator.js', 'utf8');
function extract(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const end = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, end < 0 ? undefined : start + end + 1);
}
function ui({ photos = [], quality = false } = {}) {
  const page = vm.createContext({
    returnBusy: false, returnMode: 'stock', returnType: quality ? 'quality' : 'normal',
    returnVehiclePlate: '', returnPalletQuantity: 0, returnRecordPhotos: photos, returnValidationMessage: '', returnHeaderNote: '',
    RETURN_QUANTITY_EPSILON: .000001, returnStage: 'review',
    t: (_key, fallback) => fallback, tf: (_key, fallback) => fallback, escapeHtml: String,
    returnCustomerId: () => 12, returnOrderId: () => 34, returnYardGate: () => ({ blocked: false }),
    returnBalanceAvailable: () => 0,
    returnSelectedRows: () => [{ line: {}, values: { photos } }], returnLines: () => [{}],
    returnRowsForLine: () => [{ photos, reasonId: quality ? 5 : 10 }],
    returnLineCalculatedSalesQty: () => 1, returnLineRemaining: () => 10, returnLineHasQty: () => true,
    returnLinePolicy: () => ({ effective: 'ALLOWED' }), returnLineEntryMode: () => 'sales_uom',
    returnLineName: () => 'Test stock',
    returnOrderRef: () => 'SOB00034', returnCustomerName: () => 'Customer', renderReturnPhotoWorkspace: () => '',
    renderReturnPalletReviewLine: () => '', renderReturnPostingPolicies: () => '', renderReturnCustomerSummary: () => '',
    renderReturnYardBanner: () => '', renderReturnReviewLine: () => 'Stock', returnPostingReady: () => true,
    calls: [], render: () => {}, showToast: message => page.calls.push(message),
    api: () => assert.fail('A blocked confirmation reached the server')
  });
  for (const name of ['validateReturnForReview', 'renderReturnReview', 'submitReturn']) {
    vm.runInContext(extract(name), page);
  }
  return page;
}

test('E1 stock review labels the plate optional and accepts blank plates', () => {
  const page = ui({ photos: ['photo'] });
  assert.equal(page.validateReturnForReview(), '');
  assert.match(page.renderReturnReview(), /Vehicle plate[^<]*Optional/);
});

for (const quality of [false, true]) {
  test(`E3 ${quality ? 'quality' : 'good condition'} photo-less confirmation is blocked and shows a floating photo reminder`, async () => {
    const page = ui({ quality });
    assert.match(page.renderReturnReview(), /data-action="return-confirm-submit"[^>]*aria-disabled="true"/);
    await page.submitReturn();
    assert.equal(page.calls.length, 1);
    assert.match(page.calls[0], /photo/i);
  });
}
