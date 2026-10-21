import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
const mode = process.argv.at(-1);
const out = 'test-artifacts/control-order-reopen-20261012';
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'db');
const files = ['test/dispatch/unit/operator-progress-message.test.js', 'test/dispatch/integration/control-order-reopen.test.js',
  'test/dispatch/integration/control-order-reopen-local.test.js', 'test/dispatch/integration/control-order-reopen-http.test.js'];
const log = `${out}/${mode}-primary.log`;
const fd = openSync(log, 'w');
let result;
try { result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...(mode === 'red' ? ['--test-name-pattern=Customer Pickup packing|Driver start'] : []), ...files], { stdio: ['ignore', fd, fd], timeout: 240000 }); }
finally { closeSync(fd); }
const output = readFileSync(log, 'utf8');
const summary = { mode, exit: result.status, ...Object.fromEntries(['tests', 'pass', 'fail'].map(key => [key,
  Number(output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)])) };
writeFileSync(`${out}/${mode}-summary.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
if (mode === 'red') { assert.notEqual(result.status, 0); assert.ok(summary.fail > 0); }
else { assert.equal(result.status, 0, output.slice(-4000)); }
