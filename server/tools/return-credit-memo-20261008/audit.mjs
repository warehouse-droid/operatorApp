import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scanTextForSecrets } from '../../test/support/scan-diff-secrets.mjs';
import { inTaskScope } from './scopes.mjs';
import { run } from './check.mjs';
const out = 'test-artifacts/return-credit-memo-20261008';
const files = JSON.parse(readFileSync('tools/return-credit-memo-20261008/files.json'));
const findings = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  let before = '';
  try { before = readFileSync(out + '/baseline/' + file, 'utf8'); } catch (problem) {
    if (problem.code !== 'ENOENT') { throw problem; }
  }
  const oldLines = new Set(before.split('\n'));
  const added = source.split('\n').filter((line, index) => !oldLines.has(line) && inTaskScope(file, index + 1, source)).join('\n');
  findings.push(...scanTextForSecrets(added, file));
}
assert.deepEqual(findings, []);
const assets = run('asset-tests', ['--test', 'test/mbt/unit/operator-yard-assets.test.js']);
const harnesses = [];
for (const harness of ['operator-return-ui', 'return-portal-ui', 'return-module']) {
  const baseline = run(harness + '-baseline', ['src/' + harness + '-harness.js'], { cwd: resolve(out, 'baseline'), accepted: [0, 1] });
  const current = run(harness + '-regression', ['src/' + harness + '-harness.js'], { accepted: [0, 1] });
  const assertion = log => log.match(/AssertionError \[ERR_ASSERTION\]: ([^\n]+)/)?.[1];
  if (current.exit !== 0) {
    assert.equal(baseline.exit, current.exit);
    assert.ok(assertion(baseline.log), 'Pre-existing failure must be an identified assertion');
    assert.equal(assertion(current.log), assertion(baseline.log));
  }
  harnesses.push({ harness, baselineExit: baseline.exit, finalExit: current.exit,
    preExistingFailure: current.exit ? assertion(current.log) : null });
}
writeFileSync(out + '/audit.json', JSON.stringify({ newSecretFindings: findings.length,
  dependenciesAdded: 0, assetTests: assets.tests, assetTestsPassed: assets.pass,
  harnesses, capabilityReview: 'Uses existing authenticated NetSuite mutation and readback clients; no new credential sources, subprocesses or filesystem access in runtime code.' }, null, 2));
