import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'test/mbt/integration/operator-yard-access.test.js'],
  { encoding: 'utf8', maxBuffer: 20e6 });
const log = (result.stdout || '') + (result.stderr || '');
writeFileSync('test-artifacts/popup-baseline.log', log);
const failures = [...log.matchAll(/^not ok[^\n]*\n[\s\S]*?^  \.\.\.$/gm)].map(match => match[0]);
const errors = log.split('\n').filter(line => /error:|ERROR|does not exist|undefined|ReferenceError|TypeError/.test(line));
console.log('POPUP_BASELINE=' + JSON.stringify({ status: result.status, failures, errors,
  summary: log.split('\n').filter(line => /^# (tests|pass|fail|skipped) /.test(line)) }));
process.exitCode = result.status;
