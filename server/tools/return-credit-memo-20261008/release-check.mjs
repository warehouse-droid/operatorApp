import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { run } from './check.mjs';

const task = 'tools/return-credit-memo-20261008';
const out = 'test-artifacts/return-credit-memo-20261008';
const regression = run('deployment-regression', [task + '/check.mjs', 'regression']);
assert.equal(regression.tests, 139);
assert.equal(regression.pass, 139);
assert.equal(regression.fail, 0);
assert.equal(regression.skipped, 0);
const compatibility = run('deployment-compatibility', ['--test',
  'test/mbt/unit/operator-phone-policy.test.js', 'test/mbt/unit/operator-yard-assets.test.js']);
assert.equal(compatibility.tests, 6);
assert.equal(compatibility.pass, 6);
run('deployment-browser', [task + '/browser.mjs']);
for (const file of JSON.parse(readFileSync(task + '/files.json')).filter(name => name.endsWith('.js'))) {
  run('deployment-syntax-' + file.replaceAll('/', '-'), ['--check', file]);
}
writeFileSync(out + '/deployment-checks.json', JSON.stringify({ passed: true,
  regression: { tests: regression.tests, pass: regression.pass, fail: regression.fail },
  compatibility: { tests: compatibility.tests, pass: compatibility.pass },
  browser: JSON.parse(readFileSync(out + '/browser.json')) }, null, 2));
