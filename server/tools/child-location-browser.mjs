import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
const source = readFileSync('public/operator.js','utf8');
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  const end = source.indexOf('\n}',start);
  return source.slice(start,end + 2);
}
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await page.setContent('<main id="result"></main>');
  await page.addScriptTag({ content: ['escapeHtml','operatorNetSuitePostingTransactions','renderOperatorNetSuitePostingTransactions'].map(extract).join('\n') });
  const transactions = [
    { transactionType: 'IF',transactionRef: 'IF-MAIN',sourceOrderKind: 'SO',sourceOrderRef: 'SOB120598',inventoryLocationNames: ['3445'] },
    { transactionType: 'IF',transactionRef: 'IF-CHILD',sourceOrderKind: 'SO',sourceOrderRef: 'SOB120598',inventoryLocationNames: ['3445 : 3445 Special'] }
  ];
  await page.evaluate(items => { document.querySelector('#result').innerHTML = window.renderOperatorNetSuitePostingTransactions({ operatorNetSuitePosting: { transactions: items } }); },transactions);
  assert.equal(await page.locator('strong').count(),2);
  assert.match(await page.locator('#result').innerText(),/IF-MAIN/);
  assert.match(await page.locator('#result').innerText(),/IF-CHILD/);
  assert.match(await page.locator('#result').innerText(),/3445 : 3445 Special/);
  await page.screenshot({ path: 'test-artifacts/child-locations/browser/fulfillment-parts.png' });
  await page.evaluate(() => {
    document.querySelector('#result').innerHTML = window.renderOperatorNetSuitePostingTransactions({ operatorNetSuitePosting: { transactions: [{ transactionRef: '<script>window.injected=true</script>',inventoryLocationNames: ['<img src=x onerror="window.injected=true">'] }] } });
  });
  assert.equal(await page.locator('#result script,#result img').count(),0);
  assert.equal(await page.evaluate(() => window.injected),undefined);
  writeFileSync('test-artifacts/child-locations/browser/fulfillment-parts.json',JSON.stringify({ passed: true, allReferencesAndLocationsVisible: true, remoteValuesEscaped: true }));
  console.log('PASS: all IF references and actual locations render safely in the Operator result.');
} finally { await browser.close(); }
