/* global window, document, getComputedStyle */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const readPublic = file => readFileSync(path.join(process.argv[2] || '.', 'public', file), 'utf8');
const source = readPublic('operator.js');
function extract(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const end = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, end < 0 ? undefined : start + 1 + end);
}
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const results = [];
try {
  for (const width of [390, 1024]) {
    for (const smallPreferences of [false, true]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      await page.setContent(`<style>${readPublic('operator.css')}\n${readPublic('operator-phone.css')}</style>
        <main id="app" data-module="stock-return" class="tablet-shell"></main><div id="toast" class="toast" role="alert"></div>`);
      await page.evaluate(phone => {
        if (phone) { document.documentElement.dataset.operatorPhone = 'true'; }
        Object.assign(window, {
          returnMode: 'stock', returnType: 'normal', returnBusy: false, returnPalletQuantity: 0,
          returnVehiclePlate: '', returnHeaderNote: '', returnRecordPhotos: [], returnValidationMessage: '',
          returnStage: 'review', RETURN_QUANTITY_EPSILON: .000001, requests: [],
          returnPostingLoading: false, returnPostingError: '',
          returnPostingFunctions: () => ['stock_return'],
          returnPostingPolicies: { stock_return: { effective: true, transactionType: 'CM' } },
          values: { clientRowKey: 'row1', salesQuantity: 2, reasonId: 5, photos: [] },
          t: (_key, fallback) => fallback, tf: (_key, fallback) => fallback, escapeHtml: String, localizeMessage: String,
          returnCustomerId: () => 30, returnOrderId: () => 40, returnOrderRef: () => 'SOB00040',
          returnCustomerName: () => 'Customer', returnYardGate: () => ({ blocked: false }), returnBalanceAvailable: () => 0,
          returnPostingReady: () => true, returnSelectedRows: () => [{ line: {}, values: window.values }],
          returnLines: () => [{}], returnRowsForLine: () => [window.values], returnLineCalculatedSalesQty: () => 2,
          returnLineRemaining: () => 10, returnLineHasQty: () => true, returnLinePolicy: () => ({ effective: 'ALLOWED' }),
          returnLineEntryMode: () => 'sales_uom', returnLineName: () => 'Custom stock', returnLineSalesUom: () => 'PCS',
          displayReturnQty: String, renderReturnPhotoWorkspace: () => '<div>Camera evidence</div>',
          renderReturnPalletReviewLine: () => '', renderReturnCustomerSummary: () => '',
          renderReturnYardBanner: () => '', renderReturnReviewLine: () => 'Custom stock',
          api: (...args) => { window.requests.push(args); throw new Error('Blocked confirmation reached API'); },
          toast: document.getElementById('toast')
        });
      }, width === 390);
      await page.addScriptTag({ content: readPublic('operator-display-settings.js') });
      await page.addScriptTag({ content: ['renderReturnQuantityStepper', 'renderReturnUnitInputs', 'renderReturnReview',
        'renderReturnPostingPolicies', 'validateReturnForReview', 'submitReturn', 'showToast'].map(extract).join('\n') });
      await page.evaluate(small => {
        if (small) {
          const settings = window.OperatorDisplaySettings.normalize({ styles: { general: {
            labels: { fontSizePx: 8 }, quantities: { fontSizePx: 8 }
          }, detail: { labels: { fontSizePx: 8 }, quantities: { fontSizePx: 8 } } } });
          const style = document.createElement('style');
          style.textContent = window.OperatorDisplaySettings.styleCss(settings);
          document.head.append(style);
        }
        window.render = () => {
          document.getElementById('app').innerHTML = '<div class="detail-panel">'
            + window.renderReturnUnitInputs({}, window.values) + '</div>' + window.renderReturnReview();
        };
        document.getElementById('app').addEventListener('click', event => {
          if (event.target.closest('[data-action="return-confirm-submit"]')) { void window.submitReturn(); }
        });
        window.render();
      }, smallPreferences);
      const fonts = await page.locator('.return-unit-field>span,.return-unit-field output,label.return-field>span')
        .evaluateAll(elements => elements.map(element => ({ text: element.textContent, px: parseFloat(getComputedStyle(element).fontSize) })));
      assert.ok(fonts.length >= 4);
      assert.ok(fonts.every(font => font.px >= 15), JSON.stringify({ width, smallPreferences, fonts }));
      assert.match(await page.locator('.return-review-entry-fields label').first().innerText(), /Optional/);
      const submit = page.locator('[data-action="return-confirm-submit"]');
      assert.equal(await submit.getAttribute('aria-disabled'), 'true');
      // An aria-disabled control keeps the explanatory click while submitReturn
      // enforces the evidence rule before any upload or request.
      await submit.click({ force: true });
      await page.locator('#toast.show').waitFor();
      assert.match(await page.locator('#toast').innerText(), /photo/i);
      assert.equal(await page.evaluate(() => window.requests.length), 0);
      assert.equal(await page.locator('.return-review-screen .sync-alert').count(), 0);
      await page.evaluate(() => { window.returnRecordPhotos = ['photo']; window.render(); });
      assert.equal(await submit.getAttribute('aria-disabled'), 'false');
      await page.evaluate(() => { window.returnType = 'quality'; window.render(); });
      assert.equal(await submit.getAttribute('aria-disabled'), 'true');
      await submit.click({ force: true });
      assert.match(await page.locator('#toast').innerText(), /quality photo/i);
      assert.equal(await page.locator('.return-review-screen .sync-alert').count(), 0);
      await page.evaluate(() => { window.returnPostingError = 'Posting mode unavailable'; window.render(); });
      assert.equal(await page.locator('.return-review-screen .sync-alert').count(), 0);
      assert.equal(await page.locator('[data-action="return-refresh-posting"]').count(), 1);
      assert.match(await page.locator('.return-posting-message').innerText(), /Posting mode unavailable/);
      results.push({ width, smallPreferences, minimumFontPx: Math.min(...fonts.map(font => font.px)), passed: true });
      await page.close();
    }
  }
  console.log(JSON.stringify({ browser: 'chromium', cases: results }, null, 2));
} finally { await browser.close(); }
