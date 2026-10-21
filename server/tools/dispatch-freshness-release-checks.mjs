import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function run(name, args) {
  const result = spawnSync('node', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240000 });
  writeFileSync(`test-artifacts/${name}.log`, result.stdout + result.stderr);
  assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  console.log(JSON.stringify({ stage: name, passed: true }));
}

run('release-regressions', ['tools/dispatch-freshness-checks.mjs', 'release']);
const result = JSON.parse(readFileSync('test-artifacts/release.json', 'utf8'));
const previous = JSON.parse(readFileSync('/workspace/server/test-artifacts/dispatch-freshness-20261019/results/final.json', 'utf8'));
assert.equal(result.results.length, previous.results.length);
for (const row of result.results) {
  const old = previous.results.find(item => item.file === row.file);
  assert.equal(row.exit, old.exit, row.file);
  assert.deepEqual(row.failures, old.failures, row.file);
}
run('release-full-day', ['--test', 'test/dispatch/frontend/dispatch-full-day.browser.test.mjs']);
