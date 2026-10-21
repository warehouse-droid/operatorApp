import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'db');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, 'false');
const mode = process.argv.at(-1);
const out = 'test-artifacts/split-allocation-target-20261020';
const primary = ['test/dispatch/integration/resplit-sibling-group-allocations.test.js'];
const regressions = JSON.parse(readFileSync('tools/split-allocation-target-20261020/regressions.json','utf8'));
mkdirSync(out, { recursive: true });
const files = mode === 'unit-red' ? [primary[0]] : mode === 'baseline' ? regressions : ['red', 'green'].includes(mode) ? primary : [...primary, ...regressions];
const fd = openSync(`${out}/${mode}.log`, 'w');
let result;
try {
  const args = ['--test', '--test-concurrency=1', ...files];
  result = spawnSync(process.execPath, mode === 'final'
    ? ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
      '--include=src/dispatch-sales-resplit-repository.js', '--include=src/dispatch-plan-repository.js',
      '--include=src/dispatch-planner-v2-repository.js', '--include=public/dispatch.js',
      '--include=src/server.js',
      '--temp-directory=/tmp/split-quantity-c8', `--report-dir=${out}/coverage`,
      '--reporter=json', '--reporter=text-summary', process.execPath, ...args] : args,
  { env: process.env, timeout: 600000, stdio: ['ignore', fd, fd] });
} finally { closeSync(fd); }
const log = readFileSync(`${out}/${mode}.log`, 'utf8');
const summary = { mode, exit: result.status, signal: result.signal, files,
  ...Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key, Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)])),
  failures: [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]) };
writeFileSync(`${out}/${mode}.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
if (summary.exit) console.log(log.slice(-4500));
assert.ok(summary.tests > 0 && result.status !== null);
if (mode === 'unit-red') assert.equal(summary.fail, 1);
else if (mode === 'red') assert.equal(summary.fail, 3);
else if (mode === 'baseline') process.exitCode = 0;
else if (mode === 'final') {
  const baseline = JSON.parse(readFileSync(`${out}/baseline.json`, 'utf8'));
  assert.deepEqual([...summary.failures].sort(), [...baseline.failures].sort());
  assert.equal(summary.fail, baseline.fail);
} else assert.equal(summary.exit, 0);
