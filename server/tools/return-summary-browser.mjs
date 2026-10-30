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
const functions = ['escapeHtml', 'returnOrder', 'returnCustomer', 'returnCustomerId', 'returnOrderId',
  'returnCustomerCode', 'returnCustomerName', 'returnOrderRef', 'returnYardName', 'returnYardGate',
  'returnModuleActive', 'renderReturnYardBanner', 'renderReturnCustomerSummary', 'returnInlineWarning',
  'refreshReturnWarning', 'dismissReturnWarning', 'validateReturnForReview'];
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const results = [];
try {
  for (const width of [390, 1024]) {
    for (const mode of ['stock', 'pallet']) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      try {
        await page.setContent(`<style>${readPublic('operator.css')}\n${readPublic('operator-phone.css')}</style>
          <main id="app" data-module="${mode}-return" class="tablet-shell"></main>`);
        await page.evaluate(({ width, mode }) => {
          if (width < 768) document.documentElement.dataset.operatorPhone = 'true';
          Object.assign(window, {
            app: document.getElementById('app'), currentModule: `${mode}-return`, returnMode: mode,
            returnView: 'workflow', returnStage: 'form', returnLookupMessage: '', returnValidationMessage: '',
            returnDismissedInlineWarning: '', returnSelectedCustomer: null, returnLookupCode: 'SOB123456',
            returnLookupData: { defaultReturnLocationName: '2967', defaultReturnLocation: { yardCode: '2967' },
              order: { id: 123, tranid: 'SOB123456', orderingLocationName: '2967',
                customer: { id: 456, code: 'C456', name: 'Test customer', address: 'Customer address' } } },
            locationId: 1, currentLocation: () => ({ text: '3445' }),
            t: (_key, fallback) => fallback,
            tf: (_key, fallback, values) => fallback.replace(/\{(\w+)\}/g, (_, key) => values[key]),
            localizeMessage: String
          });
        }, { width, mode });
        await page.addScriptTag({ content: functions.map(extract).join('\n') });
        await page.evaluate(() => {
          window.render = () => {
            window.app.innerHTML = window.renderReturnCustomerSummary() + window.renderReturnYardBanner()
              + '<section id="error-sources"></section>';
            window.refreshReturnWarning();
          };
          window.app.addEventListener('click', event => {
            if (event.target.closest('[data-action="dismiss-return-message"]')) window.dismissReturnWarning();
          });
          window.render();
        });
        assert.equal(await page.locator('.return-yard-banner').count(), 0);
        assert.equal(await page.locator('.return-customer-summary > div').count(), 4);
        assert.equal(await page.locator('.return-ordering-yard > span').innerText(), 'ORDERING YARD');
        assert.equal(await page.locator('.return-ordering-yard > strong').innerText(), '2967');
        assert.equal(await page.locator('.return-customer-summary > div').nth(1).locator('em').count(), 0);
        assert.equal(await page.locator('.return-customer-summary > div').nth(2).locator('em').count(), 0);
        assert.equal(await page.locator('.return-customer-summary > div').nth(3).locator('strong').innerText(), '3445');
        assert.equal(await page.locator('.return-customer-summary em').count(), 0);
        assert.deepEqual(await page.locator('.return-customer-summary > div').evaluateAll(cells => cells.map(cell => cell.children.length)), [2,2,2,2]);

        for (const stage of ['lookup', 'form', 'review']) {
          await page.evaluate(stage => {
            window.returnStage = stage;
            window.returnValidationMessage = 'Cannot submit <img src=x onerror=alert(1)>: add a required photo.';
            window.refreshReturnWarning();
          }, stage);
          const popup = page.locator('#returnWorkflowMessage');
          await popup.waitFor({ state: 'visible' });
          assert.equal(await popup.evaluate(element => getComputedStyle(element).position), 'fixed');
          assert.equal(await popup.locator('img').count(), 0);
          assert.match(await popup.innerText(), /Cannot submit <img/);
          const rect = await popup.boundingBox();
          assert.ok(rect.x >= 0 && rect.x + rect.width <= width);
          await popup.getByRole('button', { name: 'Dismiss' }).click();
          assert.equal(await popup.count(), 0);
          await page.evaluate(() => window.refreshReturnWarning());
          assert.equal(await popup.count(), 0);
        }

        await page.evaluate(() => {
          window.returnStage = 'form';
          document.getElementById('error-sources').innerHTML = '<div class="sync-alert danger" data-return-line-over><strong>Quantity exceeds remaining returnable</strong><span data-return-line-over-value>12 / 10 SQFT</span></div>';
          window.refreshReturnWarning();
        });
        assert.equal(await page.locator('.sync-alert.danger:visible').count(), 1);
        assert.equal(await page.locator('[data-return-line-over]').isVisible(), false);
        await page.locator('#returnWorkflowMessage button').click();
        await page.evaluate(() => window.refreshReturnWarning());
        assert.equal(await page.locator('#returnWorkflowMessage').count(), 0, 'Dismissed inline errors stay dismissed while unchanged');
        await page.evaluate(() => {
          document.querySelector('[data-return-line-over-value]').textContent = '13 / 10 SQFT';
          window.refreshReturnWarning();
        });
        assert.match(await page.locator('#returnWorkflowMessage').innerText(), /13 \/ 10/);
        await page.evaluate(() => {
          document.querySelector('[data-return-line-over]').hidden = true;
          window.refreshReturnWarning();
        });
        assert.equal(await page.locator('#returnWorkflowMessage').count(), 0);

        if (mode === 'stock') {
          await page.evaluate(() => { window.returnLookupData.crossYardBlocked = true; window.render(); });
          assert.match(await page.locator('#returnWorkflowMessage').innerText(), /processed at 2967/);
          await page.locator('#returnWorkflowMessage button').click();
          assert.equal(await page.locator('#returnWorkflowMessage').count(), 0);
          assert.match(await page.evaluate(() => window.validateReturnForReview()), /processed at 2967/);
        }
        await page.evaluate(() => { window.returnStage = 'success'; window.returnValidationMessage = 'Old error'; window.refreshReturnWarning(); });
        assert.equal(await page.locator('#returnWorkflowMessage').count(), 0);
        results.push({ width, mode, floatingErrorStages: 3, passed: true });
      } finally { await page.close(); }
    }
  }
  console.log(JSON.stringify({ browser: 'chromium', summaryAndErrorCases: results }, null, 2));
} finally { await browser.close(); }
