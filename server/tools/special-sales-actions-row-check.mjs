import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, 'false');
const out = resolve('test-artifacts/special-sales-actions-row-20261001');
mkdirSync(out + '/browser', { recursive: true });
const files = ['public/sales-special-stock-requests.js', 'public/special-stock-request-actions.css',
  'public/sales-stock-requests.html'];
const hashes = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
const sourceHashes = hashes();
function run(label, args) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 3000000,
    env: { ...process.env, SPECIAL_SALES_ACTIONS_BROWSER_OUTPUT: out + '/browser' } });
  const log = (result.stdout || '') + (result.stderr || '');
  writeFileSync(out + '/' + label + '.log', log);
  console.log(JSON.stringify({ label, exitCode: result.status, tail: log.slice(-1400) }));
  assert.equal(result.status, 0, label + ': ' + log.slice(-4500));
  return Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key =>
    [key, Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)]));
}
const lint = new ESLint({ overrideConfigFile: resolve('tools/stock-request-layout-eslint.config.mjs') });
const file = files[0];
run('syntax', ['--check', file]);
const messages = async text => (await lint.lintText(text, { filePath: file }))[0].messages
  .map(({ ruleId, severity, message }) => JSON.stringify({ ruleId, severity, message }));
const before = await messages(readFileSync(out + '/before/' + file, 'utf8'));
const after = await messages(readFileSync(file, 'utf8'));
assert.deepEqual(after.filter(message => {
  const index = before.indexOf(message);
  if (index < 0) return true;
  before.splice(index, 1);
  return false;
}), [], 'new client lint findings');
const unit = run('item-copy-unit', ['--test', 'test/mbt/unit/special-sales-items-copy.test.js']);
const browser = run('sales-actions-browser', ['--test', '--test-concurrency=1',
  'test/mbt/integration/special-sales-items-copy-browser.test.js']);
const layouts = JSON.parse(readFileSync(out + '/browser/action-layout.json'));
assert.deepEqual(layouts.map(item => item.width), [1440, 1280, 1024, 390, 360]);
assert.deepEqual(hashes(), sourceHashes);
const result = { completed: true, sourceHashes, unit, browser, newLintFindings: 0,
  layoutWidths: layouts.map(item => item.width), sameRowActions: true, addItemAlignedRight: true,
  centeredWarningAndCancellationPreserved: true, itemAdditionCopyAndSavePreserved: true, mobileNoOverflow: true };
writeFileSync(out + '/checks.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
