/* global window, document */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { MBT_ADMIN_GATE_DEFINITIONS } from '../../src/mbt/feature-gate-catalog.js';
const out = 'test-artifacts/return-credit-memo-20261008';
const source = readFileSync('public/operator.js', 'utf8');
function extract(text, name) {
  const start = text.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = text.slice(start + 1).search(/\n(?:async )?function /);
  return text.slice(start, tail < 0 ? undefined : start + 1 + tail);
}
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const results = [];
const coverage = [];
async function addFunctions(page, text, names, file) {
  // Preserve original character offsets, so V8 coverage maps to real lines.
  const padded = text.replace(/[^\n\r]/g, ' ').split('');
  for (const name of names) {
    const body = extract(text, name);
    const start = text.indexOf(body);
    for (let index = 0; index < body.length; index++) { padded[start + index] = body[index]; }
  }
  await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });
  await page.addScriptTag({ content: padded.join('') + `\n//# sourceURL=http://return-cm.test/${file}` });
}
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.setContent(`<style>${readFileSync('public/operator.css', 'utf8')}</style><main id="app"></main>`);
    await page.evaluate(() => {
      Object.assign(window, { returnMode: 'stock', returnPalletQuantity: 2, locationId: 1,
        returnPostingLoading: false, returnPostingError: '', returnPostingGeneration: 0,
        returnPostingPolicies: { stock_return: { effective: true, transactionType: 'CM', locationId: 1, gateKey: 'stock_cm', revision: 1 },
          pallet_return: { effective: true, transactionType: 'CM', locationId: 1, gateKey: 'pallet_cm', revision: 1 } },
        returnSelectedRows: () => [{}], escapeHtml: value => String(value ?? ''),
        t: (_, fallback) => fallback, localizeMessage: value => value,
        returnResult: { batchReference: 'RB-000001', stockReturn: { workflowVersion: 3, reference: 'SR-000001',
          netSuiteStage: 'credit_memo', netSuiteSyncStatus: 'succeeded', netSuiteTransactionRef: 'CM000123' },
          palletReturn: { workflowVersion: 3, reference: 'PR-000001', netSuiteStage: 'credit_memo',
            netSuiteSyncStatus: 'succeeded', netSuiteTransactionRef: 'CM000123' } } });
    });
    await addFunctions(page, source, ['operatorNetSuitePolicyToken', 'returnPostingFunctions', 'returnPostingReady',
      'renderReturnPostingPolicies', 'returnNetSuiteResultLabel', 'renderReturnSuccess'], 'public/operator.js');
    await page.evaluate(() => { document.getElementById('app').innerHTML = window.renderReturnPostingPolicies(); });
    assert.match(await page.locator('#app').innerText(), /Creates one Credit Memo directly/);
    await page.screenshot({ path: `${out}/review-${width}.png` });
    await page.evaluate(() => { document.getElementById('app').innerHTML = window.renderReturnSuccess(); });
    assert.equal(await page.locator('.sync-alert strong').innerText(), 'CM000123');
    assert.equal(await page.locator('.return-created-records em').filter({ hasText: 'NetSuite Credit Memo CM000123' }).count(), 2);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Return result fits viewport');
    await page.screenshot({ path: `${out}/success-${width}.png` });
    await page.evaluate(() => {
      for (const status of ['pending', 'failed', 'cancelled']) {
        const label = window.returnNetSuiteResultLabel({ workflowVersion: 3, netSuiteStage: 'credit_memo', netSuiteSyncStatus: status });
        if (!label.includes('Credit Memo')) { throw new Error('Incorrect Credit Memo status'); }
      }
      window.returnPostingPolicies.pallet_return.transactionType = 'RA';
      if (!window.renderReturnPostingPolicies().includes('posting modes differ')) { throw new Error('Missing incompatible mode warning'); }
    });
    coverage.push(...await page.coverage.stopJSCoverage());
    results.push({ width, creditMemoReviewAndSuccess: true });
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.setContent(`<style>${readFileSync('public/mbt-shell.css', 'utf8')}</style><div class="mbt-operator-gate-matrix" id="matrix"></div>`);
  await page.evaluate(gates => Object.assign(window, { saving: false,
    inventory: { gates, netSuiteDirectAccessAllowed: true }, operatorNetSuiteGateMatrix: document.getElementById('matrix') }),
  MBT_ADMIN_GATE_DEFINITIONS.filter(gate => gate.gateGroup === 'operator_netsuite_posting')
    .map(gate => ({ ...gate, configured: false, effective: false, environmentAllowed: true, revision: 1 })));
  const gateSource = readFileSync('public/mbt-gates.js', 'utf8');
  await addFunctions(page, gateSource, ['operatorGateCell', 'renderOperatorNetSuiteGateMatrix'], 'public/mbt-gates.js');
  await page.evaluate(() => window.renderOperatorNetSuiteGateMatrix());
  assert.equal(await page.locator('button[data-gate-toggle]').count(), 28);
  assert.equal(await page.locator('button[data-gate-toggle*="_return_cm_"]').count(), 8);
  assert.equal(await page.locator('button[data-gate-toggle*="_return_ra_"]').count(), 8);
  assert.match(await page.locator('#matrix').innerText(), /CM creates a Credit Memo directly and takes priority over RA/);
  await page.screenshot({ path: `${out}/gates.png` });
  coverage.push(...await page.coverage.stopJSCoverage());
  results.push({ adminCreditMemoGates: 8, legacyGates: 20 });
  await page.close();
  for (const [file, names] of [['control', ['returnStatus', 'returnStatusLabel']], ['sales', ['salesReturnStatus', 'salesReturnStatusLabel']]]) {
    const statusPage = await browser.newPage();
    await statusPage.setContent('<main></main>');
    await statusPage.evaluate(() => {
      const first = (record, keys, fallback) => keys.map(key => record[key]).find(value => value !== undefined) ?? fallback;
      Object.assign(window, { firstDefined: first, salesFirst: first, returnType: () => 'stock', salesReturnType: () => 'stock' });
    });
    await addFunctions(statusPage, readFileSync(`public/${file}.js`, 'utf8'), names, `public/${file}.js`);
    for (const status of ['pending', 'succeeded', 'failed']) {
      const label = await statusPage.evaluate(({ name, state }) => window[name]({ workflowVersion: 3, netSuiteStage: 'credit_memo', netSuiteSyncStatus: state }), { name: names[1], state: status });
      assert.match(label, /Credit Memo/);
    }
    coverage.push(...await statusPage.coverage.stopJSCoverage());
    await statusPage.close();
  }
} finally { await browser.close(); }
writeFileSync(out + '/browser.json', JSON.stringify(results, null, 2));
writeFileSync(out + '/browser-v8.json', JSON.stringify(coverage));
console.log(JSON.stringify(results));
