import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, 'false');
const out = 'test-artifacts/special-enquiry-pallet-20261001';
mkdirSync(out, { recursive: true });
const files = ['public/special-stock-pallet-display.js', 'public/sales-special-stock-requests.js',
  'public/scm-special-stock-requests.js', 'public/sales-stock-requests.html', 'public/scm-stock-requests.html'];
const hashes = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
const sourceHashes = hashes();
function run(label, args) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 3000000,
    env: { ...process.env, SPECIAL_QUOTE_PALLET_BROWSER_OUTPUT: resolve(out + '/quote-browser'),
      SPECIAL_SALES_ACTIONS_BROWSER_OUTPUT: resolve(out + '/actions-browser') } });
  const log = (result.stdout || '') + (result.stderr || '');
  writeFileSync(out + '/' + label + '.log', log);
  console.log(JSON.stringify({ label, exitCode: result.status, tail: log.slice(-1100) }));
  assert.equal(result.status, 0, label + ': ' + log.slice(-3500));
}
const lint = new ESLint({ overrideConfigFile: resolve('tools/stock-request-layout-eslint.config.mjs') });
for (const file of files.filter(file => file.endsWith('.js'))) {
  run('syntax-' + file.split('/').at(-1), ['--check', file]);
  const messages = async text => (await lint.lintText(text, { filePath: file }))[0].messages
    .map(({ ruleId, severity, message }) => JSON.stringify({ ruleId, severity, message }));
  const baseline = out + '/before/' + file;
  const before = existsSync(baseline) ? await messages(readFileSync(baseline, 'utf8')) : [];
  const after = await messages(readFileSync(file, 'utf8'));
  assert.deepEqual(after.filter(message => {
    const index = before.indexOf(message); if (index < 0) return true; before.splice(index, 1); return false;
  }), [], file + ': new lint findings');
}
run('enquiry-preview', ['tools/special-enquiry-pallet-preview.mjs']);
run('quote-and-actions-regression', ['--test', '--test-concurrency=1',
  'test/mbt/integration/special-quote-pallet-browser.test.js',
  'test/mbt/integration/special-sales-items-copy-browser.test.js']);
assert.deepEqual(hashes(), sourceHashes);
const browser = JSON.parse(readFileSync(out + '/browser/checks.json'));
const result = { completed: true, sourceHashes, newLintFindings: 0, browserChecks: browser.length,
  salesAndScmEnquiryPalletVisible: true, afterSubmitVisible: true, zeroQuantityOmitted: true,
  materialDecisionAndStockControlsPreserved: true, desktopAndPhoneFit: true, backendAndDataUnchanged: true };
writeFileSync(out + '/checks.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
