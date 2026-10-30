/* global window, document, getComputedStyle, requestAnimationFrame */
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
const functions = ['renderReturnQuantityStepper', 'renderReturnUnitInputs', 'renderReturnStockRow',
  'renderReturnStockLine', 'returnSelectedStockLine', 'renderReturnSelectedLineEditor',
  'returnLineEntryMode', 'returnLineUnits', 'returnLineSalesUom', 'returnLineRemaining',
  'ensureReturnLineValue', 'returnRowsForLine', 'addReturnSplitRow',
  'returnLinePolicy', 'returnPolicyLabel', 'returnPolicyClass'];
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const results = [];
try {
  for (const width of [320, 390, 768, 1024, 1440]) {
    for (const entryMode of ['physical', 'sales_uom']) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      try {
        await page.setContent(`<style>${readPublic('operator.css')}\n${readPublic('operator-phone.css')}</style>
          <main id="app" data-module="stock-return" class="tablet-shell"></main>`);
        await page.evaluate(({ phone, entryMode }) => {
          if (phone) document.documentElement.dataset.operatorPhone = 'true';
          Object.assign(window, {
            app: document.getElementById('app'), returnType: 'quality', returnMode: 'stock',
            returnActiveLineId: '42', returnLineValues: {}, returnDirty: false, sequence: 0,
            RETURN_QUANTITY_EPSILON: 0.000001,
            fixture: { sourceLineId: '42', entryMode, toPlt: 98, toLyr: 20, toSec: 4, toPcs: 1,
              salesUom: 'SQFT', remainingReturnable: 1000, fulfilledQuantity: 1100, netsuiteReturned: 80, localReserved: 20,
              returnPolicy: { effective: 'ALLOWED' } },
            returnReasons: { qualityReasons: [{ id: '5', label: 'R1 - Damaged' }], normalReason: { label: 'GD - Good Condition' } },
            t: (_key, fallback) => fallback,
            tf: (_key, fallback, values) => fallback.replace(/\{(\w+)\}/g, (_, key) => values[key]),
            escapeHtml: String, displayUnit: String, displayReturnQty: String,
            returnSourceLineId: line => line.sourceLineId,
            returnLines: () => [window.fixture], returnLineName: () => 'Paving stone',
            returnLineDescription: () => 'Test stock description',
            returnLineCalculatedSalesQty: (_line, values) => values.salesQuantity || values.pieces || 0,
            returnLineHasQty: (_line, values) => (values.salesQuantity || values.pieces || 0) > 0,
            createReturnIdempotencyKey: () => `new-row-${++window.sequence}`
          });
        }, { phone: width < 768, entryMode });
        await page.addScriptTag({ content: functions.map(extract).join('\n') });
        await page.addScriptTag({ content: readPublic('operator-display-settings.js') });
        await page.evaluate(() => {
          for (const key of ['original-1', 'original-2', 'original-3']) {
            const row = window.ensureReturnLineValue(window.fixture, key);
            Object.assign(row, { pieces: 2, salesQuantity: 2, reasonId: '5', note: 'Retained saved note', photos: ['evidence'] });
          }
          window.render = () => {
            window.app.innerHTML = '<header class="topbar"><h1>Stock Return</h1></header>'
              + '<section class="return-form-shell stock-return-form"><div class="return-form-grid return-quantity-grid">'
              + '<section class="return-stock-selector-panel"><div class="return-line-list">'
              + Array.from({ length: 12 }, () => window.renderReturnStockLine(window.fixture)).join('')
              + '</div></section>' + window.renderReturnSelectedLineEditor() + '</div></section>';
          };
          window.app.addEventListener('click', event => {
            const button = event.target.closest('[data-action="return-add-split-row"]');
            if (button) window.addReturnSplitRow(button.dataset.sourceLine);
          });
          window.render();
        });

        const cardText = await page.locator('.return-line-card').first().innerText();
        assert.doesNotMatch(cardText, /Fulfilled|Source line|Short note|NetSuite returned|Local reserved|photos|reason row/i);
        assert.match(cardText, /Remaining/);
        assert.match(cardText, /Returning/);
        assert.equal(await page.locator('.return-line-entry-row [data-return-line-input="note"]').count(), 0);
        assert.equal(await page.locator('.return-line-entry-row select').count(), 3);
        const balances = await page.locator('.return-stock-balance-grid > div').evaluateAll(elements => elements.map(element => {
          const box = element.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width };
        }));
        assert.equal(balances.length, 4);
        assert.ok(Math.abs(balances[0].y - balances[1].y) < 1, JSON.stringify({ width, balances }));
        assert.ok(Math.abs(balances[2].y - balances[3].y) < 1);
        assert.ok(balances[2].y > balances[0].y && balances[1].x > balances[0].x);
        const unitRows = await page.locator('.return-unit-field').evaluateAll(elements => elements.map(element => {
          const bounds = selector => {
            const child = selector ? element.querySelector(selector) : element;
            if (!child) return null;
            const box = child.getBoundingClientRect();
            return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, centerY: box.y + box.height / 2 };
          };
          return {
            overflow: element.scrollWidth > element.clientWidth + 1,
            field: bounds(), label: bounds('span'), conversion: bounds('small'), stepper: bounds('.return-quantity-stepper'),
            fonts: [...element.querySelectorAll('span,small,output')].map(child => parseFloat(getComputedStyle(child).fontSize))
          };
        }));
        for (const row of unitRows) {
          assert.equal(row.overflow, false, JSON.stringify({ width, entryMode, row }));
          assert.ok(row.fonts.every(px => px >= 15));
          assert.ok(row.stepper.y >= row.label.bottom, JSON.stringify({ width, row }));
          assert.ok(Math.abs(row.stepper.width - row.field.width) < 1);
          if (row.conversion) {
            assert.ok(Math.abs(row.label.centerY - row.conversion.centerY) < 1, JSON.stringify({ width, row }));
            assert.ok(row.conversion.x >= row.label.right);
            assert.ok(row.stepper.y >= row.conversion.bottom);
          }
        }
        if (entryMode === 'physical') {
          for (let i = 0; i < unitRows.length; i += 2) {
            assert.ok(Math.abs(unitRows[i].field.y - unitRows[i + 1].field.y) < 1);
            assert.ok(unitRows[i + 1].field.x > unitRows[i].field.right);
          }
          assert.ok(unitRows[2].field.y > unitRows[0].field.y);
          assert.match(await page.locator('.return-unit-field').first().innerText(), /PLT\s*× 98 SQFT/);
        }
        const scroll = () => page.evaluate(() => ({
          app: window.app.scrollTop,
          editor: document.querySelector('.return-selected-editor').scrollTop,
          list: document.querySelector('.return-line-list').scrollTop,
          page: window.scrollY
        }));
        for (let addition = 1; addition <= 2; addition++) {
          const add = page.locator('[data-action="return-add-split-row"]');
          await add.scrollIntoViewIfNeeded();
          await page.locator('.return-line-list').evaluate(element => { element.scrollTop = 90; });
          const before = await scroll();
          assert.ok(before.app > 0 || before.editor > 0, JSON.stringify({ width, before }));
          await add.click();
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const after = await scroll();
          for (const key of Object.keys(before)) {
            assert.ok(Math.abs(after[key] - before[key]) <= 1, JSON.stringify({ width, entryMode, before, after }));
          }
          assert.equal(await page.locator('[data-return-row]').count(), 3 + addition);
        }
        const original = await page.evaluate(() => window.returnLineValues['original-1']);
        assert.equal(original.note, 'Retained saved note');
        assert.equal(original.reasonId, '5');
        assert.deepEqual(original.photos, ['evidence']);
        assert.equal(original.salesQuantity, 2);
        await page.evaluate(() => { window.returnType = 'normal'; window.render(); });
        assert.equal(await page.locator('[data-action="return-add-split-row"]').count(), 0);
        for (const fontSizePx of [16, 24, 48]) {
          for (const policy of ['ALLOWED', 'NOT_RETURNABLE']) {
            await page.evaluate(({ fontSizePx, policy }) => {
              window.fixture.returnPolicy.effective = policy;
              window.fixture.remainingReturnable = 123456.123456;
              for (const row of Object.values(window.returnLineValues)) row.salesQuantity = 9876.123456;
              const style = document.getElementById('card-preferences') || document.head.appendChild(document.createElement('style'));
              style.id = 'card-preferences';
              style.textContent = window.OperatorDisplaySettings.styleCss(window.OperatorDisplaySettings.normalize({
                styles: { general: { quantities: { fontSizePx } } }
              }));
              window.render();
            }, { fontSizePx, policy });
            const boxes = await page.locator('.return-line-card').first().evaluate(card => {
              const bounds = element => {
                const rect = element.getBoundingClientRect();
                return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
              };
              return {
                card: bounds(card), overflow: card.scrollWidth > card.clientWidth + 1,
                children: [...card.querySelectorAll('.return-line-state,.return-policy-pill,.return-line-card-measures,.return-line-card-measures *')]
                  .map(element => ({ bounds: bounds(element), overflow: element.scrollWidth > element.clientWidth + 1 })),
                identity: bounds(card.querySelector('.return-line-identity')), state: bounds(card.querySelector('.return-line-state')),
                measures: bounds(card.querySelector('.return-line-card-measures'))
              };
            });
            assert.equal(boxes.overflow, false, JSON.stringify({ width, fontSizePx, policy, boxes }));
            for (const child of boxes.children) {
              assert.equal(child.overflow, false, JSON.stringify({ width, fontSizePx, policy, child }));
              assert.ok(child.bounds.left >= boxes.card.left && child.bounds.right <= boxes.card.right + 1,
                JSON.stringify({ width, fontSizePx, policy, boxes }));
              assert.ok(child.bounds.top >= boxes.card.top && child.bounds.bottom <= boxes.card.bottom + 1,
                JSON.stringify({ width, fontSizePx, policy, boxes, child }));
            }
            assert.ok(boxes.state.left >= boxes.identity.right);
            assert.ok(boxes.measures.top >= Math.max(boxes.identity.bottom, boxes.state.bottom));
            assert.equal(await page.locator('.return-line-card').first().locator('.return-policy-pill').innerText(),
              policy === 'ALLOWED' ? 'Allowed' : 'Not Returnable');
          }
        }
        results.push({ width, entryMode, additions: 2, passed: true });
      } finally { await page.close(); }
    }
  }
  console.log(JSON.stringify({ browser: 'chromium', cases: results }, null, 2));
} finally { await browser.close(); }
