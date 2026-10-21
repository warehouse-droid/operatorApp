import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isolatedRun } from './dispatch-source-decision-checks.mjs';

const mode = process.argv[2] || 'final';
const core = ['test/dispatch/frontend/dispatch-freshness.browser.test.mjs', 'test/dispatch/integration/dispatch-freshness.test.js',
  'test/dispatch/frontend/dispatch-freshness-races.test.js', 'test/dispatch/unit/dispatch-freshness-server.test.js',
  'test/dispatch/unit/dispatch-freshness-sor.test.js'];
const regression = [
  'test/dispatch/frontend/dispatch-planner-performance.contract.test.js',
  'test/dispatch/frontend/dispatch-save-reliability.test.js',
  'test/dispatch/frontend/dispatch-co-cargo-preservation.test.js',
  'test/dispatch/frontend/dispatch-authoritative-retirement.red.test.js',
  'test/dispatch/frontend/dispatch-link-dialog-stability.browser.test.mjs',
  'test/dispatch/frontend/dispatch-link-base.browser.test.mjs',
  'test/dispatch/frontend/unfinished-sales-resplit.browser.test.mjs',
  'test/dispatch/frontend/dispatch-first-split-group-status.browser.test.mjs',
  'test/dispatch/frontend/dispatch-registered-split-planning.browser.test.mjs',
  'test/dispatch/integration/dispatch-order-catalog.red.test.js',
  'test/dispatch/integration/dispatch-global-derived-order-pool.red.test.js',
  'test/dispatch/integration/unfinished-sales-resplit.test.js',
  'test/dispatch/integration/sales-unsplit.test.js',
  'test/dispatch/integration/dispatch-save-reliability.test.js',
  'test/dispatch/integration/dispatch-po-split-link-target.test.js',
  'test/dispatch/integration/dispatch-link-base.test.js',
  'test/dispatch/unit/dispatch-planner-optimization.red.test.js',
  'test/dispatch/unit/dispatch-co-group-identity.red.test.js',
  'test/dispatch/unit/co-source-group-cleanup.test.js',
  'test/dispatch/unit/sor-rental-policy.test.js',
  'test/dispatch/unit/goa-co-planning.test.js'
];
const only = process.argv.slice(3);
const results = only.length ? JSON.parse(readFileSync(`test-artifacts/${mode}.json`, 'utf8')).results.filter(row => !only.includes(row.file)) : [];
if (mode === 'baseline') process.env.DISPATCH_FRESHNESS_PHASE = 'original';
if (mode === 'final') {
  process.env.DISPATCH_FRESHNESS_COVERAGE = '1';
  process.env.DISPATCH_FRESHNESS_PHASE = 'verified';
  process.env.NODE_V8_COVERAGE = '/app/test-artifacts/v8';
}
for (const file of [...core, ...regression].filter(file => !only.length || only.includes(file)).sort((a, b) => a.localeCompare(b))) {
  const result = await isolatedRun(file, { prefix: `freshness-${mode}` });
  results.push(result); console.log(JSON.stringify(result));
}
const sources = ['public/dispatch.js', 'src/server.js', 'src/dispatch-planner-optimization.js', 'src/dispatch-order-catalog-repository.js', 'src/dispatch-sales-resplit-repository.js', 'src/sor-rental-policy.js'];
for (const file of sources) assert.equal(spawnSync('node', ['--check', file]).status, 0, file);
const lint = spawnSync('node', ['node_modules/eslint/bin/eslint.js', '--config', 'tools/dispatch-save-eslint.config.mjs', '--format', 'json', ...sources], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const diagnostics = JSON.parse(lint.stdout).flatMap(row => row.messages.map(message => ({ file: row.filePath.split('/app/').at(-1), rule: message.ruleId, message: message.message })));
delete process.env.NODE_V8_COVERAGE;
const report = { results, diagnostics, node: process.version };
writeFileSync(`test-artifacts/${mode}.json`, JSON.stringify(report, null, 2));
if (mode === 'final') {
  const baseline = JSON.parse(readFileSync('test-artifacts/baseline.json', 'utf8'));
  for (const result of results) {
    if (core.includes(result.file)) assert.equal(result.exit, 0, result.file);
    else {
      const before = baseline.results.find(row => row.file === result.file);
      assert.deepEqual(result.failures, before.failures, result.file);
      assert.equal(result.exit, before.exit, result.file);
    }
  }
  const diagnosticKey = message => JSON.stringify({ ...message,
    message: message.message.replace(/on line \d+ column \d+/gu, 'at existing declaration') });
  for (const message of diagnostics) assert.ok(baseline.diagnostics.some(old => diagnosticKey(old) === diagnosticKey(message)), `New lint: ${JSON.stringify(message)}`);
}
