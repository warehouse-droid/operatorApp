import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const out = 'test-artifacts/split-allocation-target-20261020';
const final = JSON.parse(readFileSync(`${out}/final.json`, 'utf8'));
const files = [...final.files];
let seed = 20261020;
for (let i = files.length - 1; i > 0; i--) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const j = seed % (i + 1);
  [files[i], files[j]] = [files[j], files[i]];
}
const result = { seed: 20261020, files, tests: 0, pass: 0, fail: 0, skipped: 0, failures: [] };
writeFileSync(`${out}/health.log`, '');
for (const file of files) {
  const child = spawnSync(process.execPath, ['--test', file],
    { encoding: 'utf8', env: process.env, timeout: 120000 });
  assert.equal(child.signal, null);
  const log = (child.stdout || '') + (child.stderr || '');
  appendFileSync(`${out}/health.log`, `\nFILE ${file}\n${log}`);
  for (const key of ['tests', 'pass', 'fail', 'skipped']) {
    result[key] += Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0);
  }
  result.failures.push(...[...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(row => row[1]));
  assert.ok([0, 1].includes(child.status));
}
writeFileSync(`${out}/health.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
assert.equal(result.tests, final.tests);
assert.equal(result.pass, final.pass);
assert.equal(result.fail, final.fail);
assert.equal(result.skipped, final.skipped);
assert.deepEqual(result.failures.sort(), [...final.failures].sort());
