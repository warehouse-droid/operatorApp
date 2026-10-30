/* global window, document, getComputedStyle */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = process.argv[2] || '.';
const read = file => readFileSync(path.join(root, 'public', file), 'utf8');
const source = read('operator.js');
function extract(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const end = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, end < 0 ? undefined : start + 1 + end);
}
const functions = ['renderReturnQuantityStepper', 'renderReturnUnitInputs', 'renderReturnStockRow',
  'renderReturnStockLine', 'returnSelectedStockLine', 'renderReturnSelectedLineEditor',
  'returnLineEntryMode', 'returnLineUnits', 'returnLineSalesUom', 'returnLineRemaining',
  'ensureReturnLineValue', 'returnRowsForLine', 'returnLinePolicy', 'returnPolicyLabel', 'returnPolicyClass',
  'renderReturnStockLines', 'renderReturnPalletSection', 'renderReturnForm', 'renderReturnCustomerSummary', 'renderTopbar'];
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const [width, height] of [[320, 740], [390, 844], [768, 1024], [1024, 768], [1365, 800], [1440, 900]]) {
    for (const fontSizePx of [null, 8, 24]) {
      const metrics = {};
      for (const module of ['stock-return', 'stock-exchange']) {
        const page = await browser.newPage({ viewport: { width, height } });
        try {
          await page.setContent(`<style>${read('operator.css')}\n${read('operator-phone.css')}</style><main id="app" class="tablet-shell" data-module="${module}"></main>`);
          await page.evaluate(({ module, phone }) => {
            if (phone) document.documentElement.dataset.operatorPhone = 'true';
            const line = { sourceLineId: '42', entryMode: 'physical', toPlt: 98, toLyr: 20, toSec: 4, toPcs: 1,
              salesUom: 'SQFT', remainingReturnable: 1000, fulfilledQuantity: 1100, netsuiteReturned: 80,
              localReserved: 20, returnPolicy: { effective: 'ALLOWED' } };
            Object.assign(window, {
              currentModule: module, app: document.getElementById('app'), returnMode: 'stock', returnType: 'quality',
              returnBusy: false, returnActiveLineId: '42', returnLineValues: {}, returnPalletQuantity: 2,
              returnPalletPhotos: [], RETURN_MAX_PHOTOS: 3, RETURN_QUANTITY_EPSILON: .000001,
              returnLinePage: 0, RETURN_LINE_PAGE_SIZE: 12, fixture: line,
              returnReasons: { qualityReasons: [{ id: '5', label: 'R1 - Damaged' }] },
              t: (_key, fallback) => fallback, tf: (_key, fallback, values) => fallback.replace(/\{(\w+)\}/g, (_, key) => values[key]),
              escapeHtml: String, displayUnit: String, displayReturnQty: String,
              returnSourceLineId: item => item.sourceLineId, returnLines: () => Array.from({ length: 12 }, (_, i) => ({ ...line, sourceLineId: String(42 + i) })),
              returnLineName: () => 'Paving stone', returnLineDescription: () => 'Quality issue stock item',
              returnLineCalculatedSalesQty: (_line, values) => values.pieces || 0,
              returnLineHasQty: (_line, values) => values.pieces > 0,
              createReturnIdempotencyKey: () => 'quality-row', pageItems: items => items, pageCount: () => 1,
              currentPalletBalance: () => ({ available: 123 }), returnBalanceAvailable: balance => balance.available,
              returnYardGate: () => ({ blocked: false }), renderReturnYardBanner: () => '',
              returnCustomer: () => ({ address: 'Customer address' }), returnCustomerCode: () => 'C123', returnCustomerName: () => 'Example Customer',
              returnOrder: () => ({ orderingLocationName: '2967' }), returnOrderRef: () => 'SOB123456',
              returnLookupData: {}, currentLocation: () => ({ text: '3445' }), locationId: 1,
              returnModuleActive: () => true, returnStage: 'form', returnDraftId: '', locationDropdownOpen: false,
              allowedOperatorLocations: () => [{ id: 1, text: '3445' }], languageToggle: () => '<button>EN / 中文</button>',
              operator: {}, renderReleaseDraftButton: () => '', renderNotificationButton: () => ''
            });
          }, { module, phone: width < 768 });
          await page.addScriptTag({ content: functions.map(extract).join('\n') });
          await page.addScriptTag({ content: read('operator-display-settings.js') });
          await page.evaluate(fontSizePx => {
            if (fontSizePx !== null) {
              const settings = Object.fromEntries(['headings', 'itemNames', 'descriptions', 'labels', 'quantities'].map(role => [role, { fontSizePx }]));
              const style = document.createElement('style');
              style.textContent = window.OperatorDisplaySettings.styleCss(window.OperatorDisplaySettings.normalize({ styles: { general: settings, detail: settings } }));
              document.head.append(style);
            }
            const row = window.ensureReturnLineValue(window.fixture);
            Object.assign(row, { pieces: 2, reasonId: '5', photos: ['photo'] });
            window.app.innerHTML = window.renderTopbar(window.currentModule === 'stock-return' ? 'Stock Return' : 'Stock exchange', 'Test operator', '<button>Back</button><button>My Records</button>') + window.renderReturnForm();
          }, fontSizePx);
          const state = await page.evaluate(() => {
            const bounds = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width }; };
            const inputs = document.querySelector('.return-line-inputs');
            const fonts = [...document.querySelectorAll('.return-selected-editor span,.return-selected-editor strong,.return-selected-editor small,.return-selected-editor output,.return-line-card:first-child span,.return-line-card:first-child strong')].map(e => getComputedStyle(e).fontSize);
            const pallet = document.querySelector('.return-pallet-compact');
            const list = bounds(document.querySelector('.return-line-list'));
            return {
              columns: getComputedStyle(inputs).gridTemplateColumns.split(' ').length,
              units: [...inputs.children].map(bounds), fonts,
              horizontalOverflow: document.querySelector('.return-selected-editor').scrollWidth > document.querySelector('.return-selected-editor').clientWidth + 1,
              visibleCards: [...document.querySelectorAll('.return-line-card')].filter(card => { const r = bounds(card); return r.y >= list.y && r.bottom <= list.bottom + 1; }).length,
              measuresInline: [...document.querySelectorAll('.return-line-card:first-child .return-line-card-measures > span')]
                .every(cell => Math.abs(bounds(cell.querySelector('span')).y - bounds(cell.querySelector('b')).y) < 1),
              summary: [...document.querySelectorAll('.return-customer-summary > div')].map(cell => ({ ...bounds(cell), children: cell.children.length })),
              pallet: pallet ? { box: bounds(pallet), panel: bounds(pallet.closest('.return-stock-selector-panel')),
                children: [...pallet.querySelectorAll('*')].map(bounds), pagination: bounds(document.querySelector('.return-stock-selector-panel .pagination-row')) } : null
            };
          });
          const label = `${module} ${width}x${height} font=${fontSizePx}`;
          check(await page.locator('.return-calculated-qty').count() === 0, `${label}: calculated quantity panel remains`);
          check(state.columns === 2, `${label}: expected two input columns, got ${state.columns}`);
          check(state.fonts.every(px => parseFloat(px) >= 15), `${label}: text smaller than 15px`);
          check(!state.horizontalOverflow, `${label}: editor horizontal overflow`);
          if (width === 1365 && fontSizePx === null) {
            check(state.visibleCards >= 3, `${label}: expected three complete visible cards, got ${state.visibleCards}`);
            check(state.measuresInline, `${label}: remaining/returning labels and quantities must share one line`);
            check(state.summary.length === 4 && state.summary.every(cell => cell.children === 2 && cell.y === state.summary[0].y), `${label}: four summary blocks with two lines each`);
            check(Math.abs(state.summary[0].width / state.summary[1].width - 2) < .02
              && Math.abs(state.summary[1].width / state.summary[2].width - 2) < .02
              && Math.abs(state.summary[2].width / state.summary[3].width - 1) < .02, `${label}: summary must use 4:2:1:1 widths`);
          }
          if (state.pallet) {
            const { box, panel, children, pagination } = state.pallet;
            check(box.y >= pagination.bottom, `${label}: pallet card must stay below the stock list and pagination`);
            check(box.x >= panel.x && box.right <= panel.right + 1 && box.bottom <= panel.bottom + 1, `${label}: pallet card clipped by panel`);
            check(children.every(r => r.x >= box.x && r.right <= box.right + 1 && r.y >= box.y && r.bottom <= box.bottom + 1), `${label}: pallet card contents outside border`);
            if (width >= 768) check(box.bottom <= height - 15, `${label}: pallet card below viewport`);
          } else check(module === 'stock-exchange', `${label}: pallet card missing`);
          metrics[module] = state;
        } finally { await page.close(); }
      }
      check(JSON.stringify(metrics['stock-return'].fonts) === JSON.stringify(metrics['stock-exchange'].fonts), `${width}px font=${fontSizePx}: return/exchange fonts differ`);
      console.log(`Return/exchange layout checked: ${width}x${height}, font preference ${fontSizePx ?? 'default'}`);
    }
  }
} finally { await browser.close(); }
assert.deepEqual(failures, []);
console.log(JSON.stringify({ passed: true, browserCases: 36, widths: [320,390,768,1024,1365,1440], fontPreferences: ['default',8,24] }));
