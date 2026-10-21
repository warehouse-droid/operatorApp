import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-updates-db-20261002');
const service = process.argv[2];
assert.ok(['app', 'webhook-worker'].includes(service));
const out = '/app/test-artifacts/special-workflow-review/stock-updates-20261002';
const runs = service === 'app' ? [['feature-and-browser', [
  'test/mbt/unit/special-stock-updates.test.js', 'test/mbt/unit/special-workflow-documents.test.js',
  'test/mbt/integration/special-stock-updates.test.js', 'test/mbt/integration/special-stock-updates-http.test.js',
  'test/mbt/integration/special-stock-updates-browser.test.js', 'test/mbt/integration/stocking-customer-browser.test.js',
  'test/mbt/integration/scm-special-planned-card-browser.test.js'
]]] : [['availability-and-pending-update', ['test/mbt/integration/special-stock-updates-worker.test.js']],
['domain-regressions', ['test/mbt/unit/special-stock-request-domain.red.test.js', 'test/mbt/unit/special-stock-request-policy.red.test.js']]];
const results = [];
for (const [name, files] of runs) {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { encoding: 'utf8', timeout: 120000, maxBuffer: 5000000 });
  const log = (result.stdout || '') + (result.stderr || '');
  writeFileSync(`${out}/release-${service}-${name}.log`, log);
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key, Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)]));
  console.log(JSON.stringify({ service, name, exitCode: result.status, ...counts }));
  assert.equal(result.status, 0, log.slice(-6000)); results.push({ name, ...counts });
}
const files = service === 'app' ? JSON.parse(readFileSync('tools/special-stock-updates-files.json')).filter(file => !file.startsWith('tools/'))
  : ['public/special-stock-workflow.js', 'src/special-stock-request-domain.js', 'src/special-stock-request-repository.js'];
const hashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync(`${out}/release-${service}-checks.json`, JSON.stringify({ passed: true, source: resolve('.'), sourceHashes: hashes, results }, null, 2));
