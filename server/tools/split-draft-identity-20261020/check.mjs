import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'db');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, 'false');
const mode = process.argv.at(-1);
const out = 'test-artifacts';
const identity = ['test/dispatch/frontend/split-draft-identity.test.js',
  'test/dispatch/frontend/split-draft-identity.browser.test.mjs'];
const regression = [
  'test/dispatch/unit/split-quantity-validation.test.js',
  'test/dispatch/frontend/split-quantity-validation.test.js',
  'test/dispatch/frontend/split-quantity-validation.browser.test.mjs',
  'test/dispatch/frontend/split-dialog-fast.browser.test.mjs',
  'test/dispatch/frontend/unfinished-sales-resplit.browser.test.mjs',
  'test/dispatch/unit/unfinished-sales-resplit.test.js',
  'test/dispatch/unit/sales-unsplit.test.js',
  'test/dispatch/integration/split-quantity-validation.test.js',
  'test/dispatch/integration/split-quantity-validation-http.test.js',
  'test/dispatch/integration/unfinished-sales-resplit.test.js',
  'test/dispatch/integration/unfinished-sales-resplit-http.test.js',
  'test/dispatch/integration/sales-unsplit.test.js',
  'test/dispatch/integration/sales-unsplit-http.test.js',
  'test/dispatch/integration/resplit-sibling-group-allocations.test.js',
  'test/dispatch/integration/dispatch-freshness.test.js',
  'test/dispatch/integration/split-dialog-fast.test.js'
];
for (const dir of ['unfinished-split-20261012', 'split-quantity-20261020/browser'])
  mkdirSync(`${out}/${dir}`, { recursive: true });
const files = mode === 'identity-red' ? identity : mode === 'baseline' ? regression : [...identity, ...regression];
if (mode === 'health') files.reverse();
const fd = openSync(`${out}/${mode}.log`, 'w');
let result;
try {
  result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files],
    { env: process.env, timeout: 600000, stdio: ['ignore', fd, fd] });
} finally { closeSync(fd); }
const log = readFileSync(`${out}/${mode}.log`, 'utf8');
const summary = { mode, exit: result.status, signal: result.signal, files,
  ...Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key =>
    [key, Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)])),
  failures: [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]) };
writeFileSync(`${out}/${mode}.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
assert.ok(summary.tests > 0 && result.status !== null);
if (mode === 'identity-red') {
  assert.equal(summary.fail, 5, log.slice(-5000));
  assert.match(log, /nonnegative quantity for every split/u);
} else assert.equal(summary.exit, 0, log.slice(-5000));
