import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const mode = process.argv.at(-1);
const focused = ['test/dispatch/frontend/edit-group-reliability.browser.test.mjs',
  'test/dispatch/integration/edit-group-reliability.test.js',
  'test/dispatch/frontend/group-hydration-concurrency.test.js'];
const regression = [
  'test/dispatch/frontend/dispatch-freshness-races.test.js',
  'test/dispatch/frontend/order-update-save.test.js',
  'test/dispatch/frontend/sales-order-group-hydration.red.test.js',
  'test/dispatch/frontend/dispatch-planner-performance.contract.test.js',
  'test/dispatch/frontend/dispatch-split-group-name.test.js',
  'test/dispatch/frontend/split-draft-identity.browser.test.mjs',
  'test/dispatch/integration/sales-split-allocation-unsplit.test.js',
  'test/dispatch/integration/resplit-sibling-group-allocations.test.js',
  'test/dispatch/integration/dispatch-global-order-group-pool.red.test.js',
  'test/dispatch/property/dispatch-global-order-group-pool.property.test.js',
  'test/dispatch/integration/dispatch-freshness.test.js'
];
const files = mode === 'api-red' ? [focused[1]] : mode === 'unit-red' ? [focused[2]]
  : mode === 'baseline' ? regression : mode === 'red' ? focused : [...focused, ...regression];
if (mode === 'health') {
  let seed = 20261020;
  for (let i = files.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1); [files[i], files[j]] = [files[j], files[i]];
  }
}
mkdirSync('test-artifacts/coverage-' + mode, { recursive: true });
const fd = openSync(`test-artifacts/${mode}.log`, 'w');
let result;
try {
  const runs = (mode === 'health' ? files.map(file => [file]) : [files]).map(group =>
    spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...group], {
      env: { ...process.env, NODE_V8_COVERAGE: 'test-artifacts/coverage-' + mode },
      timeout: 600000, stdio: ['ignore', fd, fd]
    }));
  result = { status: runs.some(run => run.status === null) ? null : runs.some(run => run.status !== 0) ? 1 : 0 };
} finally { closeSync(fd); }
const log = readFileSync(`test-artifacts/${mode}.log`, 'utf8');
const summary = { mode, exit: result.status, files,
  ...Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key,
    [...log.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))].reduce((sum, match) => sum + Number(match[1]), 0)])),
  failures: [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]) };
writeFileSync(`test-artifacts/${mode}.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
if (mode === 'api-red') assert.equal(summary.fail, 3, log.slice(-5000));
else if (mode === 'red') assert.ok(summary.fail >= 5, log.slice(-6000));
else if (mode === 'unit-red') assert.deepEqual(summary.failures,
  ['an order becoming incomplete during another detail read is hydrated before grouping']);
else if (mode !== 'baseline') {
  const known = 'DP-33 frontend: active CO projection retains every current relationship pickup';
  assert.deepEqual(summary.failures, [known], log.slice(-6000));
  assert.match(log, /activeTransitPickupLocations/);
  assert.equal(summary.pass, summary.tests - 1);
}
