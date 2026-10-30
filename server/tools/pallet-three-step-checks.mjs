import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const output = path.resolve('test-artifacts/pallet-three-step');
fs.mkdirSync(output, { recursive: true });
function run(name, args) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 10e6 });
  const log = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(path.join(output, name + '.log'), log);
  assert.ifError(result.error);
  assert.equal(result.status, 0, log.match(/^not ok[^]*?^  \.\.\./gm)?.join('\n') || log.slice(-10000));
  const count = Number(log.match(/# pass (\d+)/)?.[1] || 0);
  console.log(`${name}: passed (${count} tests)`);
  return count;
}
run('syntax', ['--check', 'public/operator.js']);
run('browser-test-lint', ['node_modules/eslint/bin/eslint.js', '--config', 'tools/pallet-one-page-eslint.config.mjs', '--max-warnings=0', 'test/mbt/e2e/pallet-one-page.test.js']);
const tests = run('pallet-flow', ['--test', '--test-force-exit', '--test-timeout=60000', '--test-concurrency=1',
  'test/mbt/e2e/pallet-one-page.test.js', 'test/mbt/unit/return-pallet-optional-plate-ui.test.js',
  'test/mbt/unit/return-pallet-yard-reference.test.js', 'test/mbt/unit/return-notification-ui.test.js']);
const files = JSON.parse(fs.readFileSync('tools/pallet-three-step-files.json', 'utf8'));
const report = { passed: true, tests,
  sourceHashes: Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')])) };
fs.writeFileSync('test-artifacts/pallet-three-step-validation.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
