import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'db');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, 'false');
const files = JSON.parse(readFileSync('tools/scm-split-retain-destination-20261015/files.json', 'utf8'));
for (const file of files.filter(file => file.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  assert.equal(result.status, 0);
}
const tests = [
  'test/dispatch/integration/scm-po-split-retain-destination.test.js',
  'test/dispatch/frontend/scm-po-split-retain-destination.browser.test.mjs',
  'test/dispatch/frontend/scm-po-split-ui.test.js',
  'test/dispatch/integration/scm-po-destination-override.test.js',
  'test/dispatch/integration/scm-po-split-editing.test.js',
  'test/dispatch/integration/scm-po-split-schedule-remaining.test.js',
  'test/mbt/integration/scm-po-split-ref-reuse.test.js'
];
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], {
  encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
const summary = { exit: result.status, ...Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key =>
  [key, Number(result.stdout?.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)])),
  hashes: Object.fromEntries([...files, ...tests].map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])) };
writeFileSync('test-artifacts/scm-split-retain-destination-20261015/summary.json', JSON.stringify(summary, null, 2) + '\n');
assert.equal(result.status, 0);
assert.ok(summary.tests > 0 && summary.skipped === 0);
