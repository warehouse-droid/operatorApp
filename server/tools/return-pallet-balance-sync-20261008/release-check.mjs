import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { run } from './check.mjs';
const task = 'tools/return-pallet-balance-sync-20261008';
const out = 'test-artifacts/return-pallet-balance-sync-20261008';
const regression = run('deployment-regression', [task + '/check.mjs', 'regression']);
assert.equal(regression.tests, 151);
assert.equal(regression.pass, 151);
assert.equal(regression.fail, 0);
assert.equal(regression.skipped, 0);
const compatibility = run('deployment-compatibility', ['--test',
  'test/mbt/unit/operator-phone-policy.test.js', 'test/mbt/unit/operator-yard-assets.test.js']);
assert.equal(compatibility.tests, 6);
assert.equal(compatibility.pass, 6);
writeFileSync(out + '/deployment-checks.json', JSON.stringify({ passed: true,
  regression: { tests: regression.tests, pass: regression.pass, fail: regression.fail },
  compatibility: { tests: compatibility.tests, pass: compatibility.pass } }, null, 2));
