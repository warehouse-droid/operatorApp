import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {regularTests} from './regular-stock-v2-suites.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const legacy = JSON.parse(readFileSync('package.json')).scripts['test:stock-requests'].split(' ').filter(arg => arg.endsWith('.js'));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...new Set([...regularTests, ...legacy])], {encoding: 'utf8', maxBuffer: 40_000_000});
const output = result.stdout + result.stderr;
writeFileSync('test-artifacts/regressions.tap', output);
const summary = {tests: Number(output.match(/^# tests (\d+)/m)?.[1]), passed: Number(output.match(/^# pass (\d+)/m)?.[1]), exitCode: result.status};
writeFileSync('test-artifacts/regressions.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
assert.equal(result.status, 0);
